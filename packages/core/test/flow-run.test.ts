import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  JobValidationError,
  loadJobFromText,
  runJob,
  type FlowPage,
  type FlowTrace,
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
  stubs: [],
  visual: { widths: [1440], themes: ['light'] },
  suites: [{ name: 'browser-e2e', command: 'echo suite-ok', kind: 'flow' }],
}

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

// A 1x1 transparent PNG: screenshots the fake page takes are real images, so
// the published evidence stays inspectable.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

interface FakeSession {
  page: FlowPage
  trace: FlowTrace
  dispose: () => Promise<void>
  events: string[]
}

function fakeSessionFactory(events: string[], opts: { assertFails?: Error } = {}) {
  const sessions: FakeSession[] = []
  const factory = async (): Promise<FakeSession> => {
    const page: FlowPage = {
      open: async (url) => events.push(`open ${url}`),
      click: async () => events.push('click'),
      type: async () => events.push('type'),
      assertText: async (text) => {
        events.push(`assert ${text}`)
        if (opts.assertFails) throw opts.assertFails
      },
      screenshot: async (path) => {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path, PNG_1X1)
        events.push(`screenshot ${path}`)
      },
    }
    const trace: FlowTrace = {
      start: async () => {
        events.push('trace start')
        return 'trace-1'
      },
      stop: async (path) => events.push(`trace stop ${path}`),
    }
    const session: FakeSession = {
      page,
      trace,
      dispose: async () => events.push('dispose'),
      events,
    }
    sessions.push(session)
    return session
  }
  return { factory, sessions }
}

async function makeJob(fields: {
  criteria: JobCriterion[]
  profile: JobProfileRef
}): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-flow-run-'))
  return {
    id: 'job-flow-run',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: fields.profile,
    criteria: fields.criteria,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

function flowCriterion(...checks: JobCriterion['checks']): JobCriterion[] {
  return [{ id: 'criterion-1', text: 'the ledger exports', checks: checks as NonNullable<JobCriterion['checks']> }]
}

test('an actions flow that proves its criterion publishes the log, the final screenshot and the trace', async () => {
  const events: string[] = []
  const { factory } = fakeSessionFactory(events)
  const job = await makeJob({
    criteria: flowCriterion({
      kind: 'flow',
      actions: [
        { action: 'open', url: HEALTH_URL },
        { action: 'assert', text: 'Welcome' },
      ],
    }),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: factory })

  expect(result.verdict).toBe('passed')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'proven',
      evidence: ['checks/criterion-1/0/actions.log', 'checks/criterion-1/0/final.png'],
    },
  ])
  expect(events).toEqual([
    'trace start',
    `open ${HEALTH_URL}`,
    'assert Welcome',
    `screenshot ${join(job.evidenceDir, 'checks', 'criterion-1', '0', 'final.png')}`,
    `trace stop ${join(job.repoPath, 'traces', 'checks', 'criterion-1', '0', 'trace.zip')}`,
    'dispose',
  ])
  expect(existsSync(join(job.repoPath, 'traces', 'checks', 'criterion-1', '0', 'trace.zip'))).toBe(false)
  // The trace is a zip and redaction cannot read one (#52): it lives outside
  // the published evidence, while the action log and screenshot are published.
  expect(existsSync(join(job.evidenceDir, 'traces'))).toBe(false)
  expect(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'actions.log'), 'utf8')).toMatch(/assert text "Welcome" is visible/)
  expect(existsSync(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'final.png'))).toBe(true)
})

test('a failed assert fails its criterion, with the failure screenshot as evidence', async () => {
  const events: string[] = []
  const { factory } = fakeSessionFactory(events, { assertFails: new Error('text absent') })
  const job = await makeJob({
    criteria: flowCriterion({ kind: 'flow', actions: [{ action: 'assert', text: 'Welcome' }] }),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: factory })

  expect(result.verdict).toBe('failed')
  expect(result.criteria[0].outcome).toBe('failed')
  expect(result.criteria[0].evidence).toEqual([
    'checks/criterion-1/0/actions.log',
    'checks/criterion-1/0/failure.png',
  ])
  expect(existsSync(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'failure.png'))).toBe(true)
})

test('a flow backend that will not start is unverified, never failed', async () => {
  const factory = async (): Promise<never> => {
    throw new Error('playwright-core is not installed')
  }
  const job = await makeJob({
    criteria: flowCriterion({ kind: 'flow', actions: [{ action: 'open', url: HEALTH_URL }] }),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: factory })

  // The judge blocks a run whose only criterion is unverified: an outcome and
  // not a pass, but also not a failure of the change.
  expect(result.verdict).toBe('blocked')
  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toContain('flow backend did not start')
})

test('a suite flow runs the suite command and records the outcome in suite.txt', async () => {
  const events: string[] = []
  const { factory } = fakeSessionFactory(events)
  const job = await makeJob({
    criteria: flowCriterion({ kind: 'flow', suite: 'browser-e2e' }),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: factory })

  expect(result.verdict).toBe('passed')
  expect(result.criteria[0].evidence).toEqual(['checks/criterion-1/0/suite.txt'])
  const suiteText = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'suite.txt'), 'utf8')
  expect(JSON.parse(suiteText)).toMatchObject({ suite: 'browser-e2e', outcome: 'passed' })
})

test('a suite flow whose suite is not in the profile is unverified with a named reason', async () => {
  const events: string[] = []
  const { factory } = fakeSessionFactory(events)
  const job = await makeJob({
    criteria: flowCriterion({ kind: 'flow', suite: 'not-declared' }),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: factory })

  expect(result.verdict).toBe('blocked')
  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toContain('not-declared')
})

test('a flow check with neither suite nor actions fails closed when the job loads', () => {
  const text = `
id: job-flow
repoPath: .
baseRef: main
headRef: HEAD
profile: { inline: {} }
evidenceDir: evidence
criteria:
  - id: c1
    text: x
    checks:
      - kind: flow
`
  expect(() => loadJobFromText(text)).toThrow(JobValidationError)
  try {
    loadJobFromText(text)
  } catch (error) {
    expect((error as JobValidationError).message).toContain('suite')
  }
})

test('a flow check carrying both suite and actions fails closed', () => {
  const text = `
id: job-flow
repoPath: .
baseRef: main
headRef: HEAD
profile: { inline: {} }
evidenceDir: evidence
criteria:
  - id: c1
    text: x
    checks:
      - kind: flow
        suite: e2e
        actions:
          - action: open
            url: ${HEALTH_URL}
`
  expect(() => loadJobFromText(text)).toThrow(JobValidationError)
})

test('a job whose flow actions are free-form strings fails closed', () => {
  const text = `
id: job-flow
repoPath: .
baseRef: main
headRef: HEAD
profile: { inline: {} }
evidenceDir: evidence
criteria:
  - id: c1
    text: x
    checks:
      - kind: flow
        actions:
          - open the ledger
`
  expect(() => loadJobFromText(text)).toThrow(JobValidationError)
})
