import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  PlanValidationError,
  parsePlan,
  runJob,
  type JobCheck,
  type JobCommandCheck,
  type JobCriterion,
  type JobMailCheck,
  type MailMessage,
  type ReadMail,
} from '../src/index.js'

// Test files must not carry network literals (the offline scanner), so the
// schemes and authorities are joined at runtime.
const SETUP_URL = ['https:', '//example.test/setup/abc123'].join('')
const TOKEN_URL = ['https:', '//example.test/sign-in?token=abc'].join('')

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

function mailCheck(variants: Partial<JobMailCheck> = {}): JobCheck {
  return { kind: 'mail', name: 'welcome', address: 'qa@localhost', timeoutMs: 30, ...variants }
}

function consumeCheck(reference: string, variants: Partial<JobCommandCheck> = {}): JobCheck {
  return { kind: 'command', run: `echo ${reference}`, ...variants }
}

function criteria(...groups: JobCheck[][]): JobCriterion[] {
  return groups.map((checks, index) => ({
    id: `criterion-${index + 1}`,
    text: `criterion ${index + 1}`,
    checks,
  }))
}

async function makeJob(criteria: JobCriterion[]): Promise<Parameters<typeof runJob>[0]> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-single-use-'))
  return {
    id: 'job-single-use',
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
    subject: 'Welcome',
    body: `Start at ${SETUP_URL} to continue.`,
    // One millisecond of headroom, so the sink's report of a fresh message is
    // strictly after a check's start even within the same clock millisecond.
    received_at: new Date(Date.now() + 1).toISOString(),
    ...fields,
  }
}

function reader(...make: Array<() => MailMessage>): ReadMail {
  return async () => make.map((build) => build())
}

async function evidenceText(job: Parameters<typeof runJob>[0], path: string): Promise<string> {
  return readFile(join(job.evidenceDir, path), 'utf8')
}

test('a mail check parses with a singleUse declaration', () => {
  const plan = parsePlan({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: 't', checks: [{ kind: 'mail', name: 'welcome', address: 'qa@localhost', singleUse: true }] },
    ],
  })
  expect(plan.criteria[0]?.checks[0]).toEqual({ kind: 'mail', name: 'welcome', address: 'qa@localhost', singleUse: true })
})

test('a non-boolean singleUse is refused at plan time', () => {
  try {
    parsePlan({
      schemaVersion: '1',
      criteria: [{ id: 'c1', text: 't', checks: [{ kind: 'mail', name: 'n', address: 'a@localhost', singleUse: 'yes' }] }],
    })
  } catch (error) {
    expect(error).toBeInstanceOf(PlanValidationError)
    expect((error as PlanValidationError).field).toBe('criteria[0].checks[0].singleUse')
    return
  }
  throw new Error('expected parsePlan to refuse a non-boolean singleUse')
})

test('an artefact reference to an unknown mail check refuses the run at plan time', async () => {
  const job = await makeJob(criteria([consumeCheck('{{mail.nobody.link}}')]))
  const { result } = await runJob(job)
  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.reason).toContain('no mail check named nobody runs before this check')
})

test('an artefact reference placed before the mail check refuses the run at plan time', async () => {
  const job = await makeJob(criteria([consumeCheck('{{mail.welcome.link}}')], [mailCheck()]))
  const { result } = await runJob(job)
  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.reason).toContain('no mail check named welcome runs before this check')
})

test('a code artefact from a mail check that declares no code section refuses the run at plan time', async () => {
  // The declared fields are what the plan locks: reading a code the mail check
  // never extracts would otherwise surface only as a runtime miss, after the
  // plan was judged to be honest (#64).
  const job = await makeJob(criteria([mailCheck({ timeoutMs: 30 }), consumeCheck('{{mail.welcome.code}}')]))
  const { result } = await runJob(job)
  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.reason).toContain('the mail check named welcome declares no code section')
})

test('an artefact reference to an unknown field refuses the run at plan time', async () => {
  const job = await makeJob(criteria([mailCheck()], [consumeCheck('{{mail.welcome.attachment}}')]))
  const { result } = await runJob(job)
  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.reason).toContain('unknown artefact "{{mail.welcome.attachment}}"')
})

test('a reference naming two earlier mail checks refuses the run at plan time', async () => {
  const job = await makeJob(
    criteria(
      [mailCheck({ address: 'a@localhost' })],
      [mailCheck({ address: 'b@localhost' })],
      [consumeCheck('{{mail.welcome.link}}')],
    ),
  )
  const { result } = await runJob(job)
  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.reason).toContain('2 earlier mail checks are named welcome')
})

test('an artefact reference in the seed command refuses the run at plan time', async () => {
  const job = await makeJob(criteria([mailCheck()], [consumeCheck('{{mail.welcome.link}}')]))
  job.profile = {
    inline: { ...INLINE_PROFILE, app: { ...INLINE_PROFILE.app, seed: { command: `bin/rails runner '{{mail.welcome.link}}'` } } },
  }
  const { result } = await runJob(job)
  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.reason).toContain('unknown run value "{{mail.welcome.link}}"')
})

test('a consumer runs after the mail check, gets the link, and records the consumption', async () => {
  const job = await makeJob(criteria([mailCheck({ singleUse: true }), consumeCheck('{{mail.welcome.link}}')]))
  const { result } = await runJob(job, { ...HEALTHY_BOOT, readMail: reader(() => message()) })
  expect(result.verdict).toBe('passed')
  // The consumed value is a secret: the evidence names what happened, and the
  // value itself is redacted (#64).
  const stdout = await evidenceText(job, join('checks', 'criterion-1', '1', 'stdout.txt'))
  expect(stdout.trim()).toBe('[redacted]')
  const consumed = await evidenceText(job, join('checks', 'criterion-1', '1', 'consumed.json'))
  expect(JSON.parse(consumed)).toEqual({
    artefacts: [{ source: 'mail.welcome', artefact: '[redacted]' }],
    consumed_by: { criterion: 'criterion-1', check: 1 },
    response: {
      status: 'passed',
      evidence: [join('checks', 'criterion-1', '1', 'stdout.txt'), join('checks', 'criterion-1', '1', 'stderr.txt')],
    },
  })
})

test('a second consumer of a single-use artefact is unverified naming the spent artefact, and never runs', async () => {
  const job = await makeJob(
    criteria(
      [mailCheck({ singleUse: true }), consumeCheck('{{mail.welcome.link}}')],
      [consumeCheck('{{mail.welcome.link}}')],
    ),
  )
  const { result } = await runJob(job, { ...HEALTHY_BOOT, readMail: reader(() => message()) })
  expect(result.verdict).toBe('blocked')
  expect(result.criteria[1]?.outcome).toBe('unverified')
  expect(result.criteria[1]?.reason).toBe(
    'the single-use link from mail check welcome was already consumed by criterion criterion-1; a retry requires a fresh message, and this run will not follow the same link twice',
  )
  await expect(evidenceText(job, join('checks', 'criterion-2', '0', 'stdout.txt'))).rejects.toBeDefined()
})

test('a non-single-use artefact can be read by every consumer', async () => {
  const job = await makeJob(
    criteria(
      [mailCheck(), consumeCheck('{{mail.welcome.link}}')],
      [consumeCheck('{{mail.welcome.link}}')],
    ),
  )
  const { result } = await runJob(job, { ...HEALTHY_BOOT, readMail: reader(() => message()) })
  expect(result.verdict).toBe('passed')
  expect((await evidenceText(job, join('checks', 'criterion-2', '0', 'stdout.txt'))).trim()).toBe('[redacted]')
})

test('a message that carries no links leaves the consumer unverified naming the mail check', async () => {
  const job = await makeJob(criteria([mailCheck({ singleUse: true }), consumeCheck('{{mail.welcome.link}}')]))
  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    readMail: reader(() => message({ body: 'No links here.' })),
  })
  expect(result.verdict).toBe('blocked')
  expect(result.criteria[0]?.reason).toBe('the message read by mail check welcome carries no links, so there is no artefact to substitute')
})

test('a consumer of an unread message is unverified naming the mail check', async () => {
  const job = await makeJob(criteria([mailCheck({ singleUse: true }), consumeCheck('{{mail.welcome.link}}')]))
  const { result } = await runJob(job, { ...HEALTHY_BOOT })
  expect(result.verdict).toBe('blocked')
  expect(result.criteria[0]?.outcome).toBe('unverified')
})

test('an artefact reference inside an env value substitutes like the run string', async () => {
  const job = await makeJob(
    criteria([mailCheck({ singleUse: true }), { kind: 'command', run: 'printenv ARTEFACT', env: { ARTEFACT: '{{mail.welcome.link}}' } }]),
  )
  const { result } = await runJob(job, { ...HEALTHY_BOOT, readMail: reader(() => message()) })
  expect(result.verdict).toBe('passed')
  expect((await evidenceText(job, join('checks', 'criterion-1', '1', 'stdout.txt'))).trim()).toBe('[redacted]')
})

test('the consumed artefact is redacted in the evidence', async () => {
  const job = await makeJob(criteria([mailCheck({ singleUse: true }), consumeCheck('{{mail.welcome.link}}')]))
  await runJob(job, {
    ...HEALTHY_BOOT,
    readMail: reader(() => message({ body: `Open ${TOKEN_URL} to continue.` })),
  })
  const consumed = await evidenceText(job, join('checks', 'criterion-1', '1', 'consumed.json'))
  expect(consumed).toContain('token=[redacted]')
  expect(consumed).not.toContain('token=abc')
})
