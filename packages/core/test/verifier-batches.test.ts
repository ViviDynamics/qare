import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  DEFAULT_VERIFY_BATCH_SIZE,
  MAX_OUTPUT_TOKENS_ENV,
  NareRunnerError,
  VERIFY_BATCH_SIZE_ENV,
  prepareVerifierInputs,
  runVerifier,
  verifierEvidence,
  verifyBatchSize,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type CriterionVerdict,
  type VerifierInputs,
} from '../src/index.js'

// #275: the verifier put every proven criterion to the model in one turn.
// Once a suite's output was evidence (#272) that turn was cut off at the
// default budget, and four criteria the run had proven all came back
// unverified.

const IDS = ['c1', 'c2', 'c3', 'c4']
const VERDICTS: CriterionVerdict[] = IDS.map((criterionId) => ({ criterionId, outcome: 'proven', regression: false, reason: '' }))

function inputs(extra: Partial<VerifierInputs> = {}): VerifierInputs {
  return {
    instructions: 'Judge the evidence.',
    criteria: VERDICTS.map((verdict) => ({ ...verdict })),
    claims: IDS.map((criterionId) => ({ criterionId, text: `criterion ${criterionId} holds`, evidence: [`checks/${criterionId}/0/suite.txt`, `checks/${criterionId}/0/stdout.txt`] })),
    diff: 'diff --git a/app.rb b/app.rb',
    ...extra,
  }
}

/** The criterion ids a verifier request asks about, read from its payload. */
function asked(request: AgentRunRequest): string[] {
  const payload = JSON.parse(request.prompt.slice(request.prompt.indexOf('\n\n') + 2)) as { criteria: Array<{ criterionId: string }> }
  return payload.criteria.map((claim) => claim.criterionId)
}

function answered(findings: unknown[], usage = { inputTokens: 100, outputTokens: 10 }): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage, output: JSON.stringify({ findings }) }
}

const CUT_OFF: AgentRunResult = { status: 'failed', stopReason: 'max_tokens', usage: { inputTokens: 100, outputTokens: 16384 }, output: undefined }

class AnsweringRunner implements AgentRunner {
  readonly requests: AgentRunRequest[] = []
  constructor(private readonly answer: (ids: string[], call: number) => AgentRunResult | Promise<AgentRunResult>) {}
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request)
    return this.answer(asked(request), this.requests.length)
  }
}

let before: Record<string, string | undefined>
beforeEach(() => {
  before = { [VERIFY_BATCH_SIZE_ENV]: process.env[VERIFY_BATCH_SIZE_ENV], [MAX_OUTPUT_TOKENS_ENV]: process.env[MAX_OUTPUT_TOKENS_ENV] }
  delete process.env[VERIFY_BATCH_SIZE_ENV]
  delete process.env[MAX_OUTPUT_TOKENS_ENV]
})
afterEach(() => {
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const outcomes = (verdicts: CriterionVerdict[]): Record<string, string> => Object.fromEntries(verdicts.map((verdict) => [verdict.criterionId, verdict.outcome]))

test('the verifier has a setting of its own, with the default the planner has: one criterion a turn', () => {
  expect(VERIFY_BATCH_SIZE_ENV).toBe('QARE_VERIFY_BATCH_SIZE')
  expect(DEFAULT_VERIFY_BATCH_SIZE).toBe(1)
  expect(verifyBatchSize({})).toBe(1)
  expect(verifyBatchSize({ QARE_VERIFY_BATCH_SIZE: ' 3 ' })).toBe(3)
  // The planner's setting is the planner's: it does not move the verifier.
  expect(verifyBatchSize({ QARE_PLAN_BATCH_SIZE: '5' })).toBe(1)
})

test.each(['0', '-1', '2.5', 'all', '9007199254740993'])('a verifier batch size of %s is refused by name', (value) => {
  expect(() => verifyBatchSize({ QARE_VERIFY_BATCH_SIZE: value })).toThrow(/QARE_VERIFY_BATCH_SIZE.*whole number/)
})

test('four proven criteria are put to the verifier one a turn by default, each turn with only its own claim', async () => {
  const runner = new AnsweringRunner(() => answered([]))

  const { verdicts } = await runVerifier(runner, inputs())

  expect(runner.requests.map(asked)).toEqual([['c1'], ['c2'], ['c3'], ['c4']])
  expect(runner.requests[0]?.prompt).not.toContain('criterion c2 holds')
  expect(outcomes(verdicts)).toEqual({ c1: 'proven', c2: 'proven', c3: 'proven', c4: 'proven' })
  // The verdicts come back in the order they went in.
  expect(verdicts.map((verdict) => verdict.criterionId)).toEqual(IDS)
})

test('the environment and the caller each set the size, and the caller wins', async () => {
  process.env[VERIFY_BATCH_SIZE_ENV] = '3'
  const byEnv = new AnsweringRunner(() => answered([]))
  await runVerifier(byEnv, inputs())
  expect(byEnv.requests.map(asked)).toEqual([['c1', 'c2', 'c3'], ['c4']])

  const byCaller = new AnsweringRunner(() => answered([]))
  await runVerifier(byCaller, inputs({ batchSize: 4 }))
  expect(byCaller.requests.map(asked)).toEqual([IDS])
})

test('a batch that is cut off leaves only its own criteria unverified, with the reason, and the other findings stand', async () => {
  process.env[VERIFY_BATCH_SIZE_ENV] = '2'
  const runner = new AnsweringRunner((ids) => (ids.includes('c1') ? CUT_OFF : answered([{ criterionId: 'c4', problem: 'the output shows the scenario was skipped' }])))

  const { verdicts } = await runVerifier(runner, inputs())

  expect(outcomes(verdicts)).toEqual({ c1: 'unverified', c2: 'unverified', c3: 'proven', c4: 'unverified' })
  const reasons = Object.fromEntries(verdicts.map((verdict) => [verdict.criterionId, verdict.reason]))
  expect(reasons.c1).toMatch(/^verifier did not answer: the run stopped \(max_tokens.*16384 output tokens.*QARE_MAX_OUTPUT_TOKENS/)
  // A turn asked about less also fits its budget, and the reason says so.
  expect(reasons.c1).toContain('QARE_VERIFY_BATCH_SIZE')
  expect(reasons.c2).toBe(reasons.c1)
  expect(reasons.c4).toBe('verifier: the output shows the scenario was skipped')
})

test('a batch whose run errors, one whose runner throws, and one whose answer is not a findings list each cost only their own criteria', async () => {
  const runner = new AnsweringRunner((ids) => {
    if (ids[0] === 'c1') return { status: 'failed', stopReason: 'error', usage: { inputTokens: 5, outputTokens: 0 }, output: undefined, error: 'HTTP 502' }
    if (ids[0] === 'c2') throw new NareRunnerError('nare exited 137 without a result line; its output cannot be read as an outcome')
    if (ids[0] === 'c3') return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 }, output: '{"verdict":"fine"}' }
    return answered([])
  })

  const { verdicts } = await runVerifier(runner, inputs())

  expect(outcomes(verdicts)).toEqual({ c1: 'unverified', c2: 'unverified', c3: 'unverified', c4: 'proven' })
  const reasons = Object.fromEntries(verdicts.map((verdict) => [verdict.criterionId, verdict.reason]))
  expect(reasons.c1).toContain('HTTP 502')
  expect(reasons.c1).not.toContain('QARE_VERIFY_BATCH_SIZE')
  expect(reasons.c2).toContain('nare exited 137')
  expect(reasons.c3).toBe('verifier did not answer: its answer was not a findings list')
})

test("a batch's findings apply only to that batch's criteria: a finding about another batch's criterion is dropped", async () => {
  const runner = new AnsweringRunner((ids) =>
    ids[0] === 'c1'
      ? // Asked about c1 only, the answer goes after c3, and tries to contradict it with c3's own evidence.
        answered([{ criterionId: 'c3', problem: 'not met', kind: 'contradicted', evidence: 'checks/c3/0/stdout.txt' }, { criterionId: 'c9', problem: 'invented' }])
      : answered([]),
  )

  const { verdicts } = await runVerifier(runner, inputs())

  expect(outcomes(verdicts)).toEqual({ c1: 'proven', c2: 'proven', c3: 'proven', c4: 'proven' })
  expect(verdicts).toHaveLength(4)
})

test('a contradiction still fails its criterion when it cites evidence saved for it, in whichever batch it falls', async () => {
  const runner = new AnsweringRunner((ids) =>
    ids[0] === 'c3' ? answered([{ criterionId: 'c3', problem: 'the suite reports the scenario failed', kind: 'contradicted', evidence: 'checks/c3/0/stdout.txt' }]) : answered([]),
  )

  const { verdicts } = await runVerifier(runner, inputs())

  expect(outcomes(verdicts)).toEqual({ c1: 'proven', c2: 'proven', c3: 'failed', c4: 'proven' })
  expect(verdicts[2]?.reason).toBe('verifier: the suite reports the scenario failed (checks/c3/0/stdout.txt)')
})

test('a finding never upgrades a verdict or reaches a criterion that was not proven', async () => {
  const mixed: CriterionVerdict[] = [
    { criterionId: 'c1', outcome: 'failed', regression: false, reason: 'suite sign-in exited 1' },
    { criterionId: 'c2', outcome: 'unverified', regression: false, reason: 'the planner could not plan it' },
    { criterionId: 'c3', outcome: 'proven', regression: false, reason: '' },
  ]
  const prepared = prepareVerifierInputs({ criteria: mixed, texts: { c1: 'one', c2: 'two', c3: 'three' }, evidence: {}, diff: '' })
  const runner = new AnsweringRunner(() => answered([{ criterionId: 'c1', problem: 'looks fine to me' }, { criterionId: 'c2', problem: 'also fine' }]))

  const { verdicts } = await runVerifier(runner, prepared)

  // Only the proven criterion is asked about, in one turn of its own.
  expect(runner.requests.map(asked)).toEqual([['c3']])
  expect(verdicts).toEqual(mixed)
})

test("the verifier's usage is the sum over every batch, the lost ones included", async () => {
  const runner = new AnsweringRunner((ids) => (ids[0] === 'c2' ? CUT_OFF : answered([], { inputTokens: 100, outputTokens: 10 })))

  const { usage } = await runVerifier(runner, inputs())

  expect(usage).toEqual({ inputTokens: 3 * 100 + 100, outputTokens: 3 * 10 + 16384 })
})

test('a batch size that cannot be read leaves every proven criterion unverified, by name, and asks nothing', async () => {
  process.env[VERIFY_BATCH_SIZE_ENV] = 'lots'
  const runner = new AnsweringRunner(() => answered([]))

  const { verdicts } = await runVerifier(runner, inputs())

  expect(runner.requests).toHaveLength(0)
  for (const verdict of verdicts) {
    expect(verdict.outcome).toBe('unverified')
    expect(verdict.reason).toMatch(/verifier did not answer: QARE_VERIFY_BATCH_SIZE is "lots"/)
  }
})

test('with nothing proven there is nothing to ask, whatever the batch size', async () => {
  const runner = new AnsweringRunner(() => answered([]))
  const { verdicts, usage } = await runVerifier(runner, inputs({ claims: [] }))
  expect(runner.requests).toHaveLength(0)
  expect(usage).toBeUndefined()
  expect(verdicts).toHaveLength(4)
})

test('the verifier is pointed at the bounded end of a suite stream when the run saved one, and at the whole stream when it did not', () => {
  expect(
    verifierEvidence([
      'checks/c1/0/suite.txt',
      'checks/c1/0/stdout.txt',
      'checks/c1/0/stderr.txt',
      'checks/c1/0/stdout.tail.txt',
      // A second check of the same criterion, whose output was small: nothing to stand in for it.
      'checks/c1/1/suite.txt',
      'checks/c1/1/stdout.txt',
      'checks/c1/1/stderr.txt',
    ]),
  ).toEqual(['checks/c1/0/suite.txt', 'checks/c1/0/stderr.txt', 'checks/c1/0/stdout.tail.txt', 'checks/c1/1/suite.txt', 'checks/c1/1/stdout.txt', 'checks/c1/1/stderr.txt'])
  // A command check's streams are not a suite's: nothing is dropped without its bounded stand-in.
  expect(verifierEvidence(['checks/c2/0/stdout.txt', 'checks/c2/0/stderr.txt', 'checks/c2/0/command.json'])).toEqual(['checks/c2/0/stdout.txt', 'checks/c2/0/stderr.txt', 'checks/c2/0/command.json'])
})
