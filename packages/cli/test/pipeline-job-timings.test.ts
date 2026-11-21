import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

// #381: each job's wall clock rides the run's metrics record to qa-assets,
// so the standing report can say what a change did to the run time. The
// publish step's own script runs here, with curl stubbed to answer as the
// Actions API does.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
interface Step { name?: string; run?: string; env?: Record<string, string> }
interface Job { permissions?: Record<string, string>; steps: Step[] }
const pipeline = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8')) as { jobs: Record<string, Job> }
const STEP = "Add each job's wall clock to the run's metrics"
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const API = {
  total_count: 6,
  jobs: [
    { name: 'qare / collect (GitHub token only)', status: 'completed', conclusion: 'success', started_at: '2026-11-21T10:00:00Z', completed_at: '2026-11-21T10:00:24Z' },
    { name: 'qare / plan (model key only)', status: 'completed', conclusion: 'success', started_at: '2026-11-21T10:00:30Z', completed_at: '2026-11-21T10:01:10Z' },
    { name: 'qare / execute (no secrets)', status: 'completed', conclusion: 'failure', started_at: '2026-11-21T10:01:15Z', completed_at: '2026-11-21T10:02:06Z' },
    { name: 'qare / judge (model key only)', status: 'completed', conclusion: 'success', started_at: '2026-11-21T10:02:10Z', completed_at: '2026-11-21T10:02:51Z' },
    { name: 'qare / requeue (GitHub token only)', status: 'completed', conclusion: 'skipped', started_at: '2026-11-21T10:00:00Z', completed_at: '2026-11-21T10:00:00Z' },
    { name: 'qare / publish (GitHub token only)', status: 'in_progress', conclusion: null, started_at: '2026-11-21T10:02:55Z', completed_at: null },
  ],
}

function publishStep(): Step {
  const step = pipeline.jobs.publish!.steps.find((candidate) => candidate.name === STEP)
  expect(step, `publish has a step named ${STEP}`).toBeDefined()
  return step!
}

function runStep(opts: { answer?: unknown; curlFails?: boolean; record?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qare-job-timings-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'judged'))
  if (opts.record !== false) writeFileSync(join(dir, 'judged', 'metrics.json'), JSON.stringify({ schemaVersion: 'qare.metrics.v1', runId: 'pr-7', verdict: 'passed' }))
  writeFileSync(join(dir, 'answer.json'), JSON.stringify(opts.answer ?? API))
  writeFileSync(
    join(dir, 'curl'),
    opts.curlFails === true ? '#!/bin/bash\nprintf "%s\\n" "$@" > "$CALLS"\nexit 22\n' : '#!/bin/bash\nprintf "%s\\n" "$@" > "$CALLS"\ncat "$ANSWER"\n',
    { mode: 0o755 },
  )
  const calls = join(dir, 'calls')
  const result = spawnSync('bash', ['-c', publishStep().run!], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`, CALLS: calls, ANSWER: join(dir, 'answer.json'),
      GH_TOKEN: 'token', GITHUB_API_URL: 'api.github.test', GITHUB_REPOSITORY: 'acme/app', RUN_ID: '42', RUN_ATTEMPT: '3',
      RUNNER_TEMP: dir,
    },
  })
  const record = existsSync(join(dir, 'judged', 'metrics.json')) ? (JSON.parse(readFileSync(join(dir, 'judged', 'metrics.json'), 'utf8')) as Record<string, unknown>) : undefined
  return { result, record, calls: existsSync(calls) ? readFileSync(calls, 'utf8').split('\n') : [] }
}

test('publish adds each completed job of this run attempt, by its own name, to the metrics record (#381)', () => {
  const { result, record, calls } = runStep()
  expect(result.status, result.stderr).toBe(0)
  expect(calls).toContain('api.github.test/repos/acme/app/actions/runs/42/attempts/3/jobs?per_page=100')
  // The record keeps what judge wrote.
  expect(record).toMatchObject({ schemaVersion: 'qare.metrics.v1', runId: 'pr-7', verdict: 'passed' })
  // A skipped job ran nothing, and publish is still running: neither is a wall clock.
  expect(record?.jobs).toEqual([
    { name: 'collect (GitHub token only)', startedAt: '2026-11-21T10:00:00Z', completedAt: '2026-11-21T10:00:24Z', wallMs: 24_000 },
    { name: 'plan (model key only)', startedAt: '2026-11-21T10:00:30Z', completedAt: '2026-11-21T10:01:10Z', wallMs: 40_000 },
    { name: 'execute (no secrets)', startedAt: '2026-11-21T10:01:15Z', completedAt: '2026-11-21T10:02:06Z', wallMs: 51_000 },
    { name: 'judge (model key only)', startedAt: '2026-11-21T10:02:10Z', completedAt: '2026-11-21T10:02:51Z', wallMs: 41_000 },
  ])
})

test('the token travels in a header read from standard input, never on the command line (#381)', () => {
  const { calls } = runStep()
  expect(calls.join('\n')).not.toContain('token')
  expect(publishStep().env?.GH_TOKEN).toBe('${{ github.token }}')
  expect(publishStep().env?.RUN_ID).toBe('${{ github.run_id }}')
  expect(publishStep().env?.RUN_ATTEMPT).toBe('${{ github.run_attempt }}')
})

test('jobs that cannot be read leave the record as judge wrote it, with a warning, and never fail publish (#381)', () => {
  for (const opts of [{ curlFails: true }, { answer: 'not the jobs' }, { answer: { jobs: [{ name: 'x', status: 'completed', started_at: 'yesterday', completed_at: 'today' }] } }]) {
    const { result, record } = runStep(opts)
    expect(result.status, JSON.stringify(opts)).toBe(0)
    expect(result.stdout, JSON.stringify(opts)).toContain('::warning::')
    expect(record, JSON.stringify(opts)).toEqual({ schemaVersion: 'qare.metrics.v1', runId: 'pr-7', verdict: 'passed' })
  }
})

test('with no metrics record there is nothing to add the jobs to, and the API is not asked (#381)', () => {
  const { result, record, calls } = runStep({ record: false })
  expect(result.status).toBe(0)
  expect(record).toBeUndefined()
  expect(calls).toEqual([])
})

test('publish reads the run\'s jobs with actions: read, before post-evidence pushes the record (#381)', () => {
  const publish = pipeline.jobs.publish!
  expect(publish.permissions?.actions).toBe('read')
  const names = publish.steps.map((step) => step.name)
  const post = publish.steps.findIndex((step) => /post-evidence/.test(step.run ?? ''))
  expect(names.indexOf(STEP)).toBeGreaterThan(names.indexOf('Download judge-artifacts'))
  expect(names.indexOf(STEP)).toBeLessThan(post)
})
