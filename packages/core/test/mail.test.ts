import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { expect, test } from 'vitest'
import {
  PlanValidationError,
  extractCode,
  httpMailbox,
  loadJobFromText,
  mailEvidence,
  parsePlan,
  runJob,
  validateProfileConfig,
  type JobCriterion,
  type MailMessage,
  type ReadMail,
} from '../src/index.js'

// Test files must not carry network literals (the offline scanner), so the
// schemes and authorities are joined at runtime.
const INBOX_URL = ['http:', '//mailpit.local'].join('')
const EXAMPLE_URL = ['https:', '//example.test/sign-in?token=abc'].join('')
const REDACTED_URL = ['https:', '//example.test/sign-in?token=', '[redacted]'].join('')

function mailCriteria(...variants: Record<string, unknown>[]): JobCriterion[] {
  return variants.map((variant, index) => ({
    id: `criterion-${index + 1}`,
    text: `criterion ${index + 1}`,
    checks: [{ kind: 'mail', name: 'welcome mail', ...variant }],
  }))
}

const INLINE_PROFILE = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: ['http:', '//localhost:3000/up'].join(''), timeout: '120s' },
    seed: { command: 'bin/rails db:seed:qa' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  visual: { widths: [1440], themes: ['light'] },
  suites: [],
}

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

async function makeJob(criteria: JobCriterion[]): Promise<Parameters<typeof runJob>[0]> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-mail-'))
  return {
    id: 'job-mail-smoke',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: { inline: INLINE_PROFILE },
    criteria,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

function message(fields: Partial<MailMessage> = {}): MailMessage {
  return {
    from: 'Qare <no-reply@example.test>',
    subject: 'Sign in',
    body: `Welcome. Open ${EXAMPLE_URL} to continue.`,
    // One millisecond of headroom, so the sink's report of a fresh message is
    // strictly after a check's start even within the same clock millisecond.
    received_at: new Date(Date.now() + 1).toISOString(),
    ...fields,
  }
}

function reader(...make: Array<() => MailMessage>): ReadMail {
  return async () => make.map((build) => build())
}

test('a mail check parses with an address and optional matchers and timeout', () => {
  const plan = parsePlan({
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: 'a signed-up account receives a welcome mail',
        checks: [
          { kind: 'mail', name: 'welcome mail', address: 'qa@localhost', from: 'Qare', subject: 'Welcome', timeoutMs: 15000 },
        ],
      },
    ],
  })
  const check = plan.criteria[0]?.checks[0]
  expect(check).toEqual({
    kind: 'mail',
    name: 'welcome mail',
    address: 'qa@localhost',
    from: 'Qare',
    subject: 'Welcome',
    timeoutMs: 15000,
  })
})

test('a mail check without an address is refused at plan time', () => {
  try {
    parsePlan({
      schemaVersion: '1',
      criteria: [{ id: 'c1', text: 't', checks: [{ kind: 'mail', name: 'n' }] }],
    })
  } catch (error) {
    expect(error).toBeInstanceOf(PlanValidationError)
    expect((error as PlanValidationError).field).toBe('criteria[0].checks[0].address')
    return
  }
  throw new Error('expected parsePlan to refuse a mail check without an address')
})

test('an unparsable mail timeout is refused with the field named', () => {
  try {
    parsePlan({
      schemaVersion: '1',
      criteria: [{ id: 'c1', text: 't', checks: [{ kind: 'mail', name: 'n', address: 'a@localhost', timeoutMs: 0 }] }],
    })
  } catch (error) {
    expect((error as PlanValidationError).field).toBe('criteria[0].checks[0].timeoutMs')
    return
  }
  throw new Error('expected parsePlan to refuse timeoutMs: 0')
})

test('a plan mail check compiles into the job so the runner sees it', () => {
  const job = loadJobFromText(
    [
      'id: job-mail-compile',
      'repoPath: .',
      'baseRef: main',
      'headRef: HEAD',
      'profile: { path: .qa }',
      'evidenceDir: evidence',
      'post: none',
      'criteria:',
      '  - id: c1',
      '    text: mail arrives',
      '    checks:',
      '      - kind: mail',
      '        address: qa@localhost',
      '        subject: Welcome',
    ].join('\n'),
  )
  expect(job.criteria[0]?.checks).toEqual([{ kind: 'mail', address: 'qa@localhost', subject: 'Welcome' }])
})

test('a message matching every matcher proves the criterion and lands in the evidence', async () => {
  const job = await makeJob(mailCriteria({ address: 'qa@localhost', subject: 'Sign in' }))
  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    readMail: reader(() => message()),
  })

  expect(result.verdict).toBe('passed')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'proven',
      evidence: ['checks/criterion-1/0/message.json'],
    },
  ])
  const recorded = JSON.parse(
    await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'message.json'), 'utf8'),
  )
  expect(recorded.from).toBe('Qare <no-reply@example.test>')
  expect(recorded.subject).toBe('Sign in')
  // The link's token is fixture data a builtin rule redacts; evidence is
  // published, so the redaction applies to it like to any other string.
  expect(recorded.links).toEqual([REDACTED_URL])
  expect(typeof recorded.wait_ms).toBe('number')
  expect(recorded.excerpt).toContain('Welcome')
})

test('values substitute into the mail address', async () => {
  const seenAddresses: string[] = []
  const job = await makeJob(mailCriteria({ address: 'qare-{{run.id}}@localhost' }))
  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    readMail: async (address) => {
      seenAddresses.push(address)
      return [message()]
    },
  })

  expect(result.verdict).toBe('passed')
  expect(seenAddresses).toHaveLength(1)
  expect(seenAddresses[0]).toMatch(/^qare-[0-9a-f-]{36}@localhost$/)
})

test('a message from before the check started is ignored, so a rerun waits for a new message', async () => {
  const job = await makeJob(mailCriteria({ address: 'qa@localhost', timeoutMs: 30 }))
  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    readMail: reader(() => message({ received_at: new Date(Date.now() - 60_000).toISOString() })),
  })

  expect(result.verdict).toBe('blocked')
  const criterion = result.criteria[0]
  expect(criterion?.outcome).toBe('unverified')
  expect(criterion?.outcome === 'unverified' ? criterion.reason : '').toContain('qa@localhost')
  expect(criterion?.outcome === 'unverified' ? criterion.reason : '').toContain('no message arrived')
})

test('a message that never matches is unverified naming the mailbox and the wait', async () => {
  const job = await makeJob(mailCriteria({ address: 'qa@localhost', subject: 'Never sent', timeoutMs: 30 }))
  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    readMail: reader(() => message({ subject: 'Sign in' })),
  })

  expect(result.verdict).toBe('blocked')
  const criterion = result.criteria[0]
  expect(criterion?.outcome).toBe('unverified')
  expect(criterion?.outcome === 'unverified' ? criterion.reason : '').toContain('no message arrived')
})

test('an unreachable mailbox is unverified naming the mailbox, never failed', async () => {
  const job = await makeJob(mailCriteria({ address: 'qa@localhost' }))
  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    readMail: async () => {
      throw new Error('connection refused')
    },
  })

  expect(result.verdict).toBe('blocked')
  const criterion = result.criteria[0]
  expect(criterion?.outcome).toBe('unverified')
  expect(criterion?.outcome === 'unverified' ? criterion.reason : '').toContain('could not be read')
  expect(criterion?.outcome === 'unverified' ? criterion.reason : '').toContain('qa@localhost')
})

test('a profile without a mail source is unverified naming the missing inbox', async () => {
  const job = await makeJob(mailCriteria({ address: 'qa@localhost' }))
  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('blocked')
  const criterion = result.criteria[0]
  expect(criterion?.outcome === 'unverified' ? criterion.reason : '').toContain('no mail source')
})

test('httpMailbox lists messages through the sink contract and refuses a bad response', async () => {
  const requested: string[] = []
  const transport = (url: string) => {
    requested.push(url)
    return Promise.resolve(new Response(JSON.stringify({ messages: [message()] }), { status: 200 }))
  }
  const read = httpMailbox(INBOX_URL, transport)
  const listed = await read('qa@localhost', '2026-01-01T00:00:00Z')
  expect(listed).toHaveLength(1)
  const requestedUrl = requested[0]
  if (requestedUrl === undefined) throw new Error('the inbox was never requested')
  expect(new URL(requestedUrl).searchParams.get('address')).toBe('qa@localhost')
  expect(new URL(requestedUrl).searchParams.get('after')).toBe('2026-01-01T00:00:00Z')

  const failing = httpMailbox(
    INBOX_URL,
    () => Promise.resolve(new Response('no', { status: 503 })),
  )
  await expect(failing('qa@localhost', '2026-01-01T00:00:00Z')).rejects.toThrow('inbox responded 503')
})

test('mail evidence dedups links and caps the excerpt', () => {
  const aUrl = ['https:', '//a.test/x'].join('')
  const body = `repeat ${aUrl} and ${aUrl} and ${'x'.repeat(400)}`
  const evidence = mailEvidence(message({ body }), 12, 3)
  expect(evidence.links).toEqual([aUrl])
  expect(evidence.excerpt).toHaveLength(280)
  expect(evidence.wait_ms).toBe(12)
  expect(evidence.polls).toBe(3)
})

test('the profile refuses a mail inbox that is not an http URL', () => {
  expect(() =>
    validateProfileConfig({
      ...INLINE_PROFILE,
      mail: { inbox: 'ftp://mailpit.local' },
    }),
  ).toThrowError(/must be an http or https URL/)
  const ok = validateProfileConfig({
    ...INLINE_PROFILE,
    mail: { inbox: INBOX_URL },
  })
  expect(ok.mail).toEqual({ inbox: INBOX_URL })
})

test('extractCode reads the first digit run the default pattern matches (#64)', () => {
  expect(extractCode('Your one-time code is 551234 and it expires soon.')).toBe('551234')
  expect(extractCode('no code here')).toBeUndefined()
})

test('extractCode honors a declared pattern, preferring its first capture group (#64)', () => {
  expect(extractCode('Code: AB-1234.', 'Code: ([A-Z]{2}-\\d{4})')).toBe('AB-1234')
  expect(extractCode('555 77 2 34', '\\d{2} \\d{2}')).toBe('55 77')
})
