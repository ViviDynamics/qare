import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

// The flake policy and quarantine store of #380, run: the execute steps'
// own scripts, with docker and git stubbed, so what they hand qare run and
// where the store comes from are read from what they did. These need the
// bash a runner has (mapfile), as the other step tests do.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
interface Step { name?: string; run?: string }
const pipeline = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const BASE_STORE = '{"schemaVersion":"1","records":[{"from":"base"}]}\n'
const HEAD_STORE = '{"schemaVersion":"1","records":[{"from":"head"}]}\n'
const MAIN_STORE = '{"schemaVersion":"1","records":[{"from":"main"}]}\n'
const STALE_STORE = '{"schemaVersion":"1","records":[{"from":"an earlier job"}]}\n'

function runStep(job: 'execute' | 'main_execute', env: Record<string, string>, opts: { baseStore?: boolean; staleStore?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qare-defaults-'))
  dirs.push(dir)
  // A store an earlier job left on a runner that outlived it.
  if (opts.staleStore === true) {
    mkdirSync(join(dir, 'qare-quarantine'), { recursive: true })
    writeFileSync(join(dir, 'qare-quarantine', 'quarantine.json'), STALE_STORE)
  }
  const seed = opts.baseStore === false ? '' : `mkdir -p "$4/.qa"; printf '%s' '${BASE_STORE.trim()}' > "$4/.qa/quarantine.json"; `
  const calls = join(dir, 'calls')
  writeFileSync(join(dir, 'qare-docker-access'), '')
  // docker records its arguments and writes the evidence a run would.
  writeFileSync(join(dir, 'docker'), '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$CALLS"\nmkdir -p evidence\nprintf \'{"verdict":"passed","criteria":[]}\' > evidence/result.json\n', { mode: 0o755 })
  // git checks out a base tree that carries its own store.
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/bash\nif [ "$1" = worktree ]; then mkdir -p "$4"; ${seed}fi\nexit 0\n`,
    { mode: 0o755 },
  )
  // The checked-out tree's own store: the pull request's in execute, main's in main_execute.
  mkdirSync(join(dir, '.qa'), { recursive: true })
  writeFileSync(join(dir, '.qa', 'quarantine.json'), job === 'execute' ? HEAD_STORE : MAIN_STORE)
  const step = pipeline.jobs[job]!.steps.find((candidate) => candidate.name?.startsWith('Run the plan'))!
  const result = spawnSync('bash', ['-c', step.run!], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`, CALLS: calls, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      IMAGE_REF: 'image', IMAGE_DIGEST: 'image', IMAGE_TAG_REF: 'tag', BASE_SHA: 'a'.repeat(40), HEAD_SHA: 'b'.repeat(40),
      PR_NUMBER: '1', PROFILE: '.qa', RUN_ID: '1', RUN_ATTEMPT: '1',
      ...env,
    },
  })
  const args = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n') : []
  return { dir, result, args }
}

function after(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

test('a pull request run gets one retry and the base revision\'s quarantine, not the pull request\'s', () => {
  const { dir, result, args } = runStep('execute', { FLAKE_ATTEMPTS: '2', QUARANTINE: '.qa' })
  expect(result.status, result.stderr).toBe(0)
  expect(after(args, '--flake-attempts')).toBe('2')
  const store = after(args, '--quarantine')
  expect(store).toBe(join(dir, 'qare-quarantine'))
  // The store is mounted into the run's container at its own path.
  expect(args).toContain(`${store}:${store}`)
  // What the run read was the base's store, and that is what goes up with the evidence.
  expect(readFileSync(join(dir, 'evidence', 'quarantine.json'), 'utf8').trim()).toBe(BASE_STORE.trim())
  // The pull request's own store is left as it was, and never read.
  expect(readFileSync(join(dir, '.qa', 'quarantine.json'), 'utf8')).toBe(HEAD_STORE)
})

test('a store an earlier job left on the runner is never read', () => {
  // The base carries no store, so the run starts from an empty one, not the stale one.
  const { dir, result } = runStep('execute', { FLAKE_ATTEMPTS: '2', QUARANTINE: '.qa' }, { baseStore: false, staleStore: true })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(dir, 'qare-quarantine', 'quarantine.json'))).toBe(false)
  expect(existsSync(join(dir, 'evidence', 'quarantine.json'))).toBe(false)
})

test('the main lane reads the default branch\'s own store', () => {
  const { dir, result, args } = runStep('main_execute', { FLAKE_ATTEMPTS: '2', QUARANTINE: '.qa' })
  expect(result.status, result.stderr).toBe(0)
  expect(after(args, '--flake-attempts')).toBe('2')
  expect(after(args, '--quarantine')).toBe(join(dir, 'qare-quarantine'))
  expect(readFileSync(join(dir, 'evidence', 'quarantine.json'), 'utf8')).toBe(MAIN_STORE)
})

for (const job of ['execute', 'main_execute'] as const) {
  test(`${job}: an empty quarantine input turns the store off, and one attempt turns retries off`, () => {
    const { dir, result, args } = runStep(job, { FLAKE_ATTEMPTS: '1', QUARANTINE: '' })
    expect(result.status, result.stderr).toBe(0)
    expect(after(args, '--flake-attempts')).toBe('1')
    expect(args).not.toContain('--quarantine')
    expect(existsSync(join(dir, 'evidence', 'quarantine.json'))).toBe(false)
  })

  test(`${job}: a flake-attempts that is not a whole number, or a store outside the repository, stops before the run`, () => {
    for (const env of [
      { FLAKE_ATTEMPTS: '0', QUARANTINE: '.qa' },
      { FLAKE_ATTEMPTS: 'two', QUARANTINE: '.qa' },
      { FLAKE_ATTEMPTS: '', QUARANTINE: '.qa' },
      { FLAKE_ATTEMPTS: '2', QUARANTINE: '/etc' },
      { FLAKE_ATTEMPTS: '2', QUARANTINE: '../elsewhere' },
      { FLAKE_ATTEMPTS: '2', QUARANTINE: '.qa/../..' },
    ]) {
      const { result, args } = runStep(job, env)
      expect(result.status, JSON.stringify(env)).toBe(1)
      expect(result.stdout, JSON.stringify(env)).toContain('::error::')
      expect(args, JSON.stringify(env)).toEqual([])
    }
  })
}
