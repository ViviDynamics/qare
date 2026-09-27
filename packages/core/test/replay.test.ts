import { describe, expect, test } from 'vitest'
import {
  BUILTIN_REDACTION_RULES,
  judgeExecuted,
  NO_DIFF,
  replayRun,
  RESULT_SCHEMA_VERSION,
  type Plan,
  type RunResult,
} from '../src/index.js'

const plan: Plan = {
  schemaVersion: '1',
  criteria: [
    {
      id: 'c1',
      text: 'the home page loads',
      checks: [{ kind: 'command', name: 'home', command: 'bin/rails test home_test.rb' }],
    },
    {
      id: 'c2',
      text: 'the sign-in form rejects an empty password',
      checks: [{ kind: 'command', name: 'signin', command: 'bin/rails test sign_in_test.rb' }],
    },
  ],
}

function executedResult(): RunResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'failed',
    criteria: [
      { id: 'c1', outcome: 'proven', evidence: ['c1/stdout.txt'] },
      { id: 'c2', outcome: 'failed', evidence: ['c2/stdout.txt'] },
    ],
  }
}

/** What judge writes, through the same path the command uses. */
async function judgedBytes(executed: RunResult): Promise<string> {
  const { result } = await judgeExecuted(executed, { texts: {}, diff: NO_DIFF, rules: BUILTIN_REDACTION_RULES })
  return `${JSON.stringify(result, null, 2)}\n`
}

describe('replayRun', () => {
  test('a judged run replays byte for byte, with no model', async () => {
    const executed = executedResult()
    const bytes = await judgedBytes(executed)
    const stored = { bytes, result: JSON.parse(bytes) as RunResult }

    const report = await replayRun({ plan, executed, stored })

    expect(report.stored).toBe(true)
    expect(report.identical).toBe(true)
    expect(report.differences).toEqual([])
    expect(report.explanation).toBeUndefined()
    expect(report.result.verdict).toBe('failed')
  })

  test('a stored verdict the artifacts do not support is reported, not reproduced', async () => {
    const executed = executedResult()
    const bytes = await judgedBytes(executed)
    const tampered = JSON.parse(bytes) as RunResult
    tampered.verdict = 'passed'
    tampered.criteria = tampered.criteria.map((criterion) =>
      criterion.id === 'c2' ? { ...criterion, outcome: 'proven' as const, evidence: criterion.evidence } : criterion,
    )
    const stored = { bytes: `${JSON.stringify(tampered, null, 2)}\n`, result: tampered }

    const report = await replayRun({ plan, executed, stored })

    expect(report.identical).toBe(false)
    expect(report.differences).toEqual(
      expect.arrayContaining([
        { field: 'verdict', stored: 'passed', replayed: 'failed' },
        { criterionId: 'c2', field: 'outcome', stored: 'proven', replayed: 'failed' },
      ]),
    )
  })

  test('a verifier downgrade is explained as needing the model replay must not call', async () => {
    const executed = executedResult()
    const bytes = await judgedBytes(executed)
    const withDowngrade = JSON.parse(bytes) as RunResult
    withDowngrade.verdict = 'failed'
    withDowngrade.criteria = withDowngrade.criteria.map((criterion) =>
      criterion.id === 'c1'
        ? { id: 'c1', outcome: 'failed' as const, evidence: criterion.evidence, reason: 'verifier: the saved page is not the home page' }
        : criterion,
    )
    const stored = { bytes: `${JSON.stringify(withDowngrade, null, 2)}\n`, result: withDowngrade }

    const report = await replayRun({ plan, executed, stored })

    expect(report.identical).toBe(false)
    expect(report.explanation).toContain('verifier')
    expect(report.explanation).toContain('without a model')
  })

  test('a refusal replays as a refusal', async () => {
    const executed: RunResult = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'refused',
      criteria: [{ id: 'c1', outcome: 'unverified', reason: 'this repository has no usable .qa/ profile yet' }],
    }
    const bytes = await judgedBytes(executed)

    const report = await replayRun({ plan, executed, stored: { bytes, result: JSON.parse(bytes) as RunResult } })

    expect(report.identical).toBe(true)
    expect(report.result.verdict).toBe('refused')
  })

  test('a run that was never judged still replays', async () => {
    const report = await replayRun({ plan, executed: executedResult() })

    expect(report.stored).toBe(false)
    expect(report.identical).toBe(false)
    expect(report.differences).toEqual([])
    expect(report.result.verdict).toBe('failed')
    expect(report.result.criteria.find((c) => c.id === 'c1')?.outcome).toBe('proven')
  })
})
