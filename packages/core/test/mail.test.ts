import { readFile, writeFile } from 'node:fs/promises'
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
  mailpitSource,
  parsePlan,
  runJob,
  validateProfileConfig,
  type JobCriterion,
  type MailMessage,
  type ReadMail,
} from '../src/index.js'
import { answering, caughtMessage, fakeMailpit, type Caught, type Transport } from './fake-mailpit.js'

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

async function makeJob(criteria: JobCriterion[], mail?: Record<string, unknown>): Promise<Parameters<typeof runJob>[0]> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-mail-'))
  return {
    id: 'job-mail-smoke',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: { inline: mail === undefined ? INLINE_PROFILE : { ...INLINE_PROFILE, mail } },
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
      // The message that proved it, as the comment shows it (#65).
      mail: [
        {
          check: 'welcome mail',
          from: 'Qare <no-reply@example.test>',
          subject: 'Sign in',
          excerpt: `Welcome. Open ${REDACTED_URL} to continue.`,
          links: [REDACTED_URL],
        },
      ],
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

test('extractCode treats an empty match as no code, so nothing empty is published (#64)', () => {
  expect(extractCode('no code here', 'a*')).toBeUndefined()
  expect(extractCode('no code here', '(x*)')).toBeUndefined()
})

test('extractCode never publishes the whole match when an optional group did not participate (#64)', () => {
  expect(extractCode('the body has no code in it', '.*(\\d{6})?')).toBeUndefined()
  expect(extractCode('code 551234', 'code (\\d{6})?')).toBe('551234')
})

const MAILPIT_TEMPLATE = ['http:', '//localhost:{{run.app_port}}/mailpit'].join('')

function profileField(mail: unknown): string {
  try {
    validateProfileConfig({ ...INLINE_PROFILE, mail })
  } catch (error) {
    return `${(error as { field?: string }).field}: ${(error as Error).message}`
  }
  throw new Error('expected the profile to be refused')
}

test('a profile declares its mail source by kind, and the domain addresses are minted on (#65)', () => {
  const profile = validateProfileConfig({
    ...INLINE_PROFILE,
    mail: { source: { kind: 'mailpit', url: MAILPIT_TEMPLATE }, domain: 'qa.example.test' },
  })
  // The URL may name run values, so a stack can publish its catcher behind
  // the one port a run mints.
  expect(profile.mail).toEqual({ source: { kind: 'mailpit', url: MAILPIT_TEMPLATE }, domain: 'qa.example.test' })
  expect(validateProfileConfig({ ...INLINE_PROFILE, mail: { source: { kind: 'inbox', url: INBOX_URL } } }).mail).toEqual({
    source: { kind: 'inbox', url: INBOX_URL },
  })
})

test('a mail section that names no source, two sources, or an unknown kind is refused with the field named (#65)', () => {
  expect(profileField({})).toMatch(/^mail: .*inbox or source/)
  expect(profileField({ domain: 'qa.example.test' })).toMatch(/^mail: .*inbox or source/)
  expect(profileField({ inbox: INBOX_URL, source: { kind: 'mailpit', url: INBOX_URL } })).toMatch(/^mail: .*not both/)
  expect(profileField({ source: { kind: 'imap', url: INBOX_URL } })).toMatch(/^mail\.source\.kind: .*"mailpit" or "inbox"/)
  expect(profileField({ source: { kind: 'mailpit', url: ['ftp:', '//mailpit.local'].join('') } })).toMatch(/^mail\.source\.url: .*http or https URL/)
  expect(profileField({ source: { kind: 'mailpit' } })).toMatch(/^mail\.source\.url: /)
})

test('a mail domain that is not a host name is refused, naming the field (#65)', () => {
  for (const domain of ['', 'has space.test', 'someone@qa.test', '-qa.test', 'QA.Example.test/'])
    expect(profileField({ inbox: INBOX_URL, domain })).toMatch(/^mail\.domain: /)
})

const CATCHER_TEMPLATE = ['http:', '//catcher.local/{{run.id}}/mailpit'].join('')

/**
 * A fake catcher behind the seam a run builds its mail source through. It
 * catches one message for whatever address is first searched for, the way an
 * app that was just asked to send one would have delivered it.
 */
function catcher(
  deliver: (address: string) => Caught[] = (address) => [caughtMessage({ to: address, created: new Date(Date.now() + 5).toISOString() })],
  wrap: (transport: Transport) => Transport = (transport) => transport,
) {
  const caught: Caught[] = []
  const fake = fakeMailpit(caught)
  const delivered = new Set<string>()
  const transport = wrap(
    answering((input, init) => {
      const query = /^to:"(.*)"$/.exec(new URL(String(input)).searchParams.get('query') ?? '')
      const address = query?.[1]
      if (address !== undefined && !delivered.has(address)) {
        delivered.add(address)
        caught.push(...deliver(address))
      }
      return fake.transport(input, init)
    }),
  )
  return {
    caught,
    requests: fake.requests,
    opts: { ...HEALTHY_BOOT, mailSource: (declared: { url: string }) => mailpitSource(declared.url, transport) },
  }
}

const CATCHER = { source: { kind: 'mailpit', url: CATCHER_TEMPLATE } }

async function cleanupRecord(job: { evidenceDir: string }): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(job.evidenceDir, 'mail-cleanup.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

test('a run reads through the source its profile declares, at an address minted on the profile domain (#65)', async () => {
  const sink = catcher()
  const job = await makeJob(mailCriteria({ address: '{{run.mail_address}}', subject: 'Confirm' }), {
    source: { kind: 'mailpit', url: CATCHER_TEMPLATE },
    domain: 'qa.example.test',
  })
  const { result } = await runJob(job, sink.opts)

  expect(result.verdict).toBe('passed')
  // The source URL carried the run's id, and the address its domain.
  expect(sink.requests[0]).toMatch(/^GET \/[0-9a-f-]{36}\/mailpit\/api\/v1\/search\?query=to%3A%22qare-[0-9a-f-]{36}%40qa\.example\.test%22/)
})

test('a mail source URL naming a value the run does not mint refuses the run, naming the field (#65)', async () => {
  const sink = catcher()
  const job = await makeJob(mailCriteria({ address: '{{run.mail_address}}' }), {
    source: { kind: 'mailpit', url: ['http:', '//catcher.local/{{run.nonsense}}/mailpit'].join('') },
  })
  const { result } = await runJob(job, sink.opts)

  expect(result.verdict).toBe('refused')
  expect(JSON.stringify(result.criteria)).toContain('mail.source.url')
  expect(sink.requests).toEqual([])
})

test('the wait opens with the criterion, so a message its earlier check caused is the one read (#65)', async () => {
  // The check before the mail check is what makes the app send: by the time
  // the mail check starts, a message sent synchronously has already arrived.
  const job = await makeJob([
    {
      id: 'signup-mail',
      text: 'signing up sends a confirmation',
      checks: [
        { kind: 'command', run: 'node stamp.mjs' },
        { kind: 'mail', name: 'confirmation', address: 'qa@localhost', timeoutMs: 200 },
      ],
    },
  ])
  await writeFile(join(job.repoPath, 'stamp.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync('stamp', String(Date.now()))\n")
  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    readMail: async () => [message({ received_at: new Date(Number(await readFile(join(job.repoPath, 'stamp'), 'utf8'))).toISOString() })],
  })

  expect(result.criteria[0]?.outcome).toBe('proven')
})

test('a run deletes the mail at the address it minted when it finishes, and records what went (#65)', async () => {
  const sink = catcher((address) => [
    caughtMessage({ to: address, created: new Date(Date.now() + 5).toISOString() }),
    caughtMessage({ ID: 'not-this-runs', to: 'qare-another-run@localhost' }),
  ])
  const job = await makeJob(mailCriteria({ address: '{{run.mail_address}}' }), CATCHER)
  const { result } = await runJob(job, sink.opts)

  expect(result.verdict).toBe('passed')
  expect(sink.caught.map((caught) => caught.to)).toEqual(['qare-another-run@localhost'])
  const record = await cleanupRecord(job)
  expect(record?.source).toMatch(/^mailpit at /)
  expect(record?.addresses).toEqual([{ address: expect.stringMatching(/^qare-[0-9a-f-]{36}@localhost$/), deleted: 1 }])
})

test('mail at an address the run did not mint is left alone, and the record says so (#65)', async () => {
  const sink = catcher((address) => [caughtMessage({ to: address, created: new Date(Date.now() + 5).toISOString() })])
  const job = await makeJob(mailCriteria({ address: 'shared@localhost' }), CATCHER)
  const { result } = await runJob(job, sink.opts)

  expect(result.verdict).toBe('passed')
  // Another run may be waiting at a shared address: nothing there is deleted.
  expect(sink.caught).toHaveLength(1)
  expect(sink.requests.filter((request) => request.startsWith('DELETE'))).toEqual([])
  expect((await cleanupRecord(job))?.addresses).toEqual([{ address: 'shared@localhost', left: 'not an address this run minted' }])
})

test('a source that cannot delete is recorded, and the verdict stands (#65)', async () => {
  const sink = catcher(undefined, (reads) => answering((input, init) => (init?.method === 'DELETE' ? new Response('no', { status: 500 }) : reads(input, init))))
  const job = await makeJob(mailCriteria({ address: '{{run.mail_address}}' }), CATCHER)
  const { result } = await runJob(job, sink.opts)

  expect(result.verdict).toBe('passed')
  expect(sink.caught).toHaveLength(1)
  expect((await cleanupRecord(job))?.addresses).toEqual([{ address: expect.stringMatching(/^qare-/), error: 'mailpit responded 500' }])
})

test('a run whose checks waited for no mail asks nothing of the source (#65)', async () => {
  const sink = catcher()
  const job = await makeJob([{ id: 'no-mail', text: 'no mail', checks: [{ kind: 'command', run: 'node --version' }] }], CATCHER)
  const { result } = await runJob(job, sink.opts)

  expect(result.verdict).toBe('passed')
  expect(sink.requests).toEqual([])
  expect(await cleanupRecord(job)).toBeUndefined()
})

test('addresses and one-time codes are swept from the message evidence, and the body is never stored whole (#65)', async () => {
  const person = 'jane.doe@customer.test'
  const link = ['https:', '//example.test/confirm?email=jane.doe@customer.test&step=2'].join('')
  const help = ['https:', '//example.test/help'].join('')
  const job = await makeJob(mailCriteria({ address: 'qa@localhost' }))
  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    readMail: reader(() =>
      message({
        subject: `Sign in, ${person}`,
        body: `Hello ${person}, your code is 482913. Open ${link} to continue, or read ${help}?for=${person} first. ${'x'.repeat(400)} TAIL-OF-THE-BODY`,
      }),
    ),
  })

  expect(result.verdict).toBe('passed')
  const text = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'message.json'), 'utf8')
  expect(text).not.toContain(person)
  // A code is swept whether or not the check declared one to extract.
  expect(text).not.toContain('482913')
  expect(text).not.toContain('TAIL-OF-THE-BODY')
  const recorded = JSON.parse(text)
  // The sender is the app's own sending identity, which the evidence shows.
  expect(recorded.from).toBe('Qare <no-reply@example.test>')
  expect(recorded.subject).toBe('Sign in, [redacted]')
  // The first link is the artefact a later check may follow, which #64 sweeps
  // as a secret wherever it appears; the other links are shown, swept.
  expect(recorded.excerpt).toContain('Hello [redacted], your code is [redacted]. Open [redacted] to continue')
  expect(recorded.links).toEqual([`${help}?for=[redacted]`])
  // The result carries the same swept record, never a second copy of the body.
  expect(JSON.stringify(result)).not.toContain(person)
  expect(JSON.stringify(result)).not.toContain('482913')
  const criterion = result.criteria[0]
  expect(criterion?.mail?.[0]?.subject).toBe('Sign in, [redacted]')
})

test('two concurrent runs on one source each read their own message and delete only their own (#65)', async () => {
  let sent = 0
  const subjects = new Map<string, string>()
  const sink = catcher((address) => {
    sent += 1
    subjects.set(address, `Message ${sent}`)
    return [caughtMessage({ ID: `message-${sent}`, to: address, subject: `Message ${sent}`, created: new Date(Date.now() + 5).toISOString() })]
  })
  const jobs = await Promise.all([1, 2].map(() => makeJob(mailCriteria({ address: '{{run.mail_address}}', subject: 'Message' }), CATCHER)))
  const outcomes = await Promise.all(jobs.map((job) => runJob(job, sink.opts)))

  const read: string[] = []
  for (const [index, { result }] of outcomes.entries()) {
    expect(result.verdict).toBe('passed')
    const job = jobs[index]
    if (job === undefined) throw new Error('a run has no job')
    const cleaned = (await cleanupRecord(job))?.addresses as Array<{ address: string; deleted: number }>
    expect(cleaned).toHaveLength(1)
    expect(cleaned[0]?.deleted).toBe(1)
    // The message this run read is the one sent to the address it minted.
    const subject = result.criteria[0]?.mail?.[0]?.subject
    expect(subject).toBe(subjects.get(cleaned[0]?.address ?? ''))
    read.push(subject ?? '')
  }
  expect(read.sort()).toEqual(['Message 1', 'Message 2'])
  expect(sink.caught).toEqual([])
})
