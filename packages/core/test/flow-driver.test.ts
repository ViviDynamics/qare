import { expect, test } from 'vitest'
import {
  BROWSER_FLOW_DRIVER,
  ELECTRON_FLOW_DRIVER,
  FakeAgentRunner,
  PlanValidationError,
  flowDriverFor,
  parsePlan,
  planOutputSchema,
  planRun,
  validateProfileConfig,
  type AgentRunResult,
} from '../src/index.js'

const CLIENT = { client: { driver: 'electron', executable: 'dist/app/app' } }
const TARGET = { target: { url: ['https:', '//example.test'].join(''), health: { http: '/', timeout: '5s' } } }

function planWith(check: Record<string, unknown>): unknown {
  return { schemaVersion: '1', criteria: [{ id: 'c1', text: 'the page greets', checks: [check] }] }
}

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

test('the electron driver declares the browser\'s whole vocabulary, so a flow moves across unchanged (#72)', () => {
  expect(ELECTRON_FLOW_DRIVER.name).toBe('electron')
  expect([...ELECTRON_FLOW_DRIVER.actions].sort()).toEqual([...BROWSER_FLOW_DRIVER.actions].sort())
  // The evidence it produces: the browser's kinds, and the application's own console output.
  expect(ELECTRON_FLOW_DRIVER.evidence).toEqual(['screenshot', 'trace', 'console', 'recording'])
})

test('a driver declares the check kinds it serves beyond a flow, and the electron driver serves none (#72)', () => {
  expect(BROWSER_FLOW_DRIVER.checks).toEqual(['visual', 'a11y'])
  expect(ELECTRON_FLOW_DRIVER.checks).toEqual([])
})

test('the driver a profile runs against is its client, its MCP mapping, or the browser (#72)', () => {
  expect(flowDriverFor(validateProfileConfig(CLIENT))).toBe(ELECTRON_FLOW_DRIVER)
  expect(flowDriverFor(validateProfileConfig(TARGET))).toBe(BROWSER_FLOW_DRIVER)
  expect(flowDriverFor(undefined)).toBe(BROWSER_FLOW_DRIVER)
  const mapped = validateProfileConfig({
    ...TARGET,
    mcp: [{ name: 'rig', command: 'rig', tools: ['tap'], steps: ['execute'], driver: { click: { tool: 'tap', args: { target: 'element' } } } }],
  })
  expect(flowDriverFor(mapped)).toMatchObject({ actions: ['click'] })
})

test('a plan with a check kind the driver does not serve is refused when it loads, naming both (#72)', () => {
  for (const check of [
    { kind: 'visual', name: 'home', screenshot: 'home', url: '/' },
    { kind: 'a11y', name: 'home', url: '/' },
  ]) {
    let error: unknown
    try {
      parsePlan(planWith(check), [], ELECTRON_FLOW_DRIVER)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PlanValidationError)
    expect((error as PlanValidationError).field).toBe('criteria[0].checks[0].kind')
    expect((error as PlanValidationError).message).toContain(`a ${check.kind} check is not one the electron driver declares, so the plan cannot run against it`)
    // The browser serves both, and a driver that does not say is not second-guessed.
    expect(() => parsePlan(planWith(check), [], BROWSER_FLOW_DRIVER)).not.toThrow()
    expect(() => parsePlan(planWith(check), [], { name: 'rig', actions: ['open'], evidence: [] })).not.toThrow()
  }
  // A flow in the shared vocabulary loads against either.
  const flow = { kind: 'flow', name: 'greets', actions: [{ action: 'open', url: '/' }, { action: 'assertText', text: 'Hello' }] }
  expect(() => parsePlan(planWith(flow), [], ELECTRON_FLOW_DRIVER)).not.toThrow()
})

test('the planner is not offered a check kind the driver does not serve (#72)', async () => {
  const kindsOf = (schema: ReturnType<typeof planOutputSchema>): string[] => schema.properties.criteria.items.properties.checks.items.properties.kind.enum
  expect(kindsOf(planOutputSchema([], ELECTRON_FLOW_DRIVER))).toEqual(['command', 'flow', 'mail'])
  expect(kindsOf(planOutputSchema([], BROWSER_FLOW_DRIVER))).toEqual(['command', 'flow', 'visual', 'mail', 'a11y'])
  expect(kindsOf(planOutputSchema())).toEqual(['command', 'flow', 'visual', 'mail', 'a11y'])

  const answer = JSON.stringify(planWith({ kind: 'command', name: 'unit', command: 'node --version' }))
  const runner = new FakeAgentRunner([completed(answer)])
  await planRun(runner, { criteria: [{ id: 'c1', text: 'the page greets' }], diff: 'diff --git a/a b/a', driver: ELECTRON_FLOW_DRIVER })
  const prompt = runner.requests[0]?.prompt ?? ''
  expect(prompt).not.toContain('"kind":"visual"')
  expect(prompt).not.toContain('"kind":"a11y"')
  expect(prompt).toContain('The checks run against the electron driver, which declares no visual check and no a11y check: plan neither.')

  // A desktop build has no URL: the planner is told how a flow reaches its pages.
  expect(prompt).not.toContain('launched by the run')
  const desktop = new FakeAgentRunner([completed(answer)])
  await planRun(desktop, { criteria: [{ id: 'c1', text: 'the page greets' }], diff: 'diff --git a/a b/a', driver: ELECTRON_FLOW_DRIVER, client: 'electron' })
  expect(desktop.requests[0]?.prompt).toContain('The app is a desktop build launched by the run through the electron driver.')
  expect(desktop.requests[0]?.prompt).toContain('{"action":"open","url":"/"}')

  const browser = new FakeAgentRunner([completed(answer)])
  await planRun(browser, { criteria: [{ id: 'c1', text: 'the page greets' }], diff: 'diff --git a/a b/a', driver: BROWSER_FLOW_DRIVER })
  expect(browser.requests[0]?.prompt).toContain('"kind":"visual"')
  expect(browser.requests[0]?.prompt).not.toContain('plan neither')
})
