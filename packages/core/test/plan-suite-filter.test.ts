import { expect, test } from 'vitest'

import { FakeAgentRunner, PlanStepError, planOutputSchema, planRun, type AgentRunResult, type PlanInputs } from '../src/index.js'

// #376: a behavioural criterion the planner could not reach through a flow
// fell back to a grep of the source. A suite that takes a filter runs the one
// test that covers the criterion, and the planner is told to prefer it.

const RSPEC = 'docker compose -p qare-{{run.id}} -f compose.qa.yaml exec -T web bundle exec rspec {{test}} --format RspecJunitFormatter'

const CRITERIA = [
  { id: 'c1', text: 'an invoice total includes tax' },
  { id: 'c2', text: 'a refund over the paid amount is refused' },
]

const INPUTS: PlanInputs = {
  criteria: CRITERIA,
  diff: 'diff --git a/app/models/invoice.rb b/app/models/invoice.rb',
  suites: [
    { name: 'rspec', kind: 'command', command: RSPEC, filter: 'test' },
    { name: 'sign-in', kind: 'flow', command: 'bundle exec cucumber features/sign_in.feature' },
  ],
  noBrowser: { flavour: 'core' },
  batchSize: 2,
}

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

function answer(first: unknown, second: unknown = { kind: 'flow', name: 'refund', suite: 'rspec', filter: 'spec/models/refund_spec.rb' }): string {
  return JSON.stringify({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [first] },
      { id: 'c2', text: CRITERIA[1].text, checks: [second] },
    ],
  })
}

const NAMED_TEST = { kind: 'flow', name: 'invoice tax', suite: 'rspec', filter: 'spec/models/invoice_spec.rb:12' }

test('the planner is told which suites take a filter, and to prefer a named test over a grep', async () => {
  const runner = new FakeAgentRunner([completed(answer(NAMED_TEST))])

  await planRun(runner, INPUTS)

  const [request] = runner.requests
  expect(request.prompt).toContain(`- rspec (a command suite: ${RSPEC}) [takes a filter: {{test}} is the test name or path it runs]`)
  expect(request.prompt).toContain('- sign-in (a flow suite: bundle exec cucumber features/sign_in.feature)\n')
  expect(request.prompt).toContain('{"kind":"flow","name":...,"suite":"a suite that takes a filter","filter":"the test name or path to run"}')
  expect(request.prompt).toMatch(/criterion about what the code does.*suite check whose filter names a test/s)
  expect(request.prompt).toMatch(/before any grep/)
  const check = (JSON.parse(request.outputSchema) as ReturnType<typeof planOutputSchema>).properties.criteria.items.properties.checks.items
  expect(check.properties).toHaveProperty('filter')
})

test('a plan whose criteria a declared test covers holds suite checks naming those tests', async () => {
  const runner = new FakeAgentRunner([completed(answer(NAMED_TEST))])

  const plan = await planRun(runner, INPUTS)

  expect(plan.criteria).toMatchObject([
    { id: 'c1', checks: [{ kind: 'flow', suite: 'rspec', filter: 'spec/models/invoice_spec.rb:12' }] },
    { id: 'c2', checks: [{ kind: 'flow', suite: 'rspec', filter: 'spec/models/refund_spec.rb' }] },
  ])
  expect(JSON.stringify(plan)).not.toContain('grep')
})

test('with no suite that takes a filter the prompt says nothing of filters', async () => {
  const runner = new FakeAgentRunner([completed(answer({ kind: 'flow', name: 'sign in', suite: 'sign-in' }, { kind: 'command', name: 'v', command: 'node --version' }))])

  await planRun(runner, { ...INPUTS, suites: [INPUTS.suites![1]!] })

  expect(runner.requests[0].prompt).not.toContain('filter')
})

for (const [label, bad, reason] of [
  ['a filter that is not one safe token', { ...NAMED_TEST, filter: '--require=evil.rb' }, 'starts with -'],
  ['a filter on a suite that takes none', { kind: 'flow', name: 'sign in', suite: 'sign-in', filter: 'sign_in' }, 'takes no filter'],
  ['a suite that takes a filter named without one', { kind: 'flow', name: 'invoice tax', suite: 'rspec' }, 'takes a filter'],
] as const) {
  test(`${label} is corrected once, then refused`, async () => {
    const runner = new FakeAgentRunner([completed(answer(bad)), completed(answer(NAMED_TEST))])

    const plan = await planRun(runner, INPUTS)

    expect(runner.requests[1].prompt).toContain('Your previous answer was rejected')
    expect(runner.requests[1].prompt).toContain(reason)
    expect(plan.criteria[0]).toMatchObject({ checks: [NAMED_TEST] })

    const stubborn = new FakeAgentRunner([completed(answer(bad)), completed(answer(bad))])
    await expect(planRun(stubborn, INPUTS)).rejects.toThrow(PlanStepError)
  })
}
