import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  FakeAgentRunner,
  PlanStepError,
  planRun,
  runJob,
  type AgentRunResult,
  type Job,
  type PlanInputs,
  type QaProfile,
} from '../src/index.js'

// #262: on two pull requests the planner wrote a grep whose pattern was
// several words, such as `grep -n A flow addresses the booted app docs/SPEC.md`.
// With no shell the pattern was `A` and the other words were files. grep
// exited 2, and the criterion was recorded failed, though nothing about the
// change had been disproven.

const CRITERIA = [{ id: 'c1', text: 'docs/SPEC.md documents how a flow addresses the booted app' }]

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

function planWith(command: string): string {
  return JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c1', text: CRITERIA[0]!.text, checks: [{ kind: 'command', name: 'spec says so', command }] }] })
}

/** A checkout with the files a grep may be pointed at. */
async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qare-grep-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'packages', 'core', 'src'), { recursive: true })
  await writeFile(join(root, 'docs', 'SPEC.md'), 'A flow addresses the booted app in one of two ways.\n')
  await writeFile(join(root, 'packages', 'core', 'src', 'runner.ts'), 'export const x = 1\n')
  await writeFile(join(root, 'exits-two.js'), 'process.exitCode = 2\n')
  return root
}

const SOURCE = { source: { run: 'grep -n -- {{pattern}} {{path}}', about: 'asserts that the file {{path}} carries {{pattern}}' } }

const MULTI_WORD = 'grep -n A flow addresses the booted app docs/SPEC.md'

async function inputs(extra: Partial<PlanInputs> = {}): Promise<PlanInputs> {
  return { criteria: CRITERIA, diff: 'diff --git a/docs/SPEC.md b/docs/SPEC.md', repoPath: await checkout(), ...extra }
}

test('a grep whose pattern is several words is corrected at the plan step, naming the word grep would read as a file', async () => {
  const runner = new FakeAgentRunner([completed(planWith(MULTI_WORD)), completed(planWith('grep -n addresses.the.booted.app docs/SPEC.md'))])

  const plan = await planRun(runner, await inputs())

  expect(runner.requests).toHaveLength(2)
  const correction = runner.requests[1]?.prompt ?? ''
  expect(correction).toContain('Your previous answer was rejected')
  expect(correction).toContain('criterion c1 command check "spec says so"')
  expect(correction).toContain('grep would read "flow" as a file')
  expect(correction).toMatch(/pattern is one token/)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command: 'grep -n addresses.the.booted.app docs/SPEC.md' }] })
})

test('a plan that still holds the several-word grep after its correction is refused', async () => {
  const runner = new FakeAgentRunner([completed(planWith(MULTI_WORD)), completed(planWith(MULTI_WORD))])

  const error = await planRun(runner, await inputs()).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(PlanStepError)
  expect(String(error)).toContain('grep would read "flow" as a file')
})

test.each([
  ['one pattern and one file', 'grep -n addresses docs/SPEC.md'],
  ['options before the pattern, and after --', 'grep -c -i -- addresses docs/SPEC.md'],
  ['an option that takes a value', 'grep -m 1 addresses docs/SPEC.md'],
  ['a pattern given with -e, so every other argument is a file', 'grep -n -e addresses docs/SPEC.md packages/core/src/runner.ts'],
  ['a directory searched recursively', 'grep -rn addresses docs'],
  ['no file at all', 'grep -rn addresses'],
  ['a value attached to its option', 'grep -m1 -A2 addresses docs/SPEC.md'],
  ['a pattern attached to -e in a cluster', 'grep -neaddresses docs/SPEC.md'],
  ['long options that carry their value', 'grep --max-count=1 --regexp=addresses docs/SPEC.md'],
  ['a long option whose value is the next token', 'grep --max-count 1 addresses docs/SPEC.md'],
  ['a run value in the pattern', 'grep -n {{run.id}} docs/SPEC.md'],
])('a grep with %s is left alone', async (_label, command) => {
  const runner = new FakeAgentRunner([completed(planWith(command))])

  const plan = await planRun(runner, await inputs())

  expect(runner.requests).toHaveLength(1)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command }] })
})

test.each([
  ['-e with its pattern attached, so every operand is a file', 'grep -eA flow docs/SPEC.md', '"flow"'],
  ['-e at the end of a cluster, so the next token is the pattern', 'grep -ne A flow docs/SPEC.md', '"flow"'],
  ['a value option in a cluster, whose value is the next token', 'grep -nm 1 A flow docs/SPEC.md', '"flow"'],
  ['--regexp= carrying the pattern', 'grep --regexp=A flow docs/SPEC.md', '"flow"'],
  ['a run value where a file should be', 'grep -n addresses {{run.target_url}}', '"{{run.target_url}}"'],
])('a grep with %s is corrected: grep would open the word as a file', async (_label, command, word) => {
  const runner = new FakeAgentRunner([completed(planWith(command)), completed(planWith('grep -n addresses docs/SPEC.md'))])

  await planRun(runner, await inputs())

  expect(runner.requests).toHaveLength(2)
  expect(runner.requests[1]?.prompt).toContain(`grep would read ${word} as a file`)
})

test('a file the change adds is not in the plan step\'s checkout, and a grep that reads it is still planned', async () => {
  // The plan step runs at the base revision: the declared run inputs are how it knows what the head will carry.
  const command = 'grep -n flowOpenUrl packages/core/src/app-address.ts'
  const runner = new FakeAgentRunner([completed(planWith(command))])

  const plan = await planRun(runner, await inputs({ runInputs: { paths: ['.qa', 'packages/core/src/app-address.ts'] } }))

  expect(runner.requests).toHaveLength(1)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command }] })
})

test('where the profile declares a grep command, a planned grep is held to its form', async () => {
  // The profile's form takes one pattern token and one path: no other shape of grep is run.
  const wrong = new FakeAgentRunner([completed(planWith(MULTI_WORD)), completed(planWith('grep -n -- addresses docs/SPEC.md'))])
  const plan = await planRun(wrong, await inputs({ commands: SOURCE }))
  expect(wrong.requests).toHaveLength(2)
  const correction = wrong.requests[1]?.prompt ?? ''
  expect(correction).toContain('the profile declares grep as the command source (grep -n -- {{pattern}} {{path}})')
  expect(correction).toMatch(/each placeholder takes exactly one token/)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command: 'grep -n -- addresses docs/SPEC.md' }] })

  // A grep in another shape is corrected too, even when every file it names is there.
  const other = new FakeAgentRunner([completed(planWith('grep -n addresses docs/SPEC.md')), completed(planWith('grep -n -- addresses docs/SPEC.md'))])
  await planRun(other, await inputs({ commands: SOURCE }))
  expect(other.requests).toHaveLength(2)

  // And a program the profile declares that is not grep is not held to anything new.
  const node = new FakeAgentRunner([completed(planWith('node --version'))])
  await planRun(node, await inputs({ commands: { script: { run: 'node -- {{path}}', about: 'runs a script' } } }))
  expect(node.requests).toHaveLength(1)
})

// #270, docs/decisions/adr-0007: a declared command is a form the planner
// should prefer, not the only form its program may be planned in. grep alone
// is held to its declared form, for a reason that is grep's own. To reverse
// the decision, this is the test that changes.
test.each([
  ['node', 'node -- {{path}}', 'node --version'],
  ['python3', 'python3 -- {{path}}', 'python3 --version'],
  ['test', 'test -f {{path}}', 'test 1 -eq 1'],
])('a standard tool the profile also declares may be planned in another form: %s', async (_program, declared, planned) => {
  const runner = new FakeAgentRunner([completed(planWith(planned))])

  const plan = await planRun(runner, await inputs({ commands: { declared: { run: declared, about: 'the form the profile knows to work' } } }))

  // Accepted as written, with no correction round.
  expect(runner.requests).toHaveLength(1)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command: planned }] })
  // The planner is still shown the declared form, so it can prefer it.
  expect(runner.requests[0]?.prompt).toContain(declared)
})

test('a declared command that names a file the change adds is planned, not refused for a file the base lacks', async () => {
  const command = 'grep -n -- flowOpenUrl packages/core/src/app-address.ts'
  const runner = new FakeAgentRunner([completed(planWith(command))])

  const plan = await planRun(runner, await inputs({ commands: { source: { run: 'grep -n -- {{pattern}} {{path}}', about: 'asserts {{path}} carries {{pattern}}' } }, runInputs: { paths: ['.qa', 'packages/core/src/app-address.ts'] } }))

  expect(runner.requests).toHaveLength(1)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command }] })
})

test('the planner is told a pattern is one token, and not to run a source that is not built', async () => {
  const runner = new FakeAgentRunner([completed(planWith('grep -n addresses docs/SPEC.md'))])

  await planRun(runner, await inputs({ runInputs: { paths: ['docs/SPEC.md'] } }))

  const prompt = runner.requests[0]?.prompt ?? ''
  expect(prompt).toMatch(/grep takes its pattern as one token/)
  expect(prompt).toMatch(/TypeScript source/)
  expect(prompt).toMatch(/nothing is built/)
})

// What the run records, with the real grep.

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')
const PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'true' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  suites: [],
  visual: { widths: [], themes: [] },
}
const BOOT = { runCompose: async () => ({ code: 0, stdout: '', stderr: '' }), probe: async () => ({ ok: true }), pollIntervalMs: 1 }

async function jobFor(...runs: string[]): Promise<Job> {
  const repoPath = await checkout()
  return {
    id: 'job-grep',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: { inline: PROFILE },
    criteria: runs.map((run, index) => ({ id: `criterion-${index + 1}`, text: `criterion ${index + 1}`, checks: [{ kind: 'command' as const, run }] })),
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

test('a grep that could not read what it was given leaves its criterion unverified, with grep\'s own words, never failed', async () => {
  const job = await jobFor(MULTI_WORD)

  const { result } = await runJob(job, BOOT)

  expect(result.verdict).not.toBe('failed')
  expect(result.criteria[0]).toMatchObject({ id: 'criterion-1', outcome: 'unverified' })
  const reason = (result.criteria[0] as { reason?: string }).reason ?? ''
  expect(reason).toMatch(/grep exited 2/)
  expect(reason).toMatch(/not "no match"/)
  expect(reason).toContain('grep: flow: No such file or directory')
  // The record still says what ran and what it closed with.
  const record = JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'command.json'), 'utf8')) as Record<string, unknown>
  expect(record).toMatchObject({ command: MULTI_WORD, outcome: 'unverified', exit_code: 2 })
  expect(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'stderr.txt'), 'utf8')).toContain('grep: flow: No such file or directory')
})

test('a grep that looked and found nothing still fails its criterion: exit 1 is an answer', async () => {
  const job = await jobFor('grep -n absent-from-the-spec docs/SPEC.md', 'grep -n addresses docs/SPEC.md')

  const { result } = await runJob(job, BOOT)

  expect(result.verdict).toBe('failed')
  expect(result.criteria[0]).toMatchObject({ id: 'criterion-1', outcome: 'failed' })
  expect(result.criteria[1]).toMatchObject({ id: 'criterion-2', outcome: 'proven' })
})

test('only grep is read this way: another program that exits 2 still fails its criterion', async () => {
  const job = await jobFor('node exits-two.js')

  const { result } = await runJob(job, BOOT)

  expect(result.criteria[0]).toMatchObject({ outcome: 'failed' })
})
