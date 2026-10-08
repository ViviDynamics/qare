import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  DEFAULT_PLAN_CONCURRENCY,
  NareRunnerError,
  PLAN_BATCH_SIZE_ENV,
  PLAN_CONCURRENCY_ENV,
  planConcurrency,
  planRun,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
  type PlanBatchReport,
  type PlanInputs,
} from '../src/index.js'

// #265: the batches of a plan are independent, and with a slow model they
// waited on each other: five one-criterion turns took 944 seconds end to end.
// Whether an endpoint can take several turns at once is the caller's to know,
// so the planner runs as many at a time as the caller says, and one unless told.

const CRITERIA = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, text: `criterion ${id} holds` }))

const INPUTS: PlanInputs = { criteria: CRITERIA, diff: 'diff --git a/login.ts b/login.ts' }

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

/**
 * A runner whose turns end only when the test releases them, so the test
 * decides which turns overlap and which finishes first.
 */
class GatedRunner implements AgentRunner {
  readonly requests: AgentRunRequest[] = []
  /** The first criterion of each turn now waiting, in the order the turns started. */
  readonly waiting: string[] = []
  most = 0
  private readonly gates = new Map<string, (() => void)[]>()
  constructor(private readonly answer: (ids: string[], request: AgentRunRequest) => AgentRunResult) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request)
    const ids = asked(request)
    const key = ids[0] ?? ''
    this.waiting.push(key)
    this.most = Math.max(this.most, this.waiting.length)
    await new Promise<void>((resolve) => {
      this.gates.set(key, [...(this.gates.get(key) ?? []), resolve])
    })
    this.waiting.splice(this.waiting.indexOf(key), 1)
    return this.answer(ids, request)
  }

  /** Ends the waiting turn that asks about this criterion. */
  release(key: string): void {
    const gate = this.gates.get(key)?.shift()
    if (gate === undefined) throw new Error(`no turn for ${key} is waiting (waiting: ${this.waiting.join(', ') || 'none'})`)
    gate()
  }
}

/** Lets every settled promise run its continuations, so the next turns have started. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

let before: Record<string, string | undefined>
beforeEach(() => {
  before = { [PLAN_BATCH_SIZE_ENV]: process.env[PLAN_BATCH_SIZE_ENV], [PLAN_CONCURRENCY_ENV]: process.env[PLAN_CONCURRENCY_ENV] }
  delete process.env[PLAN_BATCH_SIZE_ENV]
  delete process.env[PLAN_CONCURRENCY_ENV]
})
afterEach(() => {
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('the default is one batch at a time, because only the caller knows what its endpoint can take', () => {
  expect(PLAN_CONCURRENCY_ENV).toBe('QARE_PLAN_CONCURRENCY')
  expect(DEFAULT_PLAN_CONCURRENCY).toBe(1)
  expect(planConcurrency({})).toBe(1)
  expect(planConcurrency({ QARE_PLAN_CONCURRENCY: '' })).toBe(1)
  expect(planConcurrency({ QARE_PLAN_CONCURRENCY: ' 3 ' })).toBe(3)
})

test.each(['0', '-1', '2.5', 'all', '2 turns', '9'.repeat(400), '9007199254740993'])('a concurrency of %s is refused by name, never guessed at', (value) => {
  expect(() => planConcurrency({ QARE_PLAN_CONCURRENCY: value })).toThrow(/QARE_PLAN_CONCURRENCY.*whole number/)
})

test('a concurrency that cannot be read stops the plan before any model call', async () => {
  const runner = new GatedRunner((ids) => completed(planFor(ids)))
  process.env[PLAN_CONCURRENCY_ENV] = 'many'
  await expect(planRun(runner, INPUTS)).rejects.toThrow(/QARE_PLAN_CONCURRENCY/)
  await expect(planRun(runner, { ...INPUTS, concurrency: 0 })).rejects.toThrow(/concurrency.*whole number/)
  await expect(planRun(runner, { ...INPUTS, concurrency: 1.5 })).rejects.toThrow(/concurrency.*whole number/)
  expect(runner.requests).toHaveLength(0)
})

test('unset, no batch starts before the one before it has ended', async () => {
  const runner = new GatedRunner((ids) => completed(planFor(ids)))
  const planning = planRun(runner, INPUTS)
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
    await settle()
    expect(runner.waiting).toEqual([id])
    runner.release(id)
  }
  const plan = await planning
  expect(runner.most).toBe(1)
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
})

test('with a concurrency of two, two batches are in flight at once and never three, and a batch that ends makes room for the next', async () => {
  const runner = new GatedRunner((ids) => completed(planFor(ids)))
  const planning = planRun(runner, { ...INPUTS, concurrency: 2 })

  await settle()
  expect(runner.waiting).toEqual(['c1', 'c2'])
  // The later batch ends first: its place is taken by the next one asked.
  runner.release('c2')
  await settle()
  expect(runner.waiting).toEqual(['c1', 'c3'])
  runner.release('c1')
  await settle()
  expect(runner.waiting).toEqual(['c3', 'c4'])
  runner.release('c4')
  await settle()
  expect(runner.waiting).toEqual(['c3', 'c5'])
  runner.release('c5')
  runner.release('c3')

  const plan = await planning
  expect(runner.most).toBe(2)
  expect(runner.requests).toHaveLength(5)
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
})

test('the environment and the caller each set the concurrency, and the caller wins', async () => {
  process.env[PLAN_CONCURRENCY_ENV] = '3'
  const byEnv = new GatedRunner((ids) => completed(planFor(ids)))
  const first = planRun(byEnv, INPUTS)
  await settle()
  expect(byEnv.waiting).toEqual(['c1', 'c2', 'c3'])
  for (const id of ['c1', 'c2', 'c3']) byEnv.release(id)
  await settle()
  for (const id of ['c4', 'c5']) byEnv.release(id)
  await first

  const byCaller = new GatedRunner((ids) => completed(planFor(ids)))
  const second = planRun(byCaller, { ...INPUTS, concurrency: 1 })
  await settle()
  expect(byCaller.waiting).toEqual(['c1'])
  for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
    byCaller.release(id)
    await settle()
  }
  await second
  expect(byCaller.most).toBe(1)
})

test('a concurrency above the number of batches runs them all at once, and no more turns than there are batches', async () => {
  process.env[PLAN_BATCH_SIZE_ENV] = '2'
  const runner = new GatedRunner((ids) => completed(planFor(ids)))
  const planning = planRun(runner, { ...INPUTS, concurrency: 50 })
  await settle()
  expect(runner.waiting).toEqual(['c1', 'c3', 'c5'])
  for (const id of ['c5', 'c3', 'c1']) runner.release(id)
  const plan = await planning
  expect(runner.requests).toHaveLength(3)
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
})

test('whatever order the batches finish in, the plan holds every criterion once in the order asked and its usage is the sum over every batch', async () => {
  const cost: Record<string, number> = { c1: 1, c2: 20, c3: 300, c4: 4000, c5: 50000 }
  const runner = new GatedRunner((ids) => completed(planFor(ids), { inputTokens: cost[ids[0] ?? ''] ?? 0, outputTokens: (cost[ids[0] ?? ''] ?? 0) * 2 }))
  const reports: PlanBatchReport[] = []
  const planning = planRun(runner, { ...INPUTS, concurrency: 5, onBatch: (report) => reports.push(report) })

  await settle()
  expect(runner.waiting).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  for (const id of ['c4', 'c2', 'c5', 'c1', 'c3']) {
    runner.release(id)
    await settle()
  }

  const plan = await planning
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  for (const criterion of plan.criteria) expect(criterion).toMatchObject({ checks: [{ name: `check ${criterion.id}` }] })
  expect(plan.usage).toEqual({ inputTokens: 54321, outputTokens: 108642 })
  // Each batch is reported as it ends, under its own place among the batches.
  expect(reports.map((report) => [report.index, report.of, report.criteria])).toEqual([
    [4, 5, ['c4']],
    [2, 5, ['c2']],
    [5, 5, ['c5']],
    [1, 5, ['c1']],
    [3, 5, ['c3']],
  ])
  expect(reports.find((report) => report.index === 4)?.usage).toEqual({ inputTokens: 4000, outputTokens: 8000 })
})

test('a batch that fails while others are in flight costs only its own criteria, and the others are kept', async () => {
  process.env[PLAN_BATCH_SIZE_ENV] = '2'
  const runner = new GatedRunner((ids) => {
    if (ids[0] === 'c3') return CUT_OFF
    return completed(planFor(ids))
  })
  const reports: PlanBatchReport[] = []
  const planning = planRun(runner, { ...INPUTS, concurrency: 3, onBatch: (report) => reports.push(report) })

  await settle()
  expect(runner.waiting).toEqual(['c1', 'c3', 'c5'])
  // The failing batch ends first, with the two others still waiting on the model.
  runner.release('c3')
  await settle()
  expect(runner.waiting).toEqual(['c1', 'c5'])
  expect(reports.map((report) => [report.index, report.outcome])).toEqual([[2, 'failed']])
  runner.release('c5')
  runner.release('c1')

  const plan = await planning
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  for (const id of ['c1', 'c2', 'c5']) expect(plan.criteria.find((criterion) => criterion.id === id)).toHaveProperty('checks')
  for (const id of ['c3', 'c4']) {
    const lost = plan.criteria.find((criterion) => criterion.id === id) as { unplannable?: string; checks?: unknown }
    expect(lost.checks).toBeUndefined()
    expect(lost.unplannable).toMatch(/^planning failed \(PlanStepError: the planning run did not complete \(stop reason max_tokens/)
  }
  // The lost batch's turn is still counted.
  expect(plan.usage).toEqual({ inputTokens: 300, outputTokens: 16404 })
})

test('a runner that cannot read nare for one batch, and a correction round for another, stay inside their own batches when they overlap', async () => {
  const shell = JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c2', text: 'criterion c2 holds', checks: [{ kind: 'command', name: 'piped', command: 'cat a | grep b' }] }] })
  let c2Turns = 0
  const runner = new GatedRunner((ids) => {
    if (ids[0] === 'c1') throw new NareRunnerError('nare exited 137 without a result line; its output cannot be read as an outcome')
    if (ids[0] === 'c2') return completed((c2Turns += 1) === 1 ? shell : planFor(ids))
    return completed(planFor(ids))
  })
  const planning = planRun(runner, { ...INPUTS, criteria: CRITERIA.slice(0, 3), concurrency: 3 })

  await settle()
  runner.release('c2')
  await settle()
  // The corrected turn of c2 is in flight beside the two first turns.
  expect(runner.waiting).toEqual(['c1', 'c3', 'c2'])
  runner.release('c1')
  runner.release('c2')
  runner.release('c3')

  const plan = await planning
  expect(runner.requests.filter((request) => request.prompt.includes('Your previous answer was rejected')).map(asked)).toEqual([['c2']])
  expect((plan.criteria[0] as { unplannable?: string }).unplannable).toContain('planning failed (NareRunnerError: nare exited 137')
  expect(plan.criteria[1]).toMatchObject({ id: 'c2', checks: [{ name: 'check c2' }] })
  expect(plan.criteria[2]).toMatchObject({ id: 'c3', checks: [{ name: 'check c3' }] })
})

test('when every batch fails at once, the step raises as it does one at a time, naming the first batch asked and not the first to end', async () => {
  const runner = new GatedRunner((ids) => ({ status: 'failed', stopReason: 'error', usage: { inputTokens: 1, outputTokens: 0 }, output: undefined, error: `HTTP 502 for ${ids[0] ?? ''}` }))
  const planning = planRun(runner, { ...INPUTS, criteria: CRITERIA.slice(0, 3), concurrency: 3 })
  const caught = planning.catch((error: unknown) => error)
  await settle()
  for (const id of ['c3', 'c2', 'c1']) {
    runner.release(id)
    await settle()
  }
  const error = (await caught) as Error & { usage?: unknown }
  expect(error.name).toBe('PlanStepError')
  expect(error.message).toMatch(/none of the 3 batches could be planned, the first because .*HTTP 502 for c1/)
  expect(error.usage).toEqual({ inputTokens: 3, outputTokens: 0 })
})

test('an error that is not a planning gap stops new batches, waits for the ones in flight, and surfaces as itself', async () => {
  const runner = new GatedRunner((ids) => {
    if (ids[0] === 'c1') throw new TypeError('a bug in the runner')
    return completed(planFor(ids))
  })
  let settled = false
  const caught = planRun(runner, { ...INPUTS, concurrency: 2 })
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true
    })

  await settle()
  runner.release('c1')
  await settle()
  // No third batch takes the place of the one that threw, and the step has not ended under a turn still running.
  expect(runner.waiting).toEqual(['c2'])
  expect(settled).toBe(false)
  runner.release('c2')
  const error = await caught
  expect(error).toBeInstanceOf(TypeError)
  expect(runner.requests).toHaveLength(2)
})

test('with an exploration channel the batches run one at a time whatever the concurrency, because every turn would steer the same page', async () => {
  const runner = new GatedRunner((ids) => completed(planFor(ids)))
  const planning = planRun(runner, { ...INPUTS, criteria: CRITERIA.slice(0, 3), concurrency: 3, exploration: { endpoint: ['http:', '//127.0.0.1:1'].join('') } })
  for (const id of ['c1', 'c2', 'c3']) {
    await settle()
    // One turn navigates and snapshots at a time: no other turn can move the page under it.
    expect(runner.waiting).toEqual([id])
    runner.release(id)
  }
  const plan = await planning
  expect(runner.most).toBe(1)
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3'])
})

test('a caller whose batch report throws ends the step the same way: after the turn in flight, with no batch started behind it', async () => {
  const runner = new GatedRunner((ids) => completed(planFor(ids)))
  let settled = false
  const caught = planRun(runner, {
    ...INPUTS,
    concurrency: 2,
    onBatch: () => {
      throw new RangeError('the report could not be written')
    },
  })
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true
    })

  await settle()
  runner.release('c1')
  await settle()
  expect(runner.waiting).toEqual(['c2'])
  expect(settled).toBe(false)
  runner.release('c2')
  expect(await caught).toBeInstanceOf(RangeError)
  expect(runner.requests).toHaveLength(2)
})
