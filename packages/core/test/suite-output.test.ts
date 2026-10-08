import { existsSync } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { FakeAgentRunner, SUITE_TAIL_BYTES, evidenceOf, judgeExecuted, prepareVerifierInputs, runJob, runSuiteCheck, type Job, type QaProfile } from '../src/index.js'

// #272: two Cucumber suites exited 1 on a consumer's run and nothing they
// printed was kept. The only evidence was suite.txt (the command, the
// outcome, the exit code), so the failure could not be read, and a flaky
// suite could not be told from a real one.

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')
const BOOT = { runCompose: async () => ({ code: 0, stdout: '', stderr: '' }), probe: async () => ({ ok: true }), pollIntervalMs: 1 }

function profileWith(suiteCommand: string, redact?: QaProfile['redact']): QaProfile {
  return {
    app: {
      boot: { compose: 'compose.qa.yaml', service: 'web' },
      health: { http: HEALTH_URL, timeout: '120s' },
      seed: { command: 'true' },
      login: { fixture: 'fixtures/users.yml', role: 'admin' },
    },
    stubs: [],
    visual: { widths: [], themes: [] },
    suites: [{ name: 'sign-in', command: suiteCommand, kind: 'flow' }],
    ...(redact === undefined ? {} : { redact }),
  }
}

/** A job whose one criterion is proven by the suite, with `script` as the suite's program. */
async function suiteJob(script: string, redact?: QaProfile['redact']): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-suite-output-'))
  await writeFile(join(repoPath, 'suite.js'), script)
  return {
    id: 'job-suite-output',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: { inline: profileWith('node suite.js', redact) },
    criteria: [{ id: 'criterion-1', text: 'a member signs in', checks: [{ kind: 'flow', suite: 'sign-in' }] }],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

const checkFile = (job: Job, name: string): string => join(job.evidenceDir, 'checks', 'criterion-1', '0', name)

const FAILING = [
  "console.log('Feature: Sign in')",
  "console.log('  Scenario: A member signs in with a password')",
  "console.log('    Then they land on the dashboard')",
  "console.log('      expected to find text \"Dashboard\" but there were no matches (RSpec::Expectations::ExpectationNotMetError)')",
  "console.log('1 scenario (1 failed)')",
  "console.error('warning: the browser closed while a request was in flight')",
  'process.exitCode = 1',
].join('\n')

test('a failed suite saves what it wrote to stdout and stderr beside suite.txt, and lists both as evidence', async () => {
  const job = await suiteJob(FAILING)

  const { result } = await runJob(job, BOOT)

  expect(result.criteria[0]).toMatchObject({ id: 'criterion-1', outcome: 'failed' })
  expect(result.criteria[0]?.evidence).toEqual(['checks/criterion-1/0/suite.txt', 'checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt'])
  const stdout = await readFile(checkFile(job, 'stdout.txt'), 'utf8')
  expect(stdout).toContain('Scenario: A member signs in with a password')
  expect(stdout).toContain('1 scenario (1 failed)')
  expect(await readFile(checkFile(job, 'stderr.txt'), 'utf8')).toContain('warning: the browser closed while a request was in flight')
  // suite.txt still says what ran and how it ended, and now what it closed with.
  expect(JSON.parse(await readFile(checkFile(job, 'suite.txt'), 'utf8'))).toMatchObject({ suite: 'sign-in', command: 'node suite.js', outcome: 'failed', exit_code: 1 })
})

test("a failed suite's reason carries the last lines of its output, so the comment says what failed", async () => {
  const job = await suiteJob(FAILING)

  const { result } = await runJob(job, BOOT)

  const reason = (result.criteria[0] as { reason?: string }).reason ?? ''
  expect(reason).toMatch(/^suite sign-in exited 1; its output ended: /)
  expect(reason).toContain('expected to find text "Dashboard" but there were no matches')
  expect(reason).toContain('1 scenario (1 failed)')
  expect(reason).toContain('stderr ended: warning: the browser closed while a request was in flight')
  // One line in the comment's table: the lines are joined, not left as line breaks.
  expect(reason).not.toContain('\n')
})

test('the reason is bounded: a long run gives its last lines only, without the colour codes a test runner prints', async () => {
  const script = [
    "for (let i = 1; i <= 400; i += 1) console.log('step ' + i + ' passed ' + 'x'.repeat(300))",
    "console.log('\\u001b[31mFailing Scenarios:\\u001b[0m')",
    "console.log('\\u001b[31mcucumber features/sign_in.feature:12\\u001b[0m')",
    'process.exitCode = 1',
  ].join('\n')
  const job = await suiteJob(script)

  const { result } = await runJob(job, BOOT)

  const reason = (result.criteria[0] as { reason?: string }).reason ?? ''
  expect(reason).toContain('Failing Scenarios: / cucumber features/sign_in.feature:12')
  expect(reason).not.toContain('\u001b')
  expect(reason).not.toContain('step 1 passed')
  expect(reason.length).toBeLessThan(1500)
  // The file keeps everything, and keeps it as the suite wrote it.
  const stdout = await readFile(checkFile(job, 'stdout.txt'), 'utf8')
  expect(stdout).toContain('step 1 passed')
  expect(stdout).toContain('\u001b[31mFailing Scenarios:')
})

test('a suite that passes saves its output too, and the verifier is given the files as evidence for the criterion', async () => {
  const job = await suiteJob("console.log('1 scenario (1 passed)')")

  const { result } = await runJob(job, BOOT)

  expect(result.criteria[0]).toMatchObject({ outcome: 'proven' })
  expect(await readFile(checkFile(job, 'stdout.txt'), 'utf8')).toContain('1 scenario (1 passed)')
  expect(await readFile(checkFile(job, 'stderr.txt'), 'utf8')).toBe('')
  const inputs = prepareVerifierInputs({
    criteria: [{ criterionId: 'criterion-1', outcome: 'proven', regression: false }],
    texts: { 'criterion-1': 'a member signs in' },
    evidence: { 'criterion-1': evidenceOf(result.criteria[0]!) },
    diff: '',
  })
  expect(inputs.claims[0]?.evidence).toEqual(['checks/criterion-1/0/suite.txt', 'checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt'])
})

test('the saved output and the reason are swept for secrets, by the built-in rules and the profile\'s own', async () => {
  const script = [
    "console.log('signing in as fixture-member-7781')",
    "console.log('API_TOKEN=hunter2-live-value')",
    "console.error('fixture-member-7781 was refused')",
    'process.exitCode = 1',
  ].join('\n')
  const job = await suiteJob(script, { values: ['fixture-member-7781'] })

  const { result } = await runJob(job, BOOT)

  const stdout = await readFile(checkFile(job, 'stdout.txt'), 'utf8')
  const stderr = await readFile(checkFile(job, 'stderr.txt'), 'utf8')
  const reason = (result.criteria[0] as { reason?: string }).reason ?? ''
  for (const text of [stdout, stderr, reason]) {
    expect(text).not.toContain('hunter2-live-value')
    expect(text).not.toContain('fixture-member-7781')
  }
  expect(stdout).toContain('API_TOKEN=[redacted]')
  expect(reason).toContain('[redacted] was refused')
})

test('the output is bounded with the tail kept: the end of a test run is where the failure is', async () => {
  // About 1.5 MiB of passing steps, then the failure.
  const script = [
    "const line = 'step passed ' + 'x'.repeat(1000) + '\\n'",
    "process.stdout.write('FIRST LINE OF THE RUN\\n')",
    'for (let i = 0; i < 1500; i += 1) process.stdout.write(line)',
    "process.stdout.write('LAST LINE: 1 scenario (1 failed)\\n')",
    'process.exitCode = 1',
  ].join('\n')
  const job = await suiteJob(script)

  const { result } = await runJob(job, BOOT)

  expect(result.criteria[0]).toMatchObject({ outcome: 'failed' })
  const stdout = await readFile(checkFile(job, 'stdout.txt'), 'utf8')
  expect(stdout).toContain('LAST LINE: 1 scenario (1 failed)')
  expect(stdout).not.toContain('FIRST LINE OF THE RUN')
  expect(stdout).toMatch(/^\[the start was dropped: only the last 1 MiB is kept\]\n/)
  expect((await stat(checkFile(job, 'stdout.txt'))).size).toBeLessThan(1024 * 1024 + 200)
  expect((result.criteria[0] as { reason?: string }).reason).toContain('LAST LINE: 1 scenario (1 failed)')
})

test('a long value the profile redacts is swept before the reason shortens its line, so no part of it is published', async () => {
  const secret = `fixture-${'k'.repeat(300)}-end`
  const job = await suiteJob(`console.log(${JSON.stringify(`the session cookie was ${secret}`)})\nprocess.exitCode = 1`, { values: [secret] })

  const { result } = await runJob(job, BOOT)

  const reason = (result.criteria[0] as { reason?: string }).reason ?? ''
  expect(reason).toContain('the session cookie was [redacted]')
  expect(reason).not.toContain('kkkk')
  expect(await readFile(checkFile(job, 'suite.txt'), 'utf8')).not.toContain('kkkk')
})

test('the bound is in bytes: a megabyte and a half of three-byte characters is saved as one mebibyte', async () => {
  const script = [
    "const line = '\\u754c'.repeat(1000) + '\\n'",
    'for (let i = 0; i < 600; i += 1) process.stdout.write(line)',
    "process.stdout.write('LAST LINE\\n')",
    'process.exitCode = 1',
  ].join('\n')
  const job = await suiteJob(script)

  await runJob(job, BOOT)

  const stdout = await readFile(checkFile(job, 'stdout.txt'), 'utf8')
  expect((await stat(checkFile(job, 'stdout.txt'))).size).toBeLessThan(1024 * 1024 + 200)
  expect(stdout).toMatch(/^\[the start was dropped: only the last 1 MiB is kept\]\n/)
  expect(stdout.endsWith('LAST LINE\n')).toBe(true)
  // The cut fell inside a line, and the line it fell in is gone: every line kept is whole.
  expect(stdout.split('\n').slice(1, -2).every((line) => line.length === 1000)).toBe(true)
  expect(stdout).not.toContain('\ufffd')
})

test('a cut with no whole line after it keeps nothing: a fragment may be the rest of a secret', async () => {
  const secret = `fixture-${'k'.repeat(300)}-end`
  // One line longer than the bound, with no line break anywhere, ending in a value the profile redacts.
  const script = `process.stdout.write('y'.repeat(1024 * 1024 + 4096 - 150) + ${JSON.stringify(secret)})\nprocess.exitCode = 1`
  const job = await suiteJob(script, { values: [secret] })

  const { result } = await runJob(job, BOOT)

  expect(await readFile(checkFile(job, 'stdout.txt'), 'utf8')).toBe('[the start was dropped: only the last 1 MiB is kept]\n[the kept part held no complete line, so nothing of it is shown]\n')
  expect((result.criteria[0] as { reason?: string }).reason).toBe('suite sign-in exited 1')

  // The same with carriage returns for line ends, as a progress display writes: the whole lines after the cut are kept.
  const carriage = await suiteJob("process.stdout.write('z'.repeat(1024 * 1024 + 4096) + '\\rprogress 99%\\rprogress 100%')\nprocess.exitCode = 1")
  await runJob(carriage, BOOT)
  expect(await readFile(checkFile(carriage, 'stdout.txt'), 'utf8')).toBe('[the start was dropped: only the last 1 MiB is kept]\nprogress 99%\rprogress 100%')
})

test('a suite that could not start still records what there is, and stays unverified', async () => {
  const job = await suiteJob('')
  job.profile = { inline: profileWith('no-such-suite-runner-xyz features') }

  const { result } = await runJob(job, BOOT)

  expect(result.criteria[0]).toMatchObject({ outcome: 'unverified' })
  expect(await readFile(checkFile(job, 'stdout.txt'), 'utf8')).toBe('')
})

test('runSuiteCheck hands back what the suite wrote and what it closed with', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-suite-output-'))
  await writeFile(join(repoPath, 'suite.js'), "console.log('out'); console.error('err'); process.exitCode = 3")

  const outcome = await runSuiteCheck({ name: 'cucumber', command: 'node suite.js' }, { cwd: repoPath })

  expect(outcome).toMatchObject({ outcome: 'failed', reason: 'suite cucumber exited 3', code: 3, stdout: 'out\n', stderr: 'err\n' })
})

// #275: a megabyte of suite output is evidence for people, and far more than a
// verifier turn can read inside its budget.
test('a long stream also gets a bounded end for the verifier, which is pointed at that and not at the whole', async () => {
  const script = [
    "process.stdout.write('FIRST LINE OF THE RUN\\n')",
    "for (let i = 1; i <= 2000; i += 1) process.stdout.write('  step ' + i + ' passed ' + 'x'.repeat(80) + '\\n')",
    "process.stdout.write('4 scenarios (4 passed)\\n')",
    "console.error('one short warning')",
  ].join('\n')
  const job = await suiteJob(script)

  const { result } = await runJob(job, BOOT)

  expect(result.criteria[0]).toMatchObject({ outcome: 'proven' })
  // The whole output is still saved and still listed: it is what a person opens.
  expect(result.criteria[0]?.evidence).toEqual([
    'checks/criterion-1/0/suite.txt',
    'checks/criterion-1/0/stdout.txt',
    'checks/criterion-1/0/stderr.txt',
    'checks/criterion-1/0/stdout.tail.txt',
  ])
  const whole = await readFile(checkFile(job, 'stdout.txt'), 'utf8')
  expect(whole).toContain('FIRST LINE OF THE RUN')
  const tail = await readFile(checkFile(job, 'stdout.tail.txt'), 'utf8')
  expect(SUITE_TAIL_BYTES).toBe(16 * 1024)
  expect(Buffer.byteLength(tail)).toBeLessThan(SUITE_TAIL_BYTES + 300)
  expect(tail).toMatch(/^\[the last 16 KiB of stdout\.txt, which is \d+ bytes: the end of a test run is where its result is\]\n/)
  expect(tail.endsWith('4 scenarios (4 passed)\n')).toBe(true)
  expect(tail).not.toContain('FIRST LINE OF THE RUN')
  // Whole lines only after the note.
  expect(tail.split('\n')[1]).toMatch(/^ {2}step \d+ passed x+$/)
  // A stream inside the bound has no stand-in.
  expect(existsSync(checkFile(job, 'stderr.tail.txt'))).toBe(false)

  // The verifier is handed the bounded end in place of the whole stream.
  const verifier = new FakeAgentRunner([{ status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output: '{"findings":[]}' }])
  await judgeExecuted(result, { texts: { 'criterion-1': 'a member signs in' }, diff: '', verifier })
  const payload = JSON.parse(verifier.requests[0]!.prompt.slice(verifier.requests[0]!.prompt.indexOf('\n\n') + 2)) as { criteria: Array<{ evidence: string[] }> }
  expect(payload.criteria[0]?.evidence).toEqual(['checks/criterion-1/0/suite.txt', 'checks/criterion-1/0/stderr.txt', 'checks/criterion-1/0/stdout.tail.txt'])
})

test('the bounded end is cut from the swept stream, so it holds nothing the whole file does not', async () => {
  const script = [
    "for (let i = 1; i <= 2000; i += 1) process.stdout.write('  step ' + i + ' passed ' + 'x'.repeat(80) + '\\n')",
    "process.stdout.write('signed in as fixture-member-7781 with API_TOKEN=hunter2-live-value\\n')",
  ].join('\n')
  const job = await suiteJob(script, { values: ['fixture-member-7781'] })

  await runJob(job, BOOT)

  const tail = await readFile(checkFile(job, 'stdout.tail.txt'), 'utf8')
  expect(tail).not.toContain('fixture-member-7781')
  expect(tail).not.toContain('hunter2-live-value')
  expect(tail).toContain('signed in as [redacted] with API_TOKEN=[redacted]')
})
