import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  FakeAgentRunner,
  MAX_OUTPUT_TOKENS_ENV,
  outputBudget,
  planRun,
  redactText,
  runUxReview,
  runVerifier,
  stopDetail,
  type AgentRunResult,
  type PlanInputs,
} from '../src/index.js'

// #254: the planner and the verifier ran on a fixed 4096 output tokens, and a
// reasoning model spent them before the plan was written.

const INPUTS: PlanInputs = {
  criteria: [{ id: 'c1', text: 'the login form rejects an empty password' }],
  diff: 'diff --git a/login.ts b/login.ts',
  suites: ['unit'],
}

const PLAN = JSON.stringify({
  schemaVersion: '1',
  criteria: [{ id: 'c1', text: INPUTS.criteria[0].text, checks: [{ kind: 'command', name: 'login unit', command: 'node --version' }] }],
})

const CUT_OFF: AgentRunResult = { status: 'failed', stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 1 }, output: undefined }

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

const VERIFIER_INPUTS = {
  instructions: 'Judge the evidence.',
  claims: [{ criterionId: 'c1', text: 'the login form rejects an empty password', evidence: ['checks/c1/0/stdout.txt'] }],
  diff: '',
  criteria: [{ criterionId: 'c1', outcome: 'proven' as const, regression: false }],
}

// The setting is a supported one, so a caller may have it set: the tests start
// without it and hand it back afterwards.
let before: string | undefined
beforeEach(() => {
  before = process.env[MAX_OUTPUT_TOKENS_ENV]
  delete process.env[MAX_OUTPUT_TOKENS_ENV]
})
afterEach(() => {
  if (before === undefined) delete process.env[MAX_OUTPUT_TOKENS_ENV]
  else process.env[MAX_OUTPUT_TOKENS_ENV] = before
})

test('the default budget leaves a reasoning model room to think and still answer', () => {
  expect(MAX_OUTPUT_TOKENS_ENV).toBe('QARE_MAX_OUTPUT_TOKENS')
  expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(16384)
  expect(outputBudget({})).toEqual({ maxOutputTokens: 16384 })
  expect(outputBudget({ QARE_MAX_OUTPUT_TOKENS: '' })).toEqual({ maxOutputTokens: 16384 })
})

test('the environment sets the budget', () => {
  expect(outputBudget({ QARE_MAX_OUTPUT_TOKENS: '32000' })).toEqual({ maxOutputTokens: 32000 })
})

test.each(['0', '-5', '12.5', 'lots', '8k', '9'.repeat(400), '9007199254740993'])('a budget of %s is refused by name, never guessed at', (value) => {
  expect(() => outputBudget({ QARE_MAX_OUTPUT_TOKENS: value })).toThrow(/QARE_MAX_OUTPUT_TOKENS.*whole number/)
})

test('the planner asks with the default budget, and with the one the environment names', async () => {
  const byDefault = new FakeAgentRunner([completed(PLAN)])
  await planRun(byDefault, INPUTS)
  expect(byDefault.requests[0].budget).toEqual({ maxOutputTokens: 16384 })

  process.env[MAX_OUTPUT_TOKENS_ENV] = '24000'
  const raised = new FakeAgentRunner([completed(PLAN)])
  await planRun(raised, INPUTS)
  expect(raised.requests[0].budget).toEqual({ maxOutputTokens: 24000 })
})

test('a plan cut off at the budget says what the budget was and what raises it', async () => {
  process.env[MAX_OUTPUT_TOKENS_ENV] = '6000'
  await expect(planRun(new FakeAgentRunner([CUT_OFF]), INPUTS)).rejects.toThrow(
    /stop reason max_tokens.*6000 output tokens.*QARE_MAX_OUTPUT_TOKENS.*max-output-tokens/,
  )
})

test('a planning run that failed for another reason does not blame the budget', async () => {
  const failed: AgentRunResult = { ...CUT_OFF, stopReason: 'error', error: 'HTTP 500' }
  const error = await planRun(new FakeAgentRunner([failed]), INPUTS).catch((caught: unknown) => caught)
  expect(String(error)).toContain('HTTP 500')
  expect(String(error)).not.toContain('QARE_MAX_OUTPUT_TOKENS')
})

test('the verifier asks with the same budget, and a cut-off verdict names it', async () => {
  const byDefault = new FakeAgentRunner([completed(JSON.stringify({ findings: [] }))])
  await runVerifier(byDefault, VERIFIER_INPUTS)
  expect(byDefault.requests[0].budget).toEqual({ maxOutputTokens: 16384 })

  process.env[MAX_OUTPUT_TOKENS_ENV] = '6000'
  const cut = new FakeAgentRunner([CUT_OFF])
  const { verdicts } = await runVerifier(cut, VERIFIER_INPUTS)
  expect(cut.requests[0].budget).toEqual({ maxOutputTokens: 6000 })
  expect(verdicts[0].outcome).toBe('unverified')
  expect(verdicts[0].reason).toMatch(/max_tokens.*6000 output tokens.*QARE_MAX_OUTPUT_TOKENS/)
})

test('a budget the verifier cannot read leaves the criterion unverified, by name, and asks nothing', async () => {
  process.env[MAX_OUTPUT_TOKENS_ENV] = 'lots'
  const runner = new FakeAgentRunner([])
  const { verdicts } = await runVerifier(runner, VERIFIER_INPUTS)
  expect(runner.requests).toHaveLength(0)
  expect(verdicts[0].outcome).toBe('unverified')
  expect(verdicts[0].reason).toContain('QARE_MAX_OUTPUT_TOKENS is "lots"')
})

test('the UX review asks with the same budget', async () => {
  const screens = { screens: [{ screen: 'checks/signup-form/0', criterionId: 'c1', files: ['checks/signup-form/0/actions.log'] }], texts: {} }
  // Unscripted, so the review is unavailable; the request is what is read.
  const byDefault = new FakeAgentRunner([])
  await runUxReview(byDefault, screens)
  expect(byDefault.requests[0].budget).toEqual({ maxOutputTokens: 16384 })

  process.env[MAX_OUTPUT_TOKENS_ENV] = '6000'
  const lowered = new FakeAgentRunner([])
  await runUxReview(lowered, screens)
  expect(lowered.requests[0].budget).toEqual({ maxOutputTokens: 6000 })
})

// #260: the message read `max_tokens: the turn was cut off`, and the secret
// sweep took `tokens: the` for a token and its value, so a pull request
// comment said `max_tokens: [redacted] turn was cut off`.
test('the cut-off message passes the secret sweep unchanged, alone and inside the plan and verifier reasons', async () => {
  const detail = stopDetail('max_tokens', { maxOutputTokens: 6000 })
  expect(detail).toMatch(/^max_tokens\b.*the turn was cut off at its budget of 6000 output tokens/)
  expect(redactText(detail)).toBe(detail)

  process.env[MAX_OUTPUT_TOKENS_ENV] = '6000'
  const withError: AgentRunResult = { ...CUT_OFF, error: 'the provider closed the stream' }
  for (const result of [CUT_OFF, withError]) {
    const refusal = String(await planRun(new FakeAgentRunner([result]), INPUTS).catch((caught: unknown) => caught))
    expect(refusal).toContain(detail)
    expect(redactText(refusal)).toBe(refusal)

    const { verdicts } = await runVerifier(new FakeAgentRunner([result]), VERIFIER_INPUTS)
    expect(verdicts[0].reason).toContain(detail)
    expect(redactText(verdicts[0].reason ?? '')).toBe(verdicts[0].reason)
  }
})

test('the sweep still redacts a token assignment, so the message passes by its wording and not by a looser rule', () => {
  expect(redactText('max_tokens: hunter2 was the value')).toBe('max_tokens: [redacted] was the value')
  expect(redactText('AUTH_TOKEN=abc123')).toBe('AUTH_TOKEN=[redacted]')
})
