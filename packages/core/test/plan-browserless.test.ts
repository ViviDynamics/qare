import { expect, test } from 'vitest'

import {
  BROWSER_FLAVOURS,
  FakeAgentRunner,
  PlanStepError,
  browserlessFlavour,
  planOutputSchema,
  planRun,
  validateProfileConfig,
  type AgentRunResult,
  type PlanInputs,
} from '../src/index.js'

// #258: the plan step assumed a browser whatever image execute would run in.
// A profile that named no flavour ran in qare-core, which ships none, and every
// criterion came back unverified with `browserType.launch: Executable doesn't
// exist`, fifteen minutes of planning later.

// Nothing here reaches it: the URL is only what a target profile must carry.
const TARGET = { target: { url: ['http:', '//127.0.0.1:3000'].join(''), health: { http: '/', timeout: '5s' } } }
const SUITES = [
  { name: 'sign-in', command: 'bundle exec cucumber features/sign_in.feature', kind: 'flow' },
  { name: 'unit', command: 'bin/rails test', kind: 'command' },
]
const CLIENT = {
  client: { driver: 'electron', artefact: { kind: 'directory', executable: 'app', head: { path: 'build' } }, health: { timeout: '5s' } },
}
const MAPPED = {
  ...TARGET,
  mcp: [{ name: 'rig', command: 'rig', tools: ['tap'], steps: ['execute'], driver: { click: { tool: 'tap', args: { target: 'element' } } } }],
}

const CRITERIA = [
  { id: 'c1', text: 'a member signs in with a password' },
  { id: 'c2', text: 'the dashboard renders on a phone' },
]

const INPUTS: PlanInputs = {
  criteria: CRITERIA,
  diff: 'diff --git a/app/sign_in.rb b/app/sign_in.rb',
  suites: SUITES.map((suite) => ({ name: suite.name, kind: suite.kind, command: suite.command })),
  noBrowser: { flavour: 'core' },
  // One turn for both criteria: these tests are about what a turn is offered and refused (#259 batches by default).
  batchSize: 2,
}

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

function answer(first: unknown, second: unknown = { kind: 'command', name: 'unit', command: 'node --version' }): string {
  return JSON.stringify({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [first] },
      { id: 'c2', text: CRITERIA[1].text, checks: [second] },
    ],
  })
}

const SUITE_CHECK = { kind: 'flow', name: 'sign in', suite: 'sign-in' }
const ACTION_FLOW = { kind: 'flow', name: 'sign in', actions: [{ action: 'open', url: '/sign-in' }, { action: 'assertText', text: 'Welcome' }] }

test('web is the flavour that ships a browser, and a profile that names none runs in core', () => {
  expect(BROWSER_FLAVOURS).toEqual(['web'])
  expect(browserlessFlavour(validateProfileConfig({ ...TARGET }))).toBe('core')
  expect(browserlessFlavour(validateProfileConfig({ ...TARGET, flavour: 'core' }))).toBe('core')
  expect(browserlessFlavour(validateProfileConfig({ ...TARGET, flavour: 'web' }))).toBeUndefined()
})

test('a profile that names a client or maps an MCP driver plans against that driver, whatever its flavour', () => {
  expect(browserlessFlavour(validateProfileConfig(CLIENT))).toBeUndefined()
  expect(browserlessFlavour(validateProfileConfig({ ...CLIENT, flavour: 'core' }))).toBeUndefined()
  expect(browserlessFlavour(validateProfileConfig(MAPPED))).toBeUndefined()
  // No profile, no flavour to read: the plan step keeps the driver it assumed.
  expect(browserlessFlavour(undefined)).toBeUndefined()
})

test('without a browser the planner is offered suites, commands and mail, and no action flow, visual or a11y check', async () => {
  const runner = new FakeAgentRunner([completed(answer(SUITE_CHECK))])

  const plan = await planRun(runner, INPUTS)

  expect(plan.criteria[0]).toMatchObject({ checks: [{ kind: 'flow', suite: 'sign-in' }] })
  const [request] = runner.requests
  const check = (JSON.parse(request.outputSchema) as ReturnType<typeof planOutputSchema>).properties.criteria.items.properties.checks.items
  expect(check.properties.kind.enum).toEqual(['command', 'flow', 'mail'])
  for (const property of ['actions', 'screenshot', 'widths', 'themes', 'url'])
    expect(check.properties, `${property} belongs to a browser check`).not.toHaveProperty(property)
  expect(check.properties).toHaveProperty('suite')

  expect(request.prompt).toContain('- flow: {"kind":"flow","name":...,"suite":"an existing suite"}')
  expect(request.prompt).not.toContain('"actions"')
  expect(request.prompt).not.toContain('"kind":"visual"')
  expect(request.prompt).not.toContain('"kind":"a11y"')
  expect(request.prompt).not.toContain('A flow action is one of')
  expect(request.prompt).toContain('qare-core')
  expect(request.prompt).toMatch(/ships no browser/)
  expect(request.prompt).toMatch(/suite or a command/)
  // The suites are named with what they run, so the planner can tell which covers a criterion.
  expect(request.prompt).toContain('- sign-in (a flow suite: bundle exec cucumber features/sign_in.feature)')
  expect(request.prompt).toContain('- unit (a command suite: bin/rails test)')
})

test('with no suites declared and no browser, a flow is not offered at all', async () => {
  const runner = new FakeAgentRunner([completed(answer({ kind: 'command', name: 'unit', command: 'node --version' }))])

  await planRun(runner, { ...INPUTS, suites: [] })

  const check = (JSON.parse(runner.requests[0].outputSchema) as ReturnType<typeof planOutputSchema>).properties.criteria.items.properties.checks.items
  expect(check.properties.kind.enum).toEqual(['command', 'mail'])
  expect(runner.requests[0].prompt).not.toContain('"kind":"flow"')
})

test.each([
  ['an action flow', ACTION_FLOW, 'flow'],
  ['a visual check', { kind: 'visual', name: 'dashboard phone', screenshot: 'dashboard', url: '/dashboard', widths: [390] }, 'visual'],
  ['an a11y check', { kind: 'a11y', name: 'dashboard audit', url: '/dashboard' }, 'a11y'],
])('%s planned for a flavour without a browser is corrected, naming the flavour and the setting that changes it', async (_label, browserCheck, kind) => {
  const runner = new FakeAgentRunner([completed(answer(SUITE_CHECK, browserCheck)), completed(answer(SUITE_CHECK))])

  const plan = await planRun(runner, INPUTS)

  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2'])
  expect(runner.requests).toHaveLength(2)
  const correction = runner.requests[1].prompt
  expect(correction).toContain('Your previous answer was rejected')
  expect(correction).toContain(`criterion c2 ${kind} check`)
  expect(correction).toMatch(/the profile's flavour is core/)
  expect(correction).toContain('flavour: web')
  expect(correction).toContain('config.yml')
})

test('a plan that still holds a browser check after its correction is refused, naming the flavour and the setting', async () => {
  const runner = new FakeAgentRunner([completed(answer(ACTION_FLOW)), completed(answer(ACTION_FLOW))])

  const error = await planRun(runner, INPUTS).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(PlanStepError)
  expect(String(error)).toContain('criterion c1 flow check "sign in" drives a browser')
  expect(String(error)).toMatch(/the profile's flavour is core/)
  expect(String(error)).toContain('flavour: web')
})

test('a flavour with a browser plans as it did: action flows, visual and a11y checks are offered and accepted', async () => {
  const runner = new FakeAgentRunner([completed(answer(ACTION_FLOW, { kind: 'a11y', name: 'dashboard audit', url: '/dashboard' }))])
  const withBrowser: PlanInputs = { criteria: INPUTS.criteria, diff: INPUTS.diff, suites: INPUTS.suites, batchSize: 2 }

  const plan = await planRun(runner, withBrowser)

  expect(plan.criteria[0]).toMatchObject({ checks: [{ kind: 'flow' }] })
  expect(runner.requests).toHaveLength(1)
  expect(runner.requests[0].prompt).toContain('"kind":"visual"')
  expect(runner.requests[0].prompt).toContain('A flow action is one of')
  expect(runner.requests[0].prompt).not.toContain('ships no browser')
})

test('a suite command reaches the planner redacted, by the built-in rules and the profile\'s own', async () => {
  const runner = new FakeAgentRunner([completed(answer(SUITE_CHECK))])

  await planRun(runner, {
    ...INPUTS,
    suites: [
      { name: 'sign-in', kind: 'flow', command: 'bundle exec cucumber features/sign_in.feature API_TOKEN=hunter2-live-value' },
      { name: 'billing', kind: 'flow', command: 'bin/billing --account fixture-account-7781' },
    ],
    redact: { values: ['fixture-account-7781'] },
  })

  const [request] = runner.requests
  expect(request.prompt).not.toContain('hunter2-live-value')
  expect(request.prompt).not.toContain('fixture-account-7781')
  expect(request.prompt).toContain('- sign-in (a flow suite: bundle exec cucumber features/sign_in.feature API_TOKEN=[redacted])')
  expect(request.prompt).toContain('- billing (a flow suite: bin/billing --account [redacted])')
})
