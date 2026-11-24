import { expect, test } from 'vitest'

import { FakeAgentRunner, PlanStepError, planRun, type AgentRunResult, type PlanInputs } from '../src/index.js'

// #421: a command suite was shown as "a command suite: docker compose ...", and
// the planner read the line as a raw command it may not run, while the only way
// to run any suite is a flow check that names it. #414: across runs the planner
// said "no suites declared" against a profile that declares them, or marked a
// criterion unplannable with a filtered suite that would have covered it.

const PYTEST = 'docker compose -p qare-{{run.id}} -f compose.qa.yaml exec -T web pytest {{test}}'
const SMOKE = 'docker compose -p qare-{{run.id}} -f compose.qa.yaml exec -T web pytest tests/test_smoke.py'

const CRITERIA = [
  { id: 'c1', text: 'tests/test_portfolio.py::test_signed_out_is_refused passes' },
  { id: 'c2', text: 'the smoke tests pass' },
]

const COMMAND_ONLY: PlanInputs = {
  criteria: CRITERIA,
  diff: 'diff --git a/app/portfolio.py b/app/portfolio.py',
  suites: [
    { name: 'pytest', kind: 'command', command: PYTEST, filter: 'test' },
    { name: 'smoke', kind: 'command', command: SMOKE },
  ],
  noBrowser: { flavour: 'core' },
  batchSize: 2,
}

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

const NAMED_TEST = { kind: 'flow', name: 'signed out', suite: 'pytest', filter: 'tests/test_portfolio.py::test_signed_out_is_refused' }
const SMOKE_CHECK = { kind: 'flow', name: 'smoke', suite: 'smoke' }

function answer(first: Record<string, unknown>, second: Record<string, unknown> = { checks: [SMOKE_CHECK] }): string {
  return JSON.stringify({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, ...first },
      { id: 'c2', text: CRITERIA[1].text, ...second },
    ],
  })
}

test('each command suite is described by the flow check that runs it, never as a command to copy', async () => {
  const runner = new FakeAgentRunner([completed(answer({ checks: [NAMED_TEST] }))])

  await planRun(runner, COMMAND_ONLY)

  const { prompt } = runner.requests[0]
  expect(prompt).toContain('A check runs a suite by naming it in a flow check, whatever the suite\'s kind')
  expect(prompt).toContain(
    `- pytest (a command suite): run it as {"kind":"flow","name":...,"suite":"pytest","filter":"the test name or path to run"}; qare then runs ${PYTEST} with {{test}} set to the filter`,
  )
  expect(prompt).toContain(`- smoke (a command suite): run it as {"kind":"flow","name":...,"suite":"smoke"}; qare then runs ${SMOKE}\n`)
  expect(prompt).toMatch(/never copy a suite's command into a command check/i)
})

test('a profile with only command suites gets a plan that runs them for the criteria naming their tests', async () => {
  const runner = new FakeAgentRunner([completed(answer({ checks: [NAMED_TEST] }))])

  const plan = await planRun(runner, COMMAND_ONLY)

  expect(plan.criteria).toMatchObject([
    { id: 'c1', checks: [NAMED_TEST] },
    { id: 'c2', checks: [SMOKE_CHECK] },
  ])
})

test('every kind of suite, and a bare name, is described by the flow check that runs it', async () => {
  const runner = new FakeAgentRunner([completed(answer({ checks: [{ kind: 'command', name: 'v', command: 'node --version' }] }, { checks: [{ kind: 'command', name: 'v', command: 'node --version' }] }))])

  await planRun(runner, {
    ...COMMAND_ONLY,
    noBrowser: undefined,
    suites: ['unit', { name: 'sign-in', kind: 'flow', command: 'npx playwright test sign-in' }, { name: 'shots', kind: 'visual' }],
  })

  const { prompt } = runner.requests[0]
  expect(prompt).toContain('- unit: run it as {"kind":"flow","name":...,"suite":"unit"}\n')
  expect(prompt).toContain('- sign-in (a flow suite): run it as {"kind":"flow","name":...,"suite":"sign-in"}; qare then runs npx playwright test sign-in\n')
  expect(prompt).toContain('- shots (a visual suite): run it as {"kind":"flow","name":...,"suite":"shots"}\n')
})

for (const reason of [
  'The repository declares no suites, so nothing runs the test.',
  'No suites are declared for this repository.',
  'There is no test suite to run it with.',
]) {
  test(`an unplannable reason claiming no suites ("${reason}") is corrected once, then refused`, async () => {
    const runner = new FakeAgentRunner([completed(answer({ unplannable: reason })), completed(answer({ checks: [NAMED_TEST] }))])

    const plan = await planRun(runner, COMMAND_ONLY)

    expect(runner.requests[1].prompt).toContain('Your previous answer was rejected')
    expect(runner.requests[1].prompt).toContain('criterion c1 is unplannable because no suite is declared, but the profile declares pytest, smoke')
    expect(plan.criteria[0]).toMatchObject({ checks: [NAMED_TEST] })

    const stubborn = new FakeAgentRunner([completed(answer({ unplannable: reason })), completed(answer({ unplannable: reason }))])
    await expect(planRun(stubborn, COMMAND_ONLY)).rejects.toThrow(PlanStepError)
  })
}

test('with no suites declared, a reason saying so stands', async () => {
  const runner = new FakeAgentRunner([completed(answer({ unplannable: 'The repository declares no suites, so nothing runs the test.' }, { unplannable: 'no suites are declared' }))])

  const plan = await planRun(runner, { ...COMMAND_ONLY, suites: [] })

  expect(plan.criteria[0]).toMatchObject({ unplannable: 'The repository declares no suites, so nothing runs the test.' })
})

test('an unplannable criterion while a filtered suite is declared is asked once why that suite does not apply', async () => {
  const silent = 'Nothing could observe this.'
  const why = 'pytest has no test for the portfolio page, so no filter names one.'
  const runner = new FakeAgentRunner([completed(answer({ unplannable: silent })), completed(answer({ unplannable: why }))])

  const plan = await planRun(runner, COMMAND_ONLY)

  expect(runner.requests[1].prompt).toContain(
    'criterion c1 is unplannable without saying why pytest, a suite that takes a filter, has no test that covers it',
  )
  expect(plan.criteria[0]).toMatchObject({ unplannable: why })
  expect(runner.requests[0].prompt).toMatch(/unplannable while a suite that takes a filter is declared/)

  // Asked once: a criterion no test could show is rightly unplannable, so a second answer stands.
  const stubborn = new FakeAgentRunner([completed(answer({ unplannable: silent })), completed(answer({ unplannable: silent }))])
  const kept = await planRun(stubborn, COMMAND_ONLY)
  expect(kept.criteria[0]).toMatchObject({ unplannable: silent })
  expect(stubborn.requests).toHaveLength(2)
})

test('the nudge to name a filtered suite never spends the correction a refused answer needs', async () => {
  const bad = { kind: 'flow', name: 'smoke', suite: 'smoke', filter: 'tests/test_smoke.py' }
  const runner = new FakeAgentRunner([
    completed(answer({ unplannable: 'Nothing could observe this.' }, { checks: [bad] })),
    completed(answer({ checks: [NAMED_TEST] })),
  ])

  await planRun(runner, COMMAND_ONLY)

  expect(runner.requests[1].prompt).toContain('takes no filter')
})

test('without a filtered suite, an unplannable reason need not name a suite', async () => {
  const runner = new FakeAgentRunner([completed(answer({ unplannable: 'Nothing could observe this.' }))])

  const plan = await planRun(runner, { ...COMMAND_ONLY, suites: [COMMAND_ONLY.suites![1]!] })

  expect(plan.criteria[0]).toMatchObject({ unplannable: 'Nothing could observe this.' })
  expect(runner.requests).toHaveLength(1)
})

test('a nudged plan is kept when the answer to the nudge is refused', async () => {
  const silent = 'Nothing could observe this.'
  const runner = new FakeAgentRunner([
    completed(answer({ unplannable: silent })),
    completed(answer({ checks: [{ kind: 'flow', name: 'smoke', suite: 'smoke', filter: 'tests/test_smoke.py' }] })),
  ])

  const plan = await planRun(runner, COMMAND_ONLY)

  expect(runner.requests).toHaveLength(2)
  expect(plan.criteria).toMatchObject([{ id: 'c1', unplannable: silent }, { id: 'c2', checks: [SMOKE_CHECK] }])

  const failed = new FakeAgentRunner([completed(answer({ unplannable: silent })), { status: 'failed', stopReason: 'error', usage: { inputTokens: 1, outputTokens: 0 }, output: undefined, error: 'proxy' }])
  expect((await planRun(failed, COMMAND_ONLY)).criteria[0]).toMatchObject({ unplannable: silent })
})
