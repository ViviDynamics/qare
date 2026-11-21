import { expect, test } from 'vitest'
import { FakeAgentRunner, planOutputSchema, planRun, type AgentRunResult, type PlanInputs } from '../src/index.js'

// The planner and the http check (#378): offered where there is an app to
// send the request to, with or without a browser, and corrected where there
// is none.

const APP = { address: ['http:', '//localhost:{{run.app_port}}'].join('') }
const TARGET = ['https:', '//shop.example'].join('')
const CRITERIA = [{ id: 'c1', text: 'POST /orders with no items returns 422' }]

const HTTP = {
  kind: 'http',
  name: 'empty order refused',
  method: 'POST',
  path: '/orders',
  headers: { 'content-type': 'application/json' },
  body: '{"items":[]}',
  expect: { status: 422, json: [{ path: 'error.code', equals: 'empty_order' }] },
}
const COMMAND = { kind: 'command', name: 'version', command: 'node --version' }

function completed(check: unknown): AgentRunResult {
  return {
    status: 'completed',
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    output: JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c1', text: CRITERIA[0]?.text, checks: [check] }] }),
  }
}

type CheckSchema = ReturnType<typeof planOutputSchema>['properties']['criteria']['items']['properties']['checks']['items']

function checkSchema(runner: FakeAgentRunner, index = 0): CheckSchema {
  const request = runner.requests[index]
  if (request === undefined) throw new Error('no request')
  return (JSON.parse(request.outputSchema) as ReturnType<typeof planOutputSchema>).properties.criteria.items.properties.checks.items
}

test.each([
  ['an app the run boots', { app: APP }],
  ['a target', { target: TARGET }],
])('with %s the planner is offered the http kind, its fields and what it may carry', async (_label, address) => {
  const runner = new FakeAgentRunner([completed(HTTP)])
  const inputs: PlanInputs = { criteria: CRITERIA, diff: 'diff --git a/x b/x', ...address }

  const plan = await planRun(runner, inputs)

  expect(plan.criteria[0]).toMatchObject({ checks: [{ kind: 'http', method: 'POST', path: '/orders' }] })
  const schema = checkSchema(runner)
  expect(schema.properties.kind.enum).toContain('http')
  for (const field of ['method', 'path', 'headers', 'expect']) expect(schema.properties).toHaveProperty(field)
  const prompt = runner.requests[0]?.prompt ?? ''
  expect(prompt).toContain('- http: {"kind":"http"')
  expect(prompt).toMatch(/never a URL or another host/)
  expect(prompt).toMatch(/expect always names the status/)
  expect(prompt).toMatch(/GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS/)
  // Placed beside the other checks: for what the running app answers, before a command or a grep.
  expect(prompt).toMatch(/Prefer it to a command and to a grep of the source/)
  expect(prompt).toMatch(/The run adds no credential to a request/)
})

test('a profile with no browser flavour keeps the http check, and the plan step does not correct it', async () => {
  const runner = new FakeAgentRunner([completed(HTTP)])

  const plan = await planRun(runner, { criteria: CRITERIA, diff: 'diff --git a/x b/x', target: TARGET, noBrowser: { flavour: 'core' } })

  expect(runner.requests).toHaveLength(1)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ kind: 'http' }] })
  expect(checkSchema(runner).properties.kind.enum).toEqual(['command', 'mail', 'http'])
  expect(runner.requests[0]?.prompt).toContain('- http: {"kind":"http"')
})

test.each([
  ['no app and no target', {}, 'boots no app and names no target'],
  ['a desktop build', { client: 'electron' }, 'desktop build'],
])('with %s the http kind is not offered, and a planned one is corrected', async (_label, address, why) => {
  const runner = new FakeAgentRunner([completed(HTTP), completed(COMMAND)])

  const plan = await planRun(runner, { criteria: CRITERIA, diff: 'diff --git a/x b/x', ...address })

  const schema = checkSchema(runner)
  expect(schema.properties.kind.enum).not.toContain('http')
  for (const field of ['method', 'path', 'headers', 'expect']) expect(schema.properties).not.toHaveProperty(field)
  expect(runner.requests[0]?.prompt).not.toContain('"kind":"http"')
  expect(runner.requests).toHaveLength(2)
  expect(runner.requests[1]?.prompt).toContain('criterion c1 http check "empty order refused"')
  expect(runner.requests[1]?.prompt).toContain(why)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ kind: 'command' }] })
})

test('the default output schema offers no http check, so nothing changes for a caller that names no app', () => {
  expect(planOutputSchema().properties.criteria.items.properties.checks.items.properties.kind.enum).not.toContain('http')
  expect(planOutputSchema([], undefined, undefined, true).properties.criteria.items.properties.checks.items.properties.kind.enum).toContain('http')
})
