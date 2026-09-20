import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  JobValidationError,
  loadJobFromText,
  loadResult,
  runJob,
  type Job,
  type JobCriterion,
  type JobProfileRef,
  type QaProfile,
} from '../src/index.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const INLINE_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/rails db:seed:qa' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [
    {
      service: 'billing',
      hosts: ['api.billing-vendor.example'],
      provided_by: { compose_service: 'billing-stub' },
    },
    {
      service: 'mail',
      hosts: ['api.mailgun.net'],
      provided_by: { compose_service: 'mailpit' },
    },
  ],
  visual: { widths: [1440, 390], themes: ['light', 'dark'] },
  suites: [{ name: 'browser-e2e', command: 'npm --prefix e2e test', kind: 'flow' }],
}

const fixtureDir = new URL('../fixtures/qa-valid/.qa', import.meta.url)

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

async function makeJob(fields: { criteria: JobCriterion[]; profile: JobProfileRef }): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-run-'))
  return {
    id: 'job-run-smoke',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: fields.profile,
    criteria: fields.criteria,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

function commandCriteria(...runs: string[]): JobCriterion[] {
  return runs.map((run, index) => ({
    id: `criterion-${index + 1}`,
    text: `criterion ${index + 1}`,
    checks: [{ kind: 'command', run }],
  }))
}

function jobError(run: () => unknown): JobValidationError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(JobValidationError)
    return error as JobValidationError
  }
  throw new Error('expected the loader to throw JobValidationError')
}

test('a passing job proves both command criteria and writes loadable evidence', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo ok', 'echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  expect(result.schemaVersion).toBe('1')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'proven',
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt'],
    },
    {
      id: 'criterion-2',
      outcome: 'proven',
      evidence: ['checks/criterion-2/0/stdout.txt', 'checks/criterion-2/0/stderr.txt'],
    },
  ])
  for (const criterion of result.criteria) {
    if (criterion.outcome === 'proven') {
      for (const path of criterion.evidence) {
        expect(existsSync(join(job.evidenceDir, path)), path).toBe(true)
      }
    }
  }
  expect(
    await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'stdout.txt'), 'utf8'),
  ).toBe('ok\n')

  const written = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(written).toEqual(result)
  expect(written.job).toEqual({ id: 'job-run-smoke' })
})

test('a failing command fails its criterion and the run', async () => {
  const job = await makeJob({
    criteria: commandCriteria('false'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('failed')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'failed',
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt'],
    },
  ])
})

test('a job with a profile path boots through the injected compose and proves its criterion', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { path: fixtureDir.pathname },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'proven',
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt'],
    },
  ])
})

test('a blocked boot marks every criterion unverified and the run blocked', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo ok', 'echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, {
    runCompose: async () => ({ code: 1, stdout: '', stderr: 'compose boom' }),
  })

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toEqual([
    { id: 'criterion-1', outcome: 'unverified', reason: 'compose up exited 1' },
    { id: 'criterion-2', outcome: 'unverified', reason: 'compose up exited 1' },
  ])
})

test('a criterion with zero checks stays unverified pending planning', async () => {
  const job = await makeJob({
    criteria: [{ id: 'planned-later', text: 'planned by the agent later', checks: [] }],
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toEqual([
    {
      id: 'planned-later',
      outcome: 'unverified',
      reason: 'no checks: model planning lands when nare integration ships',
    },
  ])
})

test('a check that outlives its timeoutMs times out to unverified', async () => {
  const job = await makeJob({
    criteria: [
      {
        id: 'slow-check',
        text: 'sleeps past the deadline',
        checks: [{ kind: 'command', run: 'sleep 2', timeoutMs: 50 }],
      },
    ],
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toEqual([
    { id: 'slow-check', outcome: 'unverified', reason: 'check timed out after 50ms' },
  ])
})

test('duplicate criterion ids fail job loading', () => {
  const text = [
    'id: job-dup',
    'repoPath: .',
    'baseRef: main',
    'headRef: HEAD~1',
    'profile: { path: .qa }',
    'criteria:',
    '  - { id: same, text: one }',
    '  - { id: same, text: two }',
    'evidenceDir: evidence',
    'post: none',
  ].join('\n')

  const error = jobError(() => loadJobFromText(text))

  expect(error.name).toBe('JobValidationError')
  expect(error.field).toBe('criteria')
  expect(error.message).toContain('duplicate criterion id "same"')
})
