import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  DEFAULT_PLAN_BATCH_SIZE,
  MAX_OUTPUT_TOKENS_ENV,
  NareRunnerError,
  PLAN_BATCH_SIZE_ENV,
  PlanStepError,
  planBatchSize,
  planRun,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type PlanBatchReport,
  type PlanInputs,
} from '../src/index.js'

// #259: the planner asked for the whole plan in one turn. With a slow
// reasoning model that turn took fifteen minutes for five criteria and was
// cut off at the default budget, and the cut-off lost every criterion,
// the ones the model had already worked out included.

const CRITERIA = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, text: `criterion ${id} holds` }))

const INPUTS: PlanInputs = { criteria: CRITERIA, diff: 'diff --git a/login.ts b/login.ts' }

/** The ids a request asks about, read from the prompt's own criteria list. */
function asked(request: AgentRunRequest): string[] {
  const list = request.prompt.split('Criteria:\n')[1]?.split('\n\n')[0] ?? ''
  return [...list.matchAll(/^- (c\d+): /gm)].map((match) => match[1] ?? '')
}

function planFor(ids: string[]): string {
  return JSON.stringify({
    schemaVersion: '1',
    criteria: ids.map((id) => ({ id, text: `criterion ${id} holds`, checks: [{ kind: 'command', name: `check ${id}`, command: 'node --version' }] })),
  })
}

function completed(output: string, usage = { inputTokens: 100, outputTokens: 10 }): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage, output }
}

const CUT_OFF: AgentRunResult = { status: 'failed', stopReason: 'max_tokens', usage: { inputTokens: 100, outputTokens: 16384 }, output: undefined }

/** A runner that answers each request from what it asks, so batches need no script order. */
class AnsweringRunner implements AgentRunner {
  readonly requests: AgentRunRequest[] = []
  constructor(private readonly answer: (ids: string[], call: number, request: AgentRunRequest) => AgentRunResult | Promise<AgentRunResult>) {}
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request)
    return this.answer(asked(request), this.requests.length, request)
  }
}

let before: Record<string, string | undefined>
beforeEach(() => {
  before = { [PLAN_BATCH_SIZE_ENV]: process.env[PLAN_BATCH_SIZE_ENV], [MAX_OUTPUT_TOKENS_ENV]: process.env[MAX_OUTPUT_TOKENS_ENV] }
  delete process.env[PLAN_BATCH_SIZE_ENV]
  delete process.env[MAX_OUTPUT_TOKENS_ENV]
})
afterEach(() => {
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('the default is one criterion a turn, the size the slow model is known to fit in the default budget', () => {
  expect(PLAN_BATCH_SIZE_ENV).toBe('QARE_PLAN_BATCH_SIZE')
  expect(DEFAULT_PLAN_BATCH_SIZE).toBe(1)
  expect(planBatchSize({})).toBe(1)
  expect(planBatchSize({ QARE_PLAN_BATCH_SIZE: '' })).toBe(1)
  expect(planBatchSize({ QARE_PLAN_BATCH_SIZE: ' 3 ' })).toBe(3)
})

test.each(['0', '-1', '2.5', 'all', '3 criteria', '9'.repeat(400), '9007199254740993'])('a batch size of %s is refused by name, never guessed at', (value) => {
  expect(() => planBatchSize({ QARE_PLAN_BATCH_SIZE: value })).toThrow(/QARE_PLAN_BATCH_SIZE.*whole number/)
})

test('a batch size the environment cannot name stops the plan before any model call', async () => {
  process.env[PLAN_BATCH_SIZE_ENV] = 'lots'
  const runner = new AnsweringRunner((ids) => completed(planFor(ids)))
  await expect(planRun(runner, INPUTS)).rejects.toThrow(/QARE_PLAN_BATCH_SIZE/)
  expect(runner.requests).toHaveLength(0)
  await expect(planRun(runner, { ...INPUTS, batchSize: 0 })).rejects.toThrow(/batch size.*whole number/)
  expect(runner.requests).toHaveLength(0)
})

test('five criteria are planned one a turn by default, and merged with each present exactly once, in the order asked', async () => {
  const runner = new AnsweringRunner((ids) => completed(planFor(ids)))

  const plan = await planRun(runner, INPUTS)

  expect(runner.requests.map(asked)).toEqual([['c1'], ['c2'], ['c3'], ['c4'], ['c5']])
  expect(plan.schemaVersion).toBe('1')
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  for (const criterion of plan.criteria) expect(criterion).toMatchObject({ checks: [{ name: `check ${criterion.id}` }] })
  // A turn is asked only about its own criteria: the others are not in its prompt at all.
  expect(runner.requests[0]?.prompt).not.toContain('criterion c2 holds')
})

test('the environment and the caller each set the size, and the caller wins', async () => {
  process.env[PLAN_BATCH_SIZE_ENV] = '2'
  const byEnv = new AnsweringRunner((ids) => completed(planFor(ids)))
  await planRun(byEnv, INPUTS)
  expect(byEnv.requests.map(asked)).toEqual([['c1', 'c2'], ['c3', 'c4'], ['c5']])

  const byCaller = new AnsweringRunner((ids) => completed(planFor(ids)))
  const plan = await planRun(byCaller, { ...INPUTS, batchSize: 5 })
  expect(byCaller.requests.map(asked)).toEqual([['c1', 'c2', 'c3', 'c4', 'c5']])
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])

  const larger = new AnsweringRunner((ids) => completed(planFor(ids)))
  await planRun(larger, { ...INPUTS, batchSize: 50 })
  expect(larger.requests).toHaveLength(1)
})

test('a batch that is cut off marks only its own criteria unplannable, with the reason, and the others are kept', async () => {
  process.env[PLAN_BATCH_SIZE_ENV] = '2'
  const runner = new AnsweringRunner((ids) => (ids.includes('c3') ? CUT_OFF : completed(planFor(ids))))
  const reports: PlanBatchReport[] = []

  const plan = await planRun(runner, { ...INPUTS, onBatch: (report) => reports.push(report) })

  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  for (const id of ['c1', 'c2', 'c5']) expect(plan.criteria.find((criterion) => criterion.id === id)).toHaveProperty('checks')
  for (const id of ['c3', 'c4']) {
    const lost = plan.criteria.find((criterion) => criterion.id === id) as { text: string; unplannable?: string; checks?: unknown }
    expect(lost.checks).toBeUndefined()
    expect(lost.text).toBe(`criterion ${id} holds`)
    expect(lost.unplannable).toMatch(/^planning failed \(PlanStepError: the planning run did not complete \(stop reason max_tokens.*16384 output tokens.*QARE_MAX_OUTPUT_TOKENS/)
    // A cut-off turn is cured by a smaller batch as well as a larger budget, and the reason says so.
    expect(lost.unplannable).toContain('QARE_PLAN_BATCH_SIZE')
  }
  expect(reports.map((report) => [report.index, report.of, report.criteria, report.outcome])).toEqual([
    [1, 3, ['c1', 'c2'], 'planned'],
    [2, 3, ['c3', 'c4'], 'failed'],
    [3, 3, ['c5'], 'planned'],
  ])
  expect(reports[1]?.reason).toContain('max_tokens')
})

test('a batch whose run errors, and one whose runner cannot read nare, each cost only their own criteria', async () => {
  const errored: AgentRunResult = { status: 'failed', stopReason: 'error', usage: { inputTokens: 5, outputTokens: 0 }, output: undefined, error: 'HTTP 502' }
  const runner = new AnsweringRunner((ids) => {
    if (ids[0] === 'c2') return errored
    if (ids[0] === 'c4') throw new NareRunnerError('nare exited 137 without a result line; its output cannot be read as an outcome')
    return completed(planFor(ids))
  })

  const plan = await planRun(runner, INPUTS)

  const reasons = Object.fromEntries(plan.criteria.map((criterion) => [criterion.id, 'unplannable' in criterion ? criterion.unplannable : undefined]))
  expect(reasons.c1).toBeUndefined()
  expect(reasons.c2).toContain('HTTP 502')
  expect(reasons.c2).not.toContain('QARE_PLAN_BATCH_SIZE')
  expect(reasons.c3).toBeUndefined()
  expect(reasons.c4).toContain('planning failed (NareRunnerError: nare exited 137')
  expect(reasons.c5).toBeUndefined()
})

test('a batch refused after its one correction round costs only its own criteria, and each batch gets its own round', async () => {
  const shell = (id: string): string =>
    JSON.stringify({ schemaVersion: '1', criteria: [{ id, text: `criterion ${id} holds`, checks: [{ kind: 'command', name: 'piped', command: 'cat a | grep b' }] }] })
  let c4Calls = 0
  const runner = new AnsweringRunner((ids) => {
    // c2 never recovers; c4 is wrong once and right after its correction.
    if (ids[0] === 'c2') return completed(shell('c2'))
    if (ids[0] === 'c4') return completed((c4Calls += 1) === 1 ? shell('c4') : planFor(['c4']))
    return completed(planFor(ids))
  })

  const plan = await planRun(runner, INPUTS)

  expect(runner.requests.map(asked)).toEqual([['c1'], ['c2'], ['c2'], ['c3'], ['c4'], ['c4'], ['c5']])
  expect(runner.requests[2]?.prompt).toContain('Your previous answer was rejected')
  expect(runner.requests[3]?.prompt).not.toContain('Your previous answer was rejected')
  const c2 = plan.criteria[1] as { unplannable?: string }
  expect(c2.unplannable).toMatch(/planning failed \(PlanStepError: the model could not produce a usable plan: criterion c2 command check "piped"/)
  expect(plan.criteria[3]).toMatchObject({ id: 'c4', checks: [{ name: 'check c4' }] })
})

test('a batch that answers for a criterion of another batch is corrected, so nothing is planned twice', async () => {
  let calls = 0
  const runner = new AnsweringRunner((ids) => {
    calls += 1
    return completed(ids[0] === 'c2' && calls === 2 ? planFor(['c2', 'c1']) : planFor(ids))
  })

  const plan = await planRun(runner, { ...INPUTS, criteria: CRITERIA.slice(0, 2) })

  expect(runner.requests[2]?.prompt).toContain('it invented c1')
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2'])
})

test("the plan's usage is the sum over every batch: the planned, the corrected and the lost", async () => {
  const runner = new AnsweringRunner((ids, call) => {
    if (ids[0] === 'c2') return CUT_OFF
    if (ids[0] === 'c3' && call === 3) return completed('{"not":"a plan"}', { inputTokens: 7, outputTokens: 3 })
    return completed(planFor(ids))
  })

  const plan = await planRun(runner, INPUTS)

  // c1, c3 (second try), c4, c5: 100/10 each. c2 cut off: 100/16384. c3's rejected first try: 7/3.
  expect(runner.requests).toHaveLength(6)
  expect(plan.usage).toEqual({ inputTokens: 4 * 100 + 100 + 7, outputTokens: 4 * 10 + 16384 + 3 })
})

test('when no batch can be planned the step still fails closed, carrying what the attempts cost', async () => {
  const several = new AnsweringRunner(() => CUT_OFF)
  const error = (await planRun(several, { ...INPUTS, criteria: CRITERIA.slice(0, 3) }).catch((caught: unknown) => caught)) as PlanStepError
  expect(error).toBeInstanceOf(PlanStepError)
  expect(error.message).toMatch(/none of the 3 batches could be planned.*max_tokens/)
  expect(error.usage).toEqual({ inputTokens: 300, outputTokens: 3 * 16384 })

  // One batch is the plan step as it always was: its own error, unchanged.
  const single = new AnsweringRunner(() => CUT_OFF)
  const alone = (await planRun(single, { ...INPUTS, batchSize: 5 }).catch((caught: unknown) => caught)) as PlanStepError
  expect(alone).toBeInstanceOf(PlanStepError)
  expect(alone.message).toMatch(/^the planning run did not complete \(stop reason max_tokens/)
  expect(alone.usage).toEqual({ inputTokens: 100, outputTokens: 16384 })

  // A runner that cannot run at all is not a planning gap: its own error surfaces.
  const broken = new AnsweringRunner(() => {
    throw new NareRunnerError('nare exited 127 without a result line; its output cannot be read as an outcome')
  })
  await expect(planRun(broken, INPUTS)).rejects.toBeInstanceOf(NareRunnerError)
})

test('criteria that share an id are refused before any model call: a merged plan could not hold each exactly once', async () => {
  const runner = new AnsweringRunner((ids) => completed(planFor(ids)))
  await expect(planRun(runner, { ...INPUTS, criteria: [CRITERIA[0]!, CRITERIA[1]!, CRITERIA[0]!] })).rejects.toThrow(/c1.*more than once/)
  expect(runner.requests).toHaveLength(0)
})
