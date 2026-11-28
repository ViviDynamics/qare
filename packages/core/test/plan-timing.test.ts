import { expect, test } from 'vitest'
import { FakeAgentRunner, parsePlan, planRun, type AgentRunResult, type PlanInputs } from '../src/index.js'

// #418: the plan job took 12 to 25 minutes for four criteria on the website
// pilot, and nothing in the run said where the time went.

function completed(output: string, turns?: number): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, output, ...(turns === undefined ? {} : { turns }) }
}

const answer = (id: string, text: string): string =>
  JSON.stringify({ schemaVersion: '1', criteria: [{ id, text, checks: [{ kind: 'command', name: 'lint', command: 'npm run lint' }] }] })

const INPUTS: PlanInputs = {
  criteria: [
    { id: 'c1', text: 'lint passes' },
    { id: 'c2', text: 'lint still passes' },
  ],
  diff: 'diff --git a/a b/a',
  commands: { lint: { run: 'npm run lint' } },
  batchSize: 1,
  concurrency: 1,
}

/** A clock that moves only when a turn is taken, by the seconds each turn is told to take. */
function clock(seconds: number[]): { now: () => number; runner: (results: AgentRunResult[]) => FakeAgentRunner } {
  let at = 0
  let turn = 0
  return {
    now: () => at,
    runner: (results) => {
      const fake = new FakeAgentRunner(results)
      const run = fake.run.bind(fake)
      fake.run = async (request) => {
        at += (seconds[turn] ?? 0) * 1000
        turn += 1
        return run(request)
      }
      return fake
    },
  }
}

test('the plan records each batch\'s time and model turns, its correction round included (#418)', async () => {
  const time = clock([30, 200, 45])
  const runner = time.runner([
    completed(answer('c1', 'lint passes'), 3),
    // The first answer for c2 names no check, so it is corrected once.
    completed(JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c2', text: 'lint still passes', checks: [] }] }), 6),
    completed(answer('c2', 'lint still passes'), 2),
  ])

  const plan = await planRun(runner, { ...INPUTS, now: time.now })

  expect(plan.timing).toEqual([
    { criteria: ['c1'], outcome: 'planned', durationMs: 30_000, turns: 3 },
    { criteria: ['c2'], outcome: 'planned', durationMs: 245_000, turns: 8 },
  ])
})

test('a runner that counts no turns counts each run as one (#418)', async () => {
  const time = clock([10])
  const plan = await planRun(time.runner([completed(answer('c1', 'lint passes'))]), { ...INPUTS, criteria: [INPUTS.criteria[0]!], now: time.now })

  expect(plan.timing).toEqual([{ criteria: ['c1'], outcome: 'planned', durationMs: 10_000, turns: 1 }])
})

test('a batch that could not be planned keeps its time too (#418)', async () => {
  const time = clock([5, 7, 9])
  const runner = time.runner([
    completed(answer('c1', 'lint passes'), 1),
    { status: 'failed', stopReason: 'error', usage: { inputTokens: 1, outputTokens: 0 }, output: undefined, error: 'HTTP 524', turns: 2 },
  ])

  const plan = await planRun(runner, { ...INPUTS, now: time.now })

  expect(plan.timing?.[1]).toEqual({ criteria: ['c2'], outcome: 'failed', durationMs: 7_000, turns: 2 })
})

test('a plan loads with its timing, and refuses one that is not a record of batches (#418)', () => {
  const base = { schemaVersion: '1', criteria: [{ id: 'c1', text: 'x', unplannable: 'no' }] }
  const timing = [{ criteria: ['c1'], outcome: 'planned', durationMs: 1200, turns: 2 }]
  expect(parsePlan({ ...base, timing }).timing).toEqual(timing)
  expect(() => parsePlan({ ...base, timing: [{ criteria: ['c1'], outcome: 'planned', durationMs: -1, turns: 2 }] })).toThrow(/timing/)
  expect(() => parsePlan({ ...base, timing: 'slow' })).toThrow(/timing/)
})
