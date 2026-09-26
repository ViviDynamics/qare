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
  type MailMessage,
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

test('the profile masks reach the action log of the screenshots they applied to (#119)', async () => {
  const events: string[] = []
  const { factory } = fakeSessionFactory(events)
  let receivedMasks: string[] | undefined
  const job = await makeJob({
    criteria: flowCriterion({
      kind: 'flow',
      actions: [
        { action: 'open', url: HEALTH_URL },
        { action: 'assert', text: 'Welcome' },
      ],
    }),
    profile: { inline: { ...INLINE_PROFILE, redact: { masks: ['css=.fixture-banner'] } } },
  })

  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    // An injected backend receives the profile's masks like the playwright one
    // does: the action log's masks note must stay honest for every backend.
    flowSession: async (opts) => {
      receivedMasks = opts.masks
      return factory()
    },
  })

  expect(result.verdict).toBe('passed')
  expect(receivedMasks).toEqual(['css=.fixture-banner'])
  const log = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'actions.log'), 'utf8')
  expect(log).toContain('screenshot final.png masks: css=.fixture-banner')
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

const TOTP_PROFILE: QaProfile = {
  ...INLINE_PROFILE,
  app: {
    ...INLINE_PROFILE.app,
    login: {
      fixture: 'fixtures/users.yml',
      role: 'admin',
      totp: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 6, period: 30, algorithm: 'SHA1' },
    },
  },
}

function totpSessionFactory(events: string[]) {
  return async (): Promise<FakeSession> => {
    const page: FlowPage = {
      open: async (url) => events.push(`open ${url}`),
      click: async () => events.push('click'),
      type: async (_what, value) => events.push(`type ${value}`),
      assertText: async (text) => events.push(`assert ${text}`),
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
    return { page, trace, dispose: async () => events.push('dispose'), events }
  }
}

test('a flow through the totp action types the seeded code and sweeps it from the action log (#64)', async () => {
  const events: string[] = []
  const job = await makeJob({
    criteria: flowCriterion({
      kind: 'flow',
      actions: [
        { action: 'open', url: HEALTH_URL },
        { action: 'totp', element: { role: 'textbox', name: 'Verification code' } },
        { action: 'assert', text: 'Welcome' },
      ],
    }),
    profile: { inline: TOTP_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: totpSessionFactory(events) })

  expect(result.verdict).toBe('passed')
  const typed = events.find((event) => event.startsWith('type '))
  expect(typed).toMatch(/^type \d{6}$/)
  const log = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'actions.log'), 'utf8')
  expect(log).toContain('totp code generated for window')
  expect(log).not.toMatch(new RegExp(typed?.slice(5) ?? '', ''))
})

test('a mail-borne one-time code is extracted, typed by a flow, and swept from the evidence (#64)', async () => {
  const events: string[] = []
  // Schemes are joined at runtime: test files carry no network literals.
  const loginUrl = [['https:', '//app.example.com/login?code=555111'].join('')]
  const readMail = async (): Promise<MailMessage[]> => [
    {
      from: 'app@example.com',
      subject: 'Sign in',
      body: `Your one-time code is 555111. Or follow ${loginUrl[0]}`,
      received_at: new Date().toISOString(),
    },
  ]
  const job = await makeJob({
    criteria: flowCriterion(
      { kind: 'mail', name: 'signup', address: 'qa@example.com', code: {} },
      {
        kind: 'flow',
        actions: [{ action: 'type', element: { role: 'textbox', name: 'Code' }, value: '{{mail.signup.code}}' }],
      },
    ),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: totpSessionFactory(events), readMail })

  expect(result.verdict).toBe('passed')
  expect(events).toContain('type 555111')
  const log = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '1', 'actions.log'), 'utf8')
  expect(log).not.toContain('555111')
  // The typed code may still sit in the page's input, and redaction cannot
  // read pixels: the flow's captures are withheld, and the evidence says so.
  expect(log).toContain('final.png withheld: the second-factor code is visible on the page')
  const message = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'message.json'), 'utf8')
  expect(message).not.toContain('555111')
})

test('a flow that only reads a mail link keeps its captures: a link is not a code (#64)', async () => {
  const events: string[] = []
  // Schemes are joined at runtime: test files carry no network literals.
  const loginUrl = [['https:', '//app.example.com/login?token=abc'].join('')]
  const readMail = async (): Promise<MailMessage[]> => [
    {
      from: 'app@example.com',
      subject: 'Sign in',
      body: `Continue at ${loginUrl[0]}`,
      received_at: new Date().toISOString(),
    },
  ]
  const job = await makeJob({
    criteria: flowCriterion(
      { kind: 'mail', name: 'signup', address: 'qa@example.com' },
      { kind: 'flow', actions: [{ action: 'open', url: '{{mail.signup.link}}' }] },
    ),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: totpSessionFactory(events), readMail })

  expect(result.verdict).toBe('passed')
  expect(events).toContain(`open ${loginUrl[0]}`)
  const log = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '1', 'actions.log'), 'utf8')
  // The link itself is swept from the log, but no capture is withheld: the
  // link is not a one-time value, so the page stays publishable.
  expect(log).not.toContain(loginUrl[0])
  expect(log).not.toContain('withheld')
})

test('a flow action failure that quotes a mail-borne value is redacted in the result (#64)', async () => {
  const events: string[] = []
  const readMail = async (): Promise<MailMessage[]> => [
    {
      from: 'app@example.com',
      subject: 'Sign in',
      body: 'Your code is 555111',
      received_at: new Date().toISOString(),
    },
  ]
  const factory = async (): Promise<FakeSession> => {
    const page: FlowPage = {
      open: async (url) => events.push(`open ${url}`),
      click: async () => events.push('click'),
      type: async (_what, value) => {
        events.push(`type ${value}`)
        throw new Error(`the seam rejected the value ${value}`)
      },
      assertText: async (text) => events.push(`assert ${text}`),
      screenshot: async () => undefined,
    }
    const trace: FlowTrace = { start: async () => 'trace-1', stop: async () => undefined }
    return { page, trace, dispose: async () => undefined, events }
  }
  const job = await makeJob({
    criteria: flowCriterion(
      { kind: 'mail', name: 'signup', address: 'qa@example.com', code: {} },
      { kind: 'flow', actions: [{ action: 'type', element: { role: 'textbox', name: 'Code' }, value: '{{mail.signup.code}}' }] },
    ),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: factory, readMail })

  expect(result.verdict).toBe('blocked')
  expect(result.criteria[0].outcome).toBe('unverified')
  // The reason the action failure quotes the typed value, so the value never
  // reaches the result the verifier reads (#64).
  expect(result.criteria[0].reason).not.toContain('555111')
  expect(result.criteria[0].reason).toContain('[redacted]')
})
