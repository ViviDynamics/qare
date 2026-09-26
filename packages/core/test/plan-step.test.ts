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

test('the flow action kinds the change introduces widen the schema and the prompt', async () => {
  const runner = new FakeAgentRunner([completed(planned())])

  await planRun(runner, { ...INPUTS, flowActions: ['magicLink'] })

  const [request] = runner.requests
  expect(request.prompt).toContain('A flow action is one of open, type, click, assert, totp, backupCode, magicLink')
  const schema = JSON.parse(request.outputSchema)
  const kinds =
    schema.properties.criteria.items.properties.checks.items.properties.actions.items.properties.action.enum
  expect(kinds).toContain('magicLink')
  expect(kinds).toContain('totp')
})

test('an answer written in the change\'s declared vocabulary is accepted', async () => {
  const answer = JSON.stringify({
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0].text,
        checks: [{ kind: 'flow', name: 'totp login', actions: [{ action: 'magicLink', element: { testId: 'sign-in' } }] }],
      },
      { id: 'c2', text: CRITERIA[1].text, checks: [{ kind: 'visual', name: 'dashboard phone', screenshot: 'dashboard', widths: [390] }] },
    ],
  })
  const runner = new FakeAgentRunner([completed(answer)])

  const plan = await planRun(runner, { ...INPUTS, flowActions: ['magicLink'] })

  expect(plan.criteria[0]).toMatchObject({ checks: [{ actions: [{ action: 'magicLink' }] }] })
})

test('an answer written in a vocabulary the change did not declare is corrected, then refused', async () => {
  const answer = JSON.stringify({
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0].text,
        checks: [{ kind: 'flow', name: 'totp login', actions: [{ action: 'magicLink', element: { testId: 'sign-in' } }] }],
      },
      { id: 'c2', text: CRITERIA[1].text, checks: [{ kind: 'visual', name: 'dashboard phone', screenshot: 'dashboard', widths: [390] }] },
    ],
  })
  const runner = new FakeAgentRunner([completed(answer), completed(answer)])

  await expect(planRun(runner, { ...INPUTS })).rejects.toThrow(/unknown flow action "magicLink"/)
  expect(runner.requests).toHaveLength(2)
  // The correction carries the refusal, so the planner knows what to fix.
  expect(runner.requests[1].prompt).toContain('unknown flow action "magicLink"')
})

test('the prompt describes the no-shell contract for command checks', async () => {
  const runner = new FakeAgentRunner([completed(planned())])

  await planRun(runner, INPUTS)

  const [request] = runner.requests
  expect(request.prompt).toContain('spawned with no shell')
  expect(request.prompt).toContain('never cd, &&, ||')
  expect(request.prompt).not.toContain('the shell command to run')
})

test('a command check written as shell syntax is corrected against the runner contract', async () => {
  const shell = JSON.stringify({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'tests', command: 'cd e2e && npm test' }] },
      { id: 'c2', text: CRITERIA[1].text, checks: [{ kind: 'visual', name: 'dashboard phone', screenshot: 'dashboard', widths: [390] }] },
    ],
  })
  const runner = new FakeAgentRunner([completed(shell), completed(planned())])

  const plan = await planRun(runner, INPUTS)

  expect(plan.criteria).toHaveLength(2)
  expect(runner.requests).toHaveLength(2)
  expect(runner.requests[1].prompt).toContain('criterion c1 command check "tests"')
  expect(runner.requests[1].prompt).toContain('spawned directly, with no shell')
})

test('a command check with a pipe is corrected the same way', async () => {
  const piped = JSON.stringify({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'remote', command: 'git ls-remote origin | grep -q .' }] },
      { id: 'c2', text: CRITERIA[1].text, checks: [{ kind: 'visual', name: 'dashboard phone', screenshot: 'dashboard', widths: [390] }] },
    ],
  })
  const runner = new FakeAgentRunner([completed(piped), completed(planned())])

  await planRun(runner, INPUTS)

  expect(runner.requests).toHaveLength(2)
  expect(runner.requests[1].prompt).toContain('"|" is shell syntax')
})

test('a command check that relies on quoting is corrected the same way', async () => {
  const quoted = JSON.stringify({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'grep', command: "grep -q 'a b' out.txt" }] },
      { id: 'c2', text: CRITERIA[1].text, unplannable: 'no visual baseline exists for the dashboard' },
    ],
  })
  const runner = new FakeAgentRunner([completed(quoted), completed(planned())])

  await planRun(runner, INPUTS)

  expect(runner.requests).toHaveLength(2)
  expect(runner.requests[1].prompt).toContain('quoting is not interpreted')
})

test('a second plan the runner cannot run fails loudly', async () => {
  const shell = JSON.stringify({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'tests', command: 'cd e2e && npm test' }] },
      { id: 'c2', text: CRITERIA[1].text, checks: [{ kind: 'command', name: 'phone', command: 'npm test' }] },
    ],
  })
  const runner = new FakeAgentRunner([completed(shell), completed(shell)])

  await expect(planRun(runner, INPUTS)).rejects.toThrow(/criterion c1 command check "tests"/)
})
