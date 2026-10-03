import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { NareAgentRunner, RESULT_SCHEMA_VERSION, redactionRules, reviewJudged, runUxReview } from '../src/index.js'
import type { AdvisoryScreen, AgentRunRequest, AgentRunResult, AgentRunner, RunResult } from '../src/index.js'

// #150: what bounds the advisory review. It comes after the verdict and must
// never hold it up, it shows a model only what the run's rules let out, and
// in a run of several apps it says which app a screen belongs to.

const SCREEN = 'checks/signup-form/0'
const SCREENS: AdvisoryScreen[] = [{ screen: SCREEN, criterionId: 'signup-form', files: [`${SCREEN}/actions.log`] }]

const DONE: AgentRunResult = { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output: JSON.stringify({ findings: [] }) }

function judged(): RunResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'passed',
    criteria: [
      { id: 'signup-form', outcome: 'proven', evidence: [`${SCREEN}/actions.log`] },
      { id: 'totals', outcome: 'proven', evidence: ['checks/totals/0/actions.log'] },
    ],
  }
}

/** A runner that records what it was asked and answers when told to, or never. */
function recording(answer: AgentRunResult | 'never'): AgentRunner & { requests: AgentRunRequest[] } {
  const requests: AgentRunRequest[] = []
  return {
    requests,
    run: (request) => {
      requests.push(request)
      return answer === 'never' ? new Promise<AgentRunResult>(() => {}) : Promise.resolve(answer)
    },
  }
}

function payloadOf(request: AgentRunRequest | undefined): Record<string, unknown> {
  const prompt = request?.prompt ?? ''
  return JSON.parse(prompt.slice(prompt.indexOf('\n\n{') + 2)) as Record<string, unknown>
}

test('a reviewer that never answers is given up on, named unavailable, and told to stop', async () => {
  const runner = recording('never')
  const started = Date.now()
  const advisory = await runUxReview(runner, { screens: SCREENS, texts: {} }, { timeoutMs: 40 })
  expect(Date.now() - started).toBeLessThan(2000)
  expect(advisory).toEqual({ status: 'unavailable', reason: 'no answer within 40 ms', screens: [SCREEN], findings: [] })
  // The runner is handed a signal, and it has fired: a process behind it is killed, not left running.
  expect(runner.requests[0]?.signal?.aborted).toBe(true)
})

test('a reviewer that answers in time is not aborted, and the default wait is minutes, not forever', async () => {
  const runner = recording(DONE)
  expect((await runUxReview(runner, { screens: SCREENS, texts: {} }))?.status).toBe('reviewed')
  expect(runner.requests[0]?.signal?.aborted).toBe(false)
})

test('an aborted run kills the nare process and fails, instead of waiting for it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-nare-hang-'))
  const binary = join(dir, 'nare')
  // A stand-in that never answers: it sleeps far past the test.
  await writeFile(`${binary}.mjs`, 'setTimeout(() => {}, 600000)\n', 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  await chmod(binary, 0o755)
  const controller = new AbortController()
  const run = new NareAgentRunner({ binary }).run({ prompt: 'p', system: '', toolPolicy: 'read-only', outputSchema: '', budget: { maxOutputTokens: 16 }, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  const started = Date.now()
  await expect(run).rejects.toThrow(/could not run nare|aborted/)
  expect(Date.now() - started).toBeLessThan(5000)
})

test('QA.md, the house rules, the criteria and the dismissed list are swept with the run rules before a model sees them', async () => {
  const runner = recording(DONE)
  await reviewJudged(judged(), {
    reviewer: runner,
    texts: { 'signup-form': 'Signing in as fixture-user-0001 shows the form.' },
    qaMd: 'Log in as fixture-user-0001.',
    houseRules: ['Never show fixture-user-0001 in a heading.'],
    dismissed: [{ id: 'aaaaaaaa', screen: SCREEN, category: 'copy', saw: 'The heading names fixture-user-0001.', element: 'heading "fixture-user-0001"' }],
    rules: redactionRules({ values: ['fixture-user-0001'] }),
  })
  const prompt = runner.requests[0]?.prompt ?? ''
  expect(prompt).not.toContain('fixture-user-0001')
  expect(payloadOf(runner.requests[0])).toMatchObject({ qaMd: 'Log in as [redacted].', houseRules: ['Never show [redacted] in a heading.'] })
})

test('in a run of several apps each screen names its app, so a rule is held to the screens of the app that wrote it', async () => {
  const runner = recording(DONE)
  await reviewJudged(judged(), {
    reviewer: runner,
    texts: {},
    houseRules: ['admin: Forms name every field.', 'ledger: Amounts show a currency.'],
    appOf: (criterionId) => (criterionId === 'signup-form' ? 'admin' : 'ledger'),
  })
  const payload = payloadOf(runner.requests[0]) as { screens: Array<{ screen: string; app?: string }> }
  expect(payload.screens.map((screen) => [screen.screen, screen.app])).toEqual([
    [SCREEN, 'admin'],
    ['checks/totals/0', 'ledger'],
  ])
  expect(runner.requests[0]?.prompt).toContain('applies only to the screens of that app')
  // One app: no screen names one, and nothing about apps is asked of the model.
  const single = recording(DONE)
  await reviewJudged(judged(), { reviewer: single, texts: {} })
  expect(JSON.stringify(payloadOf(single.requests[0]))).not.toContain('"app"')
})
