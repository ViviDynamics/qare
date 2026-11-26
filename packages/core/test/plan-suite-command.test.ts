import { expect, test } from 'vitest'

import { FakeAgentRunner, planRun, type AgentRunResult, type PlanInputs } from '../src/index.js'

// #429: on the website pilot the planner answered a criterion tagged (command)
// with a command check that copied a suite's own command (docker compose ...
// exec -T web bin/qa-rspec ...). It was refused as an unknown program, the
// correction said only "use a declared command or a standard tool", and the
// planner gave up on a criterion the declared suite would have proven.

const RSPEC = 'docker compose -p qare-{{run.id}} -f compose.qa.yaml exec -T web bin/qa-rspec {{test}}'
const TIMERS = 'docker compose -p qare-{{run.id}} -f compose.qa.yaml exec -T web bin/qa-rspec spec/requests/timers_spec.rb'

const CRITERION = { id: 'c1', text: 'The timers request spec, spec/requests/timers_spec.rb, passes inside the booted QA stack (command)' }

const INPUTS: PlanInputs = {
  criteria: [CRITERION],
  diff: 'diff --git a/app/controllers/timers_controller.rb b/app/controllers/timers_controller.rb',
  suites: [
    { name: 'rspec', kind: 'command', command: RSPEC, filter: 'test' },
    { name: 'time-tracking', kind: 'command', command: TIMERS },
  ],
  commands: { lint: { run: 'bundle exec rubocop {{path}}' } },
  runInputs: { paths: ['spec', 'app'] },
}

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

function answer(checks: unknown[]): string {
  return JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c1', text: CRITERION.text, checks }] })
}

const copied = (command: string): Record<string, string> => ({ kind: 'command', name: 'timers spec', command })
const SUITE_CHECK = { kind: 'flow', name: 'timers spec', suite: 'rspec', filter: 'spec/requests/timers_spec.rb' }

test("a refused command check that copies a filtered suite's command is pointed at that suite, with the filter it ran (#429)", async () => {
  const runner = new FakeAgentRunner([
    completed(answer([copied('docker compose -p qare-local -f compose.qa.yaml exec -T web bin/qa-rspec spec/requests/timers_spec.rb:12')])),
    completed(answer([SUITE_CHECK])),
  ])

  const plan = await planRun(runner, { ...INPUTS, suites: [INPUTS.suites![0]!] })

  const correction = runner.requests[1]!.prompt
  expect(correction).toContain('criterion c1 command check "timers spec" runs the command of the declared suite rspec')
  expect(correction).toContain('{"kind":"flow","name":"timers spec","suite":"rspec","filter":"spec/requests/timers_spec.rb:12"}')
  expect(correction).not.toContain('Use one of the declared commands')
  expect(plan.criteria[0]).toMatchObject({ checks: [SUITE_CHECK] })
})

test("a command check that is a suite's whole command names that suite before a filtered one (#429)", async () => {
  const runner = new FakeAgentRunner([
    completed(answer([copied('docker compose -p qare-1 -f compose.qa.yaml exec -T web bin/qa-rspec spec/requests/timers_spec.rb')])),
    completed(answer([{ kind: 'flow', name: 'timers spec', suite: 'time-tracking' }])),
  ])

  await planRun(runner, INPUTS)

  expect(runner.requests[1]!.prompt).toContain('runs the command of the declared suite time-tracking')
  expect(runner.requests[1]!.prompt).toContain('{"kind":"flow","name":"timers spec","suite":"time-tracking"}')
})

test("a suite's command copied with shell syntax is still pointed at the suite, not only told the shell is missing (#429)", async () => {
  const runner = new FakeAgentRunner([
    completed(answer([copied('docker compose -p qare-1 -f compose.qa.yaml exec -T web bin/qa-rspec spec/requests/timers_spec.rb && echo ok')])),
    completed(answer([SUITE_CHECK])),
  ])

  await planRun(runner, INPUTS)

  expect(runner.requests[1]!.prompt).toContain('runs the command of the declared suite')
})

test("a refused program that only some suite runs is named with that suite, though the arguments differ (#429)", async () => {
  const runner = new FakeAgentRunner([
    completed(answer([copied('docker compose run --rm web bin/qa-rspec spec/requests/timers_spec.rb')])),
    completed(answer([SUITE_CHECK])),
  ])

  await planRun(runner, INPUTS)

  const correction = runner.requests[1]!.prompt
  expect(correction).toContain('the program docker is neither a program of the declared commands nor a standard tool')
  expect(correction).toContain('the declared suites rspec, time-tracking run docker for you: name one in a flow check')
})

test('a command check the runner accepts is left alone, even when a suite runs the same program (#429)', async () => {
  const runner = new FakeAgentRunner([completed(answer([copied('grep -q timers spec/requests/timers_spec.rb')]))])

  const plan = await planRun(runner, {
    ...INPUTS,
    suites: [{ name: 'grep-suite', kind: 'command', command: 'grep -q timers spec/requests/timers_spec.rb' }],
  })

  expect(runner.requests).toHaveLength(1)
  expect(plan.criteria[0]).toMatchObject({ checks: [copied('grep -q timers spec/requests/timers_spec.rb')] })
})

test('the prompt says a (command) criterion naming a test is proven by the suite check that runs it (#429)', async () => {
  const runner = new FakeAgentRunner([completed(answer([SUITE_CHECK]))])

  await planRun(runner, INPUTS)

  expect(runner.requests[0]!.prompt).toContain(
    'A criterion tagged (command) that names a test or a test file is proven by the flow check that runs its suite:',
  )
})
