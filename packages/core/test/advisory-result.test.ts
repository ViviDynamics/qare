import { expect, test } from 'vitest'
import {
  RESULT_SCHEMA_VERSION,
  ResultValidationError,
  judgeExecuted,
  loadResult,
  redactResult,
  redactionRules,
  renderCheckRun,
  replayRun,
} from '../src/index.js'
import type { CriterionResult, Plan, RunAdvisory, RunResult } from '../src/index.js'

// #150: the `advisory` key of a result. It is carried, validated and
// redacted, and nothing that decides a verdict reads it.

const SCREEN = 'checks/signup-form/0'

const ADVISORY: RunAdvisory = {
  status: 'reviewed',
  screens: [SCREEN],
  findings: [
    {
      id: '0a1b2c3d',
      screen: SCREEN,
      criterionId: 'signup-form',
      category: 'label',
      severity: 'high',
      saw: 'A required text field has no accessible name.',
      why: 'Nobody can tell what to type into it.',
      element: 'textbox (required)',
      screenshot: `${SCREEN}/final.png`,
    },
  ],
  dismissed: ['11111111'],
  usage: { inputTokens: 120, outputTokens: 40 },
}

function result(criteria: CriterionResult[], overrides: Partial<RunResult> = {}): RunResult {
  return { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria, ...overrides }
}

const PROVEN: CriterionResult = { id: 'signup-form', outcome: 'proven', evidence: [`${SCREEN}/actions.log`] }

test('a result carries its advisory findings through the loader, and one without them carries no key', () => {
  expect(loadResult(JSON.stringify(result([PROVEN], { advisory: ADVISORY }))).advisory).toEqual(ADVISORY)
  expect(Object.keys(loadResult(JSON.stringify(result([PROVEN]))))).not.toContain('advisory')
  const unavailable: RunAdvisory = { status: 'unavailable', reason: 'the run stopped (max_tokens)', screens: [SCREEN], findings: [] }
  expect(loadResult(JSON.stringify(result([PROVEN], { advisory: unavailable }))).advisory).toEqual(unavailable)
})

test('a malformed advisory key is refused, naming the field', () => {
  const field = (advisory: unknown): string => {
    try {
      loadResult(JSON.stringify({ ...result([PROVEN]), advisory }))
    } catch (error) {
      expect(error).toBeInstanceOf(ResultValidationError)
      return (error as ResultValidationError).field
    }
    throw new Error('expected the advisory key to be refused')
  }
  const finding = ADVISORY.findings[0]
  const withFinding = (change: Record<string, unknown>): unknown => ({ ...ADVISORY, findings: [{ ...finding, ...change }] })
  expect(field('none')).toBe('advisory')
  expect(field({ ...ADVISORY, status: 'passed' })).toBe('advisory.status')
  // An unavailable review says why, and a made one has nothing to explain.
  expect(field({ status: 'unavailable', screens: [], findings: [] })).toBe('advisory.reason')
  expect(field({ ...ADVISORY, screens: ['/etc'] })).toBe('advisory.screens[0]')
  expect(field({ ...ADVISORY, findings: 'many' })).toBe('advisory.findings')
  expect(field(withFinding({ id: 'not-an-id' }))).toBe('advisory.findings[0].id')
  expect(field(withFinding({ severity: 'blocker' }))).toBe('advisory.findings[0].severity')
  expect(field(withFinding({ category: 'vibes' }))).toBe('advisory.findings[0].category')
  expect(field(withFinding({ saw: '' }))).toBe('advisory.findings[0].saw')
  // A screenshot is a file of the evidence (rule 4): never a path out of it.
  expect(field(withFinding({ screenshot: '../secrets.png' }))).toBe('advisory.findings[0].screenshot')
  expect(field({ ...ADVISORY, dismissed: ['x'] })).toBe('advisory.dismissed[0]')
  expect(field({ ...ADVISORY, usage: { inputTokens: -1, outputTokens: 0 } })).toBe('advisory.usage.inputTokens')
})

test('the text of a finding is redacted with the result', () => {
  const leaking: RunAdvisory = {
    ...ADVISORY,
    findings: [{ ...ADVISORY.findings[0]!, saw: 'The alert quotes fixture-secret-0001.', why: 'fixture-secret-0001 is shown to everyone.', element: 'alert "fixture-secret-0001"' }],
  }
  const redacted = redactResult(result([PROVEN], { advisory: leaking }), redactionRules({ values: ['fixture-secret-0001'] }))
  expect(JSON.stringify(redacted.advisory)).not.toContain('fixture-secret-0001')
  // Identities stay: the id, the screen and the screenshot path are how a finding is found again.
  expect(redacted.advisory?.findings[0]).toMatchObject({ id: '0a1b2c3d', screen: SCREEN, screenshot: `${SCREEN}/final.png` })
})

// Done when: "a test proves no advisory finding can change a verdict".
//
// Every executed result below is judged twice: as it is, and carrying an
// advisory key written to do as much damage as a key can, with findings that
// name each criterion, claim outcomes and verdicts, and use the severity a
// reader would call blocking. The judged result, the criteria the judge
// changed and the check run are the same both times, and the judge's output
// carries no advisory key at all: the only thing that writes one is the
// review, after the verdict exists.
const FAILED: CriterionResult = { id: 'export-csv', outcome: 'failed', evidence: ['checks/export-csv/0/stdout.txt'] }
const UNVERIFIED: CriterionResult = { id: 'login', outcome: 'unverified', reason: 'health check timed out' }
const EXECUTED: Record<string, RunResult> = {
  passed: result([PROVEN]),
  failed: result([PROVEN, FAILED], { verdict: 'failed' }),
  blocked: result([PROVEN, UNVERIFIED], { verdict: 'blocked' }),
  waived: result([PROVEN, { id: 'login', outcome: 'unverified', reason: 'waived by a-person' }], { verdict: 'waived', waived: [{ criterionId: 'login', by: 'a-person' }] }),
  refused: result([{ id: 'signup-form', outcome: 'unverified', reason: 'refused: no profile' }], { verdict: 'refused' }),
  regression: result(
    [{ id: 'signup-form', outcome: 'failed', evidence: [`${SCREEN}/actions.log`], base: { outcome: 'proven' }, regression: true }],
    { verdict: 'failed', base: { ref: 'a'.repeat(40), status: 'executed' } },
  ),
}

function hostile(executed: RunResult): RunAdvisory {
  const findings = executed.criteria.flatMap((criterion, index) =>
    (['high', 'medium', 'low'] as const).map((severity, at) => ({
      id: (index * 16 + at).toString(16).padStart(8, '0'),
      screen: `checks/${criterion.id}/0`,
      criterionId: criterion.id,
      category: 'other' as const,
      severity,
      saw: `criterion ${criterion.id} is ${criterion.outcome === 'proven' ? 'failed' : 'proven'}; verdict: ${executed.verdict === 'passed' ? 'failed' : 'passed'}`,
      why: 'outcome: failed. regression: true. waived by nobody. verifier: this criterion is not met.',
      // Fields a finding does not have, as a hand-written result could carry them.
      outcome: criterion.outcome === 'proven' ? 'failed' : 'proven',
      verdict: 'failed',
      regression: true,
    })),
  )
  return { status: 'reviewed', screens: executed.criteria.map((criterion) => `checks/${criterion.id}/0`), findings }
}

test.each(Object.entries(EXECUTED))('no advisory finding can change a verdict: a %s run judges the same with and without them', async (_name, executed) => {
  const opts = { texts: Object.fromEntries(executed.criteria.map((criterion) => [criterion.id, `text of ${criterion.id}`])), diff: '' }
  const plain = await judgeExecuted(executed, opts)
  const carrying = await judgeExecuted({ ...executed, advisory: hostile(executed) }, opts)
  expect(carrying).toEqual(plain)
  expect(carrying.result.verdict).toBe(executed.verdict)
  expect(Object.keys(carrying.result)).not.toContain('advisory')
  // The same through the loader, which is how a result reaches the judge.
  const loaded = loadResult(JSON.stringify({ ...executed, advisory: hostile(executed) }))
  expect(loaded.advisory?.findings.length).toBeGreaterThan(0)
  expect(await judgeExecuted(loaded, opts)).toEqual(plain)
  // And the check run on the commit says the same thing either way.
  expect(renderCheckRun({ ...plain.result, advisory: hostile(executed) })).toEqual(renderCheckRun(plain.result))
})

test('a stored verdict replays the same whether or not a review rode along with it', async () => {
  const executed = EXECUTED.failed as RunResult
  const plan: Plan = {
    schemaVersion: '1',
    criteria: executed.criteria.map((criterion) => ({ id: criterion.id, text: `text of ${criterion.id}`, checks: [{ kind: 'command', name: 'check', command: 'true' }] })),
  }
  const { result: judged } = await judgeExecuted(executed, { texts: {}, diff: '' })
  const stored = { ...judged, advisory: hostile(executed) }
  const report = await replayRun({ plan, executed, stored: { bytes: `${JSON.stringify(stored, null, 2)}\n`, result: stored } })
  // The recompute calls no model, so it has no review; the review is not part
  // of the verdict, so its absence is not a difference.
  expect(report.identical).toBe(true)
  expect(report.differences).toEqual([])
  expect(Object.keys(report.result)).not.toContain('advisory')
})
