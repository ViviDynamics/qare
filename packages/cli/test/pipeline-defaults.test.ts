import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'

// The defaults a real repository needs from the pipeline (#380): one retry
// for a flaky check with its quarantine, lockfiles and generated paths kept
// out of the planner's diff, and an opt-in to a blocked verdict failing the
// check run. These read pipeline.yml as text and as YAML, and run no bash,
// so they hold on any machine.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'pipeline.yml'), 'utf8')
const lines = workflow.split('\n')
const docs = readFileSync(join(repoRoot, 'docs', 'pipeline.md'), 'utf8')

interface Input {
  type: string
  default?: string
  description: string
}
const inputs = (parse(workflow) as { on: { workflow_call: { inputs: Record<string, Input> } } }).on.workflow_call.inputs

function section(job: string): string {
  const start = lines.indexOf(`  ${job}:`)
  expect(start, `job ${job} is not declared`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, index) => index > start && /^  \w+:$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** One step of a job, from its `- name:` line to the next step. */
function step(job: string, name: string): string {
  const text = section(job)
  const start = text.indexOf(`- name: ${name}\n`)
  expect(start, `${job} has no step named ${name}`).toBeGreaterThan(-1)
  const next = text.indexOf('\n      - ', start + 1)
  return text.slice(start, next === -1 ? undefined : next)
}

/** The default planner exclusions, as the collect step spells them. */
function defaultExcludes(): string[] {
  const collect = section('collect')
  const match = /default_excludes=\(\n([\s\S]*?)\n\s*\)/.exec(collect)
  expect(match, 'collect declares no default_excludes list').not.toBeNull()
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((found) => found[1] as string)
}

test('the new inputs are declared with the defaults the issue asks for', () => {
  expect(inputs['flake-attempts']?.default).toBe('2')
  expect(inputs.quarantine?.default).toBe('.qa')
  expect(inputs['planner-diff-default-exclude']?.default).toBe('true')
  expect(inputs['blocked-check']?.default).toBe('neutral')
  // The caller's own exclusions stay what they were: empty unless named.
  expect(inputs['planner-diff-exclude']?.default).toBe('')
})

test('collect applies the default exclusions on top of the caller\'s, unless turned off', () => {
  const collect = section('collect')
  expect(collect).toContain('PLANNER_DIFF_DEFAULT_EXCLUDE: ${{ inputs.planner-diff-default-exclude }}')
  expect(collect).toContain('if [ "${PLANNER_DIFF_DEFAULT_EXCLUDE:-}" != "false" ]; then')
  expect(collect).toContain('for pattern in "${default_excludes[@]}" "${patterns[@]}"; do')
  // The record the evidence comment reads travels with the QA inputs.
  expect(collect).toContain('> planner-diff-excluded.json')
  expect(step('collect', 'Upload the QA inputs')).toContain('planner-diff-excluded.json')
})

test('the default exclusions leave out lockfiles and generated paths at any depth, and keep source', () => {
  const patterns = defaultExcludes()
  expect(patterns.length).toBeGreaterThan(0)
  const dir = mkdtempSync(join(tmpdir(), 'qare-exclude-'))
  try {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base')
    const excluded = [
      'pnpm-lock.yaml',
      'apps/web/package-lock.json',
      'yarn.lock',
      'Cargo.lock',
      'go.sum',
      'services/api/poetry.lock',
      'Gemfile.lock',
      'public/app.min.js',
      'public/app.min.css',
      'public/app.js.map',
      'dist/index.js',
      'packages/core/dist/index.js',
      'node_modules/left-pad/index.js',
    ]
    const kept = ['src/app.ts', 'packages/core/src/lockfile.ts', 'docs/dist-notes.md', 'package.json']
    for (const path of [...excluded, ...kept]) {
      mkdirSync(join(dir, dirname(path)), { recursive: true })
      writeFileSync(join(dir, path), 'x\n')
    }
    git('add', '-A', '-f')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'head')
    const planner = git('diff', '--name-only', 'HEAD~1...HEAD', '--', '.', ...patterns.map((pattern) => `:(exclude)${pattern}`))
      .split('\n')
      .filter((line) => line !== '')
      .sort()
    expect(planner).toEqual([...kept].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('execute and main_execute pass the flake attempts and a quarantine store to qare run', () => {
  for (const [job, name] of [['execute', 'Run the plan'], ['main_execute', 'Run the plan on main']] as const) {
    const run = step(job, name)
    expect(run, job).toContain('FLAKE_ATTEMPTS: ${{ inputs.flake-attempts }}')
    expect(run, job).toContain('QUARANTINE: ${{ inputs.quarantine }}')
    // A value that is not a whole number of attempts stops the run by name.
    expect(run, job).toContain('if ! [[ "${FLAKE_ATTEMPTS:-}" =~ ^[1-9][0-9]*$ ]]; then')
    expect(run, job).toContain('--flake-attempts "$FLAKE_ATTEMPTS"')
    expect(run, job).toContain('"${quarantine_args[@]}"')
    expect(run, job).toContain('quarantine_args=(--quarantine "$quarantine_dir")')
    // The store lives outside the checkout, mounted at its own path.
    expect(run, job).toContain('quarantine_dir="$RUNNER_TEMP/qare-quarantine"')
    expect(run, job).toContain('-v "$quarantine_dir:$quarantine_dir"')
    // A path that climbs out of the repository is refused.
    expect(run, job).toMatch(/case "\$QUARANTINE" in\n\s+\/\*\|\.\.\|\.\.\/\*\|\*\/\.\.\|\*\/\.\.\/\*\)/)
    // The store the run wrote is uploaded with the evidence, for a person to commit.
    expect(run, job).toContain('cp "$quarantine_dir/quarantine.json" evidence/quarantine.json')
    // Turning quarantine off is an empty input, and nothing else.
    expect(run, job).toContain('if [ -n "${QUARANTINE:-}" ]; then')
  }
})

test('a pull request run reads the base revision\'s quarantine, never the pull request\'s', () => {
  const run = step('execute', 'Run the plan')
  expect(run).toContain('"$base_dir/$QUARANTINE/quarantine.json"')
  expect(run).not.toContain('"$PWD/$QUARANTINE/quarantine.json"')
  // The base is checked out before the store is seeded from it.
  expect(run.indexOf('git worktree add --detach "$base_dir" "$BASE_SHA"')).toBeLessThan(run.indexOf('"$base_dir/$QUARANTINE/quarantine.json"'))
  // main is the reviewed default branch: its own copy is the store.
  expect(step('main_execute', 'Run the plan on main')).toContain('"$PWD/$QUARANTINE/quarantine.json"')
})

test('publish posts the exclusion record and the blocked conclusion the caller chose', () => {
  const publish = section('publish')
  expect(publish).toMatch(/name: qa-inputs\n\s+path: qa-inputs/)
  const post = step('publish', 'Post the evidence on the pull request')
  expect(post).toContain('BLOCKED_CHECK: ${{ inputs.blocked-check }}')
  expect(post).toContain('excluded=(--planner-diff-excluded qa-inputs/planner-diff-excluded.json)')
  expect(post).toContain('blocked=(--blocked-conclusion failure)')
  expect(post).toContain('"${excluded[@]}" "${blocked[@]}"')
  // A value that is neither stops the post by name: a typo never gates nothing.
  expect(post).toMatch(/\*\) echo "::error::blocked-check is neutral or failure/)
  // An image too old to know the flag would ignore it: the opt-in fails closed.
  expect(post).toContain('-q blocked-conclusion /opt/qare/lib/packages/action/dist/index.js')
  // Neutral stays the default: nothing is passed for it.
  expect(post).toMatch(/neutral\|''\) ;;/)
})

test('no new input moves a secret into a job that did not hold one', () => {
  for (const job of ['execute', 'main_execute']) expect(section(job), job).not.toContain('secrets.')
  for (const job of ['collect', 'publish']) expect(section(job), job).not.toMatch(/secrets\.model-key/)
})

test('docs/pipeline.md documents each new default and how to turn it off', () => {
  for (const name of ['flake-attempts', 'quarantine', 'planner-diff-default-exclude', 'blocked-check'])
    expect(docs, name).toContain(`| \`${name}\` |`)
  const start = docs.indexOf('## Defaults for real repositories')
  expect(start, 'docs/pipeline.md has no "Defaults for real repositories" section').toBeGreaterThan(-1)
  const end = docs.indexOf('\n## ', start + 1)
  const text = docs.slice(start, end === -1 ? undefined : end)
  expect(text).toContain("flake-attempts: '1'")
  expect(text).toContain("quarantine: ''")
  expect(text).toContain("planner-diff-default-exclude: 'false'")
  expect(text).toContain("blocked-check: failure")
  // Every default exclusion is named where the caller reads it.
  for (const pattern of defaultExcludes()) expect(text, pattern).toContain(`\`${pattern}\``)
  // The claim that matters most: a retry is never a pass.
  expect(text).toMatch(/never (reported )?proven/)
})
