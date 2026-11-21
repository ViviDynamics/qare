import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  CONTEXT_WINDOW_ENV,
  FakeAgentRunner,
  planRun,
  runVerifier,
  stopDetail,
  type AgentRunResult,
  type PlanInputs,
} from '../src/index.js'

// #391: behind an OpenAI-compatible proxy nare cannot ask the backend for its
// window, falls back to 32000, and stops every turn whose context estimate
// reaches it. The evidence has to say which window was in force and what
// changes it, or the stop reads as a qare failure.

const INPUTS: PlanInputs = {
  criteria: [{ id: 'c1', text: 'the login form rejects an empty password' }],
  diff: 'diff --git a/login.ts b/login.ts',
  suites: ['unit'],
}

const VERIFIER_INPUTS = {
  instructions: 'Judge the evidence.',
  claims: [{ criterionId: 'c1', text: 'the login form rejects an empty password', evidence: ['checks/c1/0/stdout.txt'] }],
  diff: '',
  criteria: [{ criterionId: 'c1', outcome: 'proven' as const, regression: false }],
}

const CONTEXT_STOP: AgentRunResult = {
  status: 'failed',
  stopReason: 'context',
  usage: { inputTokens: 1, outputTokens: 0 },
  output: undefined,
  error: 'context estimate 34000 reaches window 32000',
}

const BUDGET = { maxOutputTokens: 16384 }

let before: string | undefined
beforeEach(() => {
  before = process.env[CONTEXT_WINDOW_ENV]
  delete process.env[CONTEXT_WINDOW_ENV]
})
afterEach(() => {
  if (before === undefined) delete process.env[CONTEXT_WINDOW_ENV]
  else process.env[CONTEXT_WINDOW_ENV] = before
})

test('the window is the one nare reads', () => {
  expect(CONTEXT_WINDOW_ENV).toBe('NARE_CONTEXT_WINDOW')
})

test('a context stop with no window set names the fallback and the input that sets it', () => {
  const detail = stopDetail('context', BUDGET, {})
  expect(detail).toMatch(/^context, /)
  expect(detail).toContain('32000')
  expect(detail).toContain('NARE_CONTEXT_WINDOW was not set')
  expect(detail).toContain('nare-context-window in the pipeline')
})

test('a context stop with a window set names that window and the input that raises it', () => {
  const detail = stopDetail('context', BUDGET, { NARE_CONTEXT_WINDOW: '200000' })
  expect(detail).toContain('the window of 200000 tokens that NARE_CONTEXT_WINDOW set')
  expect(detail).toContain('nare-context-window in the pipeline')
  expect(detail).not.toContain('32000')
})

test('the context stop text survives the secret sweep: no colon or equals follows a word ending in tokens (#260)', () => {
  for (const env of [{}, { NARE_CONTEXT_WINDOW: '200000' }])
    expect(stopDetail('context', BUDGET, env)).not.toMatch(/tokens\s*[:=]/)
})

test('other stop reasons are left as they were', () => {
  expect(stopDetail('error', BUDGET, { NARE_CONTEXT_WINDOW: '200000' })).toBe('error')
  expect(stopDetail('max_tokens', BUDGET, {})).not.toContain('NARE_CONTEXT_WINDOW')
})

test('a verifier stopped at the context window leaves the criterion unverified, naming the window and the input', async () => {
  process.env[CONTEXT_WINDOW_ENV] = '64000'
  const { verdicts } = await runVerifier(new FakeAgentRunner([CONTEXT_STOP]), VERIFIER_INPUTS)
  expect(verdicts[0].outcome).toBe('unverified')
  expect(verdicts[0].reason).toContain('the run stopped (context, ')
  expect(verdicts[0].reason).toContain('the window of 64000 tokens that NARE_CONTEXT_WINDOW set')
  expect(verdicts[0].reason).toContain('nare-context-window in the pipeline')
  // nare's own words still follow, so the estimate it measured is kept.
  expect(verdicts[0].reason).toContain('context estimate 34000 reaches window 32000')
})

test('a planner stopped at the context window fails by name, naming the window and the input', async () => {
  await expect(planRun(new FakeAgentRunner([CONTEXT_STOP]), INPUTS)).rejects.toThrow(
    /stop reason context, .*32000.*NARE_CONTEXT_WINDOW was not set.*nare-context-window in the pipeline/,
  )
})
