import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

// #431: the pull request that onboards a repository adds its profile, so the
// base the plan job checks out has none, and every onboarding run was planned
// blind. collect exports the head's profile from git objects, as data, and the
// plan job hands it to `qare plan --pr-profile`, which runs nothing in it.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string | boolean> }
interface Job { outputs?: Record<string, string>; steps: Step[] }
const pipeline = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8')) as { jobs: Record<string, Job> }
const stepOf = (job: string, name: string): Step => {
  const found = pipeline.jobs[job]!.steps.find((candidate) => candidate.name === name)
  expect(found, `${job}: ${name}`).toBeDefined()
  return found!
}
const indexOf = (job: string, name: string): number => pipeline.jobs[job]!.steps.findIndex((candidate) => candidate.name === name)

const CHOOSE = 'Choose the profile the planner reads'
const UPLOAD = "Upload the pull request's profile, as data"
const DOWNLOAD = "Download the pull request's profile, as data"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qare-pipeline-pr-profile-'))
  dirs.push(dir)
  return dir
}
function git(dir: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0)
  return result.stdout.trim()
}
function run(dir: string, source: string, env: Record<string, string>): { status: number | null; output: string; summary: string; stderr: string } {
  const output = join(dir, '.github-output')
  const summary = join(dir, '.github-summary')
  writeFileSync(output, '')
  writeFileSync(summary, '')
  const result = spawnSync('bash', ['-c', source], {
    cwd: dir,
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir, ...env },
    encoding: 'utf8',
  })
  return { status: result.status, output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8'), stderr: result.stderr }
}
function files(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    return entry.isDirectory() ? files(dir, path) : [path]
  }).sort()
}

/** A repository whose base commit has no profile (or one, when asked) and whose head adds one. */
function repository(opts: { baseProfile?: boolean; headProfile?: boolean } = {}): { dir: string; base: string; head: string } {
  const dir = temporary()
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'app.py'), 'print("hi")\n')
  if (opts.baseProfile === true) {
    mkdirSync(join(dir, '.qa'))
    writeFileSync(join(dir, '.qa', 'QA.md'), '# base\n')
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  if (opts.headProfile !== false) {
    mkdirSync(join(dir, '.qa', 'fixtures'), { recursive: true })
    mkdirSync(join(dir, '.qa', 'stubs'), { recursive: true })
    writeFileSync(join(dir, '.qa', 'QA.md'), '# head\n')
    writeFileSync(join(dir, '.qa', 'config.yml'), 'target: {}\n')
    writeFileSync(join(dir, '.qa', 'fixtures', '.gitkeep'), '')
    writeFileSync(join(dir, '.qa', 'stubs', 'seed.sh'), '#!/bin/sh\n', { mode: 0o755 })
    // A link in the profile could name anything on the runner: it is not data.
    symlinkSync('/etc/hosts', join(dir, '.qa', 'hosts'))
  }
  writeFileSync(join(dir, 'app.py'), 'print("hello")\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'head')
  const head = git(dir, 'rev-parse', 'HEAD')
  // The plan job's checkout is the base; collect's worktree is too.
  git(dir, 'checkout', '-q', base)
  return { dir, base, head }
}

test("a base with no profile exports the head's profile as regular files, from git objects, and leaves out links (#431)", () => {
  const { dir, base, head } = repository()
  const result = run(dir, stepOf('collect', CHOOSE).run!, { PROFILE: '.qa', BASE_SHA: base, HEAD_SHA: head })

  expect(result.status, result.stderr).toBe(0)
  expect(result.output).toContain('plan-profile=head')
  expect(files(join(dir, '.qare-pr-profile'))).toEqual(['QA.md', 'config.yml', 'fixtures/.gitkeep', 'stubs/seed.sh'])
  expect(readFileSync(join(dir, '.qare-pr-profile', 'QA.md'), 'utf8')).toBe('# head\n')
  expect(statSync(join(dir, '.qare-pr-profile', 'stubs', 'seed.sh')).isFile()).toBe(true)
  expect(result.summary).toContain("the base revision has no profile at .qa, so the planner reads this pull request's, as data")
  expect(result.summary).toContain('left out 1 entry that is not a regular file')
  // The base checkout is left as it was: nothing is written at the profile's path.
  expect(existsSync(join(dir, '.qa'))).toBe(false)
})

test("a base with a profile plans with it, as before, and exports nothing (#431)", () => {
  const { dir, base, head } = repository({ baseProfile: true })
  const result = run(dir, stepOf('collect', CHOOSE).run!, { PROFILE: '.qa', BASE_SHA: base, HEAD_SHA: head })

  expect(result.status, result.stderr).toBe(0)
  expect(result.output).toContain('plan-profile=base')
  expect(existsSync(join(dir, '.qare-pr-profile'))).toBe(false)
})

test('neither side with a profile plans with none, and says so (#431)', () => {
  const { dir, base, head } = repository({ headProfile: false })
  const result = run(dir, stepOf('collect', CHOOSE).run!, { PROFILE: './.qa/', BASE_SHA: base, HEAD_SHA: head })

  expect(result.status, result.stderr).toBe(0)
  expect(result.output).toContain('plan-profile=none')
  expect(result.summary).toContain('neither the base revision nor this pull request has a profile at .qa')
  expect(existsSync(join(dir, '.qare-pr-profile'))).toBe(false)
})

test('collect chooses after it has the head, publishes the choice, and uploads the export only when it chose the head (#431)', () => {
  const choose = stepOf('collect', CHOOSE)
  expect(choose.id).toBe('plan-profile')
  expect(choose.if).toBe("steps.inputs.outputs.criteria == 'present'")
  expect(indexOf('collect', CHOOSE)).toBeGreaterThan(indexOf('collect', 'Read the linked issue and the diff'))
  // It reads git objects and nothing else: no token, no image, no secret.
  expect(JSON.stringify(choose)).not.toMatch(/secrets\.|GITHUB_TOKEN|GH_TOKEN|docker|github\.token/)
  expect(pipeline.jobs.collect!.outputs?.['plan-profile']).toBe('${{ steps.plan-profile.outputs.plan-profile }}')
  const upload = stepOf('collect', UPLOAD)
  expect(upload.if).toBe("steps.plan-profile.outputs.plan-profile == 'head'")
  expect(upload.with).toMatchObject({ name: 'qa-pr-profile', path: '.qare-pr-profile/', 'include-hidden-files': true, 'if-no-files-found': 'error' })
})

test("the plan job lays the head's profile where the base has none, after the exploration steps, and before the plan (#431)", () => {
  const download = stepOf('plan', DOWNLOAD)
  expect(download.if).toBe("needs.collect.outputs.plan-profile == 'head'")
  expect(download.with).toMatchObject({ name: 'qa-pr-profile', path: '${{ inputs.profile }}' })
  // Exploring boots the base, and reads whether to from the base's profile:
  // the head's arrives only after that is decided.
  expect(indexOf('plan', DOWNLOAD)).toBeGreaterThan(indexOf('plan', 'Serve the base app to the planner'))
  expect(indexOf('plan', DOWNLOAD)).toBeLessThan(indexOf('plan', 'Plan the QA run'))
  expect(stepOf('plan', 'Plan the QA run').env?.PLAN_PROFILE).toBe('${{ needs.collect.outputs.plan-profile }}')
})

/** Run the plan step with a docker stand-in that records its arguments and writes the plan qare would. */
function planStep(planProfile: string, profileSource: string | undefined, extra: Record<string, unknown> = {}): { args: string[]; summary: string; status: number | null; stderr: string } {
  const dir = temporary()
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const plan = JSON.stringify({ schemaVersion: '1', criteria: [], ...(profileSource === undefined ? {} : { profileSource }), ...extra })
  writeFileSync(join(bin, 'docker'), `#!/bin/bash\nprintf '%s\\n' "$@" > "$CALLS"\nprintf '%s' '${plan}' > plan.json\n`, { mode: 0o755 })
  writeFileSync(join(dir, 'change.diff'), '')
  const result = run(dir, stepOf('plan', 'Plan the QA run').run!, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    CALLS: join(dir, 'calls'),
    IMAGE_REF: 'qare-core',
    MODEL_KEY: 'k',
    MODEL_KEY_ENV: 'ANTHROPIC_API_KEY',
    PROFILE: '.qa',
    PLAN_PROFILE: planProfile,
    NARE_PROVIDER: '',
    NARE_MODEL: '',
    NARE_BASE_URL: '',
    NARE_CONTEXT_WINDOW: '',
    NARE_STREAM: '',
    QARE_MAX_OUTPUT_TOKENS: '',
    QARE_PLAN_BATCH_SIZE: '',
    QARE_PLAN_CONCURRENCY: '',
    EXPLORE_ENDPOINT: '',
  })
  return { args: existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : [], summary: result.summary, status: result.status, stderr: result.stderr }
}

test("the plan step hands the head's profile to qare only as --pr-profile, never as --profile (#431)", () => {
  const head = planStep('head', 'pull-request')
  expect(head.status, head.stderr).toBe(0)
  expect(head.args).toContain('--pr-profile')
  expect(head.args[head.args.indexOf('--pr-profile') + 1]).toBe('.qa')
  expect(head.args).not.toContain('--profile')
  expect(head.summary).toContain("planned with this pull request's profile at .qa, read as data, because the base revision has none")

  for (const choice of ['base', '']) {
    const base = planStep(choice, 'checkout')
    expect(base.status, base.stderr).toBe(0)
    expect(base.args[base.args.indexOf('--profile') + 1], choice).toBe('.qa')
    expect(base.args, choice).not.toContain('--pr-profile')
    expect(base.summary, choice).toContain("planned with the base revision's profile at .qa")
  }

  expect(planStep('none', 'none').summary).toContain('planned with no usable profile at .qa')
})

test('a qare image that predates --pr-profile ignores it and plans with no profile, and the summary says what happened (#431)', () => {
  const old = planStep('head', undefined)
  expect(old.status, old.stderr).toBe(0)
  expect(old.summary).toContain("the pinned qare does not record which profile it planned with, so this pull request's profile may not have reached the planner")
})

test('the plan step summary says when exploration did not run because the base has no profile, and only then (#413)', () => {
  const skipped = planStep('head', 'pull-request', { exploreSkipped: true })
  expect(skipped.status, skipped.stderr).toBe(0)
  expect(skipped.summary).toContain('exploration did not run: the profile says explore: base, but the base revision has no profile')
  expect(skipped.summary).toContain('it starts with the first pull request after the profile lands on the base')
  expect(planStep('base', 'checkout').summary).not.toContain('exploration did not run')
})
