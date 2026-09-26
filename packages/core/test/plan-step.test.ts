import { expect, test } from 'vitest'

import {
  FakeAgentRunner,
  PlanStepError,
  planRun,
  type AgentRunResult,
  type PlanInputs,
} from '../src/index.js'

const CRITERIA = [
  { id: 'c1', text: 'the login form rejects an empty password' },
  { id: 'c2', text: 'the dashboard renders on a phone' },
]

const INPUTS: PlanInputs = {
  criteria: CRITERIA,
  diff: 'diff --git a/login.ts b/login.ts',
  suites: ['unit', 'e2e-login'],
}

function planned(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'login unit', command: 'npm test -- login' }] },
      { id: 'c2', text: CRITERIA[1].text, checks: [{ kind: 'visual', name: 'dashboard phone', screenshot: 'dashboard', widths: [390] }] },
    ],
    ...overrides,
  })
}

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

test('a plan comes back parsed, with every criterion covered', async () => {
  const runner = new FakeAgentRunner([completed(planned())])

  const plan = await planRun(runner, INPUTS)

  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2'])
  expect(plan.criteria[0]).toMatchObject({ checks: [{ kind: 'command', command: 'npm test -- login' }] })
})

test('the request carries the criteria, the diff and the available suites', async () => {
  const runner = new FakeAgentRunner([completed(planned())])

  await planRun(runner, INPUTS)

  const [request] = runner.requests
  expect(request.prompt).toContain('the login form rejects an empty password')
  expect(request.prompt).toContain('diff --git a/login.ts')
  expect(request.prompt).toContain('e2e-login')
  expect(request.toolPolicy).toBe('none')
  expect(JSON.parse(request.outputSchema)).toMatchObject({ type: 'object' })
})

test('the schema handed to nare stays inside the subset nare can enforce', async () => {
  // nare refuses a schema using anything outside type, properties, required,
  // items, enum and additionalProperties, at startup. A plan schema built with
  // anyOf would fail every run rather than constrain one.
  const runner = new FakeAgentRunner([completed(planned())])
  await planRun(runner, INPUTS)

  const allowed = new Set(['type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'description', 'title', '$schema'])
  const walkSchema = (schema: Record<string, unknown>): void => {
    for (const key of Object.keys(schema))
      expect(allowed.has(key), `schema keyword ${key} is outside nare's subset`).toBe(true)
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
    for (const sub of Object.values(properties ?? {})) walkSchema(sub)
    if (schema.items) walkSchema(schema.items as Record<string, unknown>)
  }
  walkSchema(JSON.parse(runner.requests[0].outputSchema))
})

test('the schema types flow actions and the prompt names the element vocabulary', async () => {
  const runner = new FakeAgentRunner([completed(planned())])
  await planRun(runner, INPUTS)

  const schema = JSON.parse(runner.requests[0].outputSchema)
  const actions = schema.properties.criteria.items.properties.checks.items.properties.actions
  expect(actions.items.properties.action.enum).toEqual(['open', 'type', 'click', 'assert', 'totp', 'backupCode'])
  expect(actions.items.properties.element).toMatchObject({ type: 'object' })

  const [request] = runner.requests
  expect(request.prompt).toContain('Never a CSS selector')
  expect(request.prompt).toContain('testId')
})

test('an unplannable criterion is kept, with its reason', async () => {
  const runner = new FakeAgentRunner([
    completed(
      JSON.stringify({
        schemaVersion: '1',
        criteria: [
          { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'x', command: 'npm test' }] },
          { id: 'c2', text: CRITERIA[1].text, unplannable: 'no visual baseline exists for the dashboard' },
        ],
      }),
    ),
  ])

  const plan = await planRun(runner, INPUTS)

  expect(plan.criteria[1]).toEqual({ id: 'c2', text: CRITERIA[1].text, unplannable: 'no visual baseline exists for the dashboard' })
})

test('a criterion the model dropped is a failure, not a smaller plan', async () => {
  // Silently planning half the criteria would let a run pass while nothing
  // ever checked the rest.
  const half = JSON.stringify({
    schemaVersion: '1',
    criteria: [{ id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'x', command: 'npm test' }] }],
  })
  const runner = new FakeAgentRunner([completed(half), completed(half)])

  await expect(planRun(runner, INPUTS)).rejects.toThrow(/c2/)
})

test('a dropped criterion is reprompted once, and a corrected plan is accepted', async () => {
  const half = JSON.stringify({
    schemaVersion: '1',
    criteria: [{ id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'x', command: 'npm test' }] }],
  })
  const runner = new FakeAgentRunner([completed(half), completed(planned())])

  const plan = await planRun(runner, INPUTS)

  expect(plan.criteria).toHaveLength(2)
  expect(runner.requests).toHaveLength(2)
  expect(runner.requests[1].prompt).toContain('c2')
})

test('a criterion the model invented is refused', async () => {
  const invented = JSON.stringify({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'x', command: 'npm test' }] },
      { id: 'c2', text: CRITERIA[1].text, checks: [{ kind: 'command', name: 'y', command: 'npm test' }] },
      { id: 'c9', text: 'something nobody asked for', checks: [{ kind: 'command', name: 'z', command: 'npm test' }] },
    ],
  })
  const runner = new FakeAgentRunner([completed(invented), completed(invented)])

  await expect(planRun(runner, INPUTS)).rejects.toThrow(/c9/)
})

test('a plan that does not parse is reprompted with the parser error', async () => {
  const bad = JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'x', checks: [] }] })
  const runner = new FakeAgentRunner([completed(bad), completed(planned())])

  const plan = await planRun(runner, INPUTS)

  expect(plan.criteria).toHaveLength(2)
  expect(runner.requests[1].prompt).toContain('zero checks')
})

test('a second unparseable plan fails loudly', async () => {
  const bad = JSON.stringify({ schemaVersion: '1', criteria: [] })
  const runner = new FakeAgentRunner([completed(bad), completed(bad)])

  await expect(planRun(runner, INPUTS)).rejects.toThrow(PlanStepError)
})

test('a failed run is never turned into a plan', async () => {
  const runner = new FakeAgentRunner([
    { status: 'failed', stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 1 }, output: undefined },
  ])

  await expect(planRun(runner, INPUTS)).rejects.toThrow(/max_tokens|failed/)
})

test('planning nothing is refused before a model is called', async () => {
  const runner = new FakeAgentRunner([completed(planned())])

  await expect(planRun(runner, { ...INPUTS, criteria: [] })).rejects.toThrow(/no criteria/i)
  expect(runner.requests).toHaveLength(0)
})
