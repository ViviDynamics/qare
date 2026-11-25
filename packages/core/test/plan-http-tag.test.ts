import { expect, test } from 'vitest'

import { FakeAgentRunner, PlanStepError, parsePlan, planOutputSchema, planRun, type AgentRunResult, type PlanInputs } from '../src/index.js'

// #423: in four runs on steward the planner never planned an http check, even
// for criteria tagged (http), and planned a whole test file instead, which left
// "/healthz answers 200" and "/portfolio answers 401" unverified. A criterion
// tagged (http) is planned as an http check, or the plan says why not.

const APP = { address: ['http:', '//localhost:{{run.app_port}}'].join('') }
const CRITERIA = [
  { id: 'c1', text: 'A request to `/portfolio` with no session answers status 401 (http)' },
  { id: 'c2', text: 'The ledger tests pass inside the booted QA stack (command)' },
]
const INPUTS: PlanInputs = {
  criteria: CRITERIA,
  diff: 'diff --git a/x b/x',
  app: APP,
  suites: [{ name: 'dashboard', kind: 'flow', command: 'bin/qa-pytest tests/test_web.py' }],
  batchSize: 2,
}

const HTTP = { kind: 'http', name: 'portfolio refused', method: 'GET', path: '/portfolio', expect: { status: 401 } }
const SUITE = { kind: 'flow', name: 'web tests', suite: 'dashboard' }

function completed(first: Record<string, unknown>, second: Record<string, unknown> = { checks: [SUITE] }): AgentRunResult {
  return {
    status: 'completed',
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    output: JSON.stringify({
      schemaVersion: '1',
      criteria: [
        { id: 'c1', text: CRITERIA[0]!.text, ...first },
        { id: 'c2', text: CRITERIA[1]!.text, ...second },
      ],
    }),
  }
}

test('the planner is told that a criterion tagged (http) is planned as an http check, or says why not', async () => {
  const runner = new FakeAgentRunner([completed({ checks: [HTTP] })])

  const plan = await planRun(runner, INPUTS)

  expect(plan.criteria[0]).toMatchObject({ checks: [{ kind: 'http', path: '/portfolio', expect: { status: 401 } }] })
  const prompt = runner.requests[0]?.prompt ?? ''
  expect(prompt).toMatch(/A criterion that ends in \(http\) names an http check as its proof/)
  expect(prompt).toMatch(/"proofNote"/)
  const schema = JSON.parse(runner.requests[0]!.outputSchema) as ReturnType<typeof planOutputSchema>
  expect(schema.properties.criteria.items.properties).toHaveProperty('proofNote')
})

test('a status-code criterion tagged (http) planned with only a suite and no reason is corrected once, then refused', async () => {
  const runner = new FakeAgentRunner([completed({ checks: [SUITE] }), completed({ checks: [HTTP] })])

  const plan = await planRun(runner, INPUTS)

  const correction = runner.requests[1]?.prompt ?? ''
  expect(correction).toContain('Your previous answer was rejected')
  expect(correction).toContain('criterion c1 is tagged (http), but none of its checks is an http check and its proofNote does not say why')
  expect(plan.criteria[0]).toMatchObject({ checks: [HTTP] })

  const stubborn = new FakeAgentRunner([completed({ checks: [SUITE] }), completed({ checks: [SUITE] })])
  await expect(planRun(stubborn, INPUTS)).rejects.toThrow(PlanStepError)
})

test('an (http) criterion planned another way with a reason stands, and the plan carries the reason', async () => {
  const why = 'only a signed-in request shows the owner portfolio, and the run adds no credential'
  const runner = new FakeAgentRunner([completed({ checks: [SUITE], proofNote: why })])

  const plan = await planRun(runner, INPUTS)

  expect(runner.requests).toHaveLength(1)
  expect(plan.criteria[0]).toMatchObject({ checks: [SUITE], proofNote: why })
})

test('an untagged criterion, an unplannable one, or one with nowhere to send a request is not held to an http check', async () => {
  const untagged = new FakeAgentRunner([completed({ checks: [SUITE] })])
  await planRun(untagged, { ...INPUTS, criteria: [{ id: 'c1', text: 'A request to /portfolio answers 401' }, CRITERIA[1]!] })
  expect(untagged.requests).toHaveLength(1)

  const unplannable = new FakeAgentRunner([completed({ unplannable: 'the portfolio page needs a session' })])
  await planRun(unplannable, INPUTS)
  expect(unplannable.requests).toHaveLength(1)

  const nowhere = new FakeAgentRunner([completed({ checks: [SUITE] })])
  await planRun(nowhere, { ...INPUTS, app: undefined })
  expect(nowhere.requests).toHaveLength(1)
})

test('the tag is read from the criterion as asked, so a copy that drops it is still held to an http check', async () => {
  const dropped = new FakeAgentRunner([
    { ...completed({ checks: [SUITE] }), output: JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'A request to /portfolio answers 401', checks: [SUITE] }, { id: 'c2', text: CRITERIA[1]!.text, checks: [SUITE] }] }) },
    completed({ checks: [HTTP] }),
  ])

  await planRun(dropped, INPUTS)

  expect(dropped.requests[1]?.prompt ?? '').toContain('criterion c1 is tagged (http)')
})

test('a proofNote is a non-empty string on a planned criterion', () => {
  const plan = (note: unknown, extra: Record<string, unknown> = { checks: [SUITE] }) => ({
    schemaVersion: '1',
    criteria: [{ id: 'c1', text: 'x (http)', ...extra, proofNote: note }],
  })

  expect(parsePlan(plan('needs a session')).criteria[0]).toMatchObject({ proofNote: 'needs a session' })
  expect(() => parsePlan(plan(''))).toThrow(/proofNote/)
  expect(() => parsePlan(plan(7))).toThrow(/proofNote/)
  expect(() => parsePlan(plan('why', { unplannable: 'no' }))).toThrow(/proofNote/)
})
