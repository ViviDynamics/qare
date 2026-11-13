import { expect, test } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAgentRunner, PlanStepError, planRun, type PlanInputs } from '../src/index.js'

const INPUTS: PlanInputs = {
  criteria: [{ id: 'script-proof', text: 'the script asserts the required behavior' }],
  runInputs: { paths: ['.qa', 'checks/assert.py'] },
}

function result(command: string) {
  return {
    status: 'completed' as const, stopReason: 'end_turn' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
    output: JSON.stringify({ schemaVersion: '1', criteria: [{
      ...INPUTS.criteria[0], checks: [{ kind: 'command', name: 'script assertion', command }],
    }] }),
  }
}

test.each([
  ['node -e 1', '-e'], ['node --eval=1', '--eval=1'],
  ['node -p 1', '-p'], ['node --print=1', '--print=1'],
  ['node -r module .qa/check.mjs', '-r'],
  ['node --require=module .qa/check.mjs', '--require=module'],
  ['node --import=module .qa/check.mjs', '--import=module'],
  ['node --loader=module .qa/check.mjs', '--loader=module'],
  ['node --experimental-loader=module .qa/check.mjs', '--experimental-loader=module'],
  ['node --input-type=module', '--input-type=module'], ['node -', '-'],
  ['node -- -', '-'], ['node -pe 1', '-pe'],
  ['python3 -c 1', '-c'], ['python3 -m json.tool', '-m'],
  ['python3 -c1', '-c1'], ['python3 -', '-'],
])('refuses interpreter argument %s and identifies its criterion, check and argument', async (command, argument) => {
  const runner = new FakeAgentRunner([result(command), result(command)])
  const error = await planRun(runner, INPUTS).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(PlanStepError)
  expect(String(error)).toContain('script-proof')
  expect(String(error)).toContain('script assertion')
  expect(String(error)).toContain(argument)
})

test.each(['node .qa/check.mjs', 'node -- .qa/check.mjs', 'python3 checks/assert.py', 'python3 -- checks/assert.py', 'node .qa/check.mjs --eval script-data'])('accepts declared repository script %s', async (command) => {
  const runner = new FakeAgentRunner([result(command)])
  const plan = await planRun(runner, INPUTS)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command }] })
  expect(runner.requests).toHaveLength(1)
})

test.each(['node LICENSE', 'node ../outside.mjs', 'python3 /outside.py', 'node', 'python3'])('refuses missing or undeclared interpreter script %s', async (command) => {
  const runner = new FakeAgentRunner([result(command), result(command)])
  await expect(planRun(runner, INPUTS)).rejects.toBeInstanceOf(PlanStepError)
})

test('a profile declaration cannot authorize inline interpreter code', async () => {
  const runner = new FakeAgentRunner([result('node -e 1'), result('node -e 1')])
  await expect(planRun(runner, { ...INPUTS, commands: { inline: { run: 'node -e {{code}}', about: 'inline code' } } })).rejects.toThrow(/-e/)
})

test('nare requires an explicit profile command even without an input contract', async () => {
  const refused = new FakeAgentRunner([result('nare --version'), result('nare --version')])
  await expect(planRun(refused, { criteria: INPUTS.criteria })).rejects.toThrow(/nare/)
  const accepted = new FakeAgentRunner([result('nare --version')])
  const plan = await planRun(accepted, { ...INPUTS, commands: { harness: { run: 'nare --version', about: 'inspect enrolled harness' } } })
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command: 'nare --version' }] })
})

test('the correction round can replace inline code with a declared script', async () => {
  const runner = new FakeAgentRunner([result('node -e 1'), result('node -- .qa/check.mjs')])
  const plan = await planRun(runner, INPUTS)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command: 'node -- .qa/check.mjs' }] })
  expect(runner.requests).toHaveLength(2)
  expect(runner.requests[1].prompt).toContain('-e')
  expect(runner.requests[0].prompt).toContain('repository script')
  expect(runner.requests[0].prompt).toContain('python3')
})

test.each(['node --version', 'node -v', 'python3 --version', 'python3 -V'])('retains the non-executing version probe %s', async (command) => {
  const plan = await planRun(new FakeAgentRunner([result(command)]), INPUTS)
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command }] })
})

test('inline interpreter code is refused even when no input contract is supplied', async () => {
  await expect(planRun(new FakeAgentRunner([result('node -e 1'), result('node -e 1')]), {
    criteria: INPUTS.criteria,
  })).rejects.toThrow(/-e/)
})

test('a declared directory is not itself an executable script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qare-interpreter-'))
  try {
    await mkdir(join(root, '.qa'))
    const runner = new FakeAgentRunner([result('node .qa'), result('node .qa')])
    await expect(planRun(runner, { ...INPUTS, repoPath: root })).rejects.toThrow(/script.*file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
