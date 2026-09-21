import { expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION, type RunResult, loadResult } from '../src/result.js'
import { isFork, parseWaiver, recordWaiver, refuseFork } from '../src/waiver.js'

const allProven: RunResult = {
  schemaVersion: RESULT_SCHEMA_VERSION,
  verdict: 'passed',
  criteria: [
    { id: 'payouts', outcome: 'proven', evidence: ['checks/payouts/1/stdout.txt'] },
    { id: 'ledger', outcome: 'proven', evidence: ['checks/ledger/1/stdout.txt'] },
  ],
  job: { id: 'job-3' },
}

test('a fork is refused with the head repo interpolated; the same repo is not a fork', () => {
  expect(isFork({ headRepo: 'org/repo', baseRepo: 'org/repo' })).toBe(false)
  expect(isFork({ headRepo: 'ORG/REPO', baseRepo: 'org/repo' })).toBe(false)
  expect(isFork({ headRepo: 'other/repo', baseRepo: 'org/repo' })).toBe(true)
  expect(refuseFork({ headRepo: 'other/repo', baseRepo: 'org/repo' })).toEqual({
    verdict: 'refused',
    reason:
      'refused: fork pull request (other/repo) cannot run qare; secrets are never shared with forks',
  })
})

test('a hostile head repo is refused with the generic reason, no interpolation', () => {
  for (const hostile of ['../etc', 'a b/c', 'org/repo\nGET /admin', 42]) {
    const refusal = refuseFork({ headRepo: hostile as string, baseRepo: 'org/repo' })
    expect(refusal.reason).not.toContain('(')
    expect(refusal.reason).toBe(
      'refused: fork pull request cannot run qare; secrets are never shared with forks',
    )
  }
})

test('parseWaiver reads /qa-waive comment ids and rejects the bare label', () => {
  expect(parseWaiver({ body: '/qa-waive c1, c2' })).toEqual({ criterionIds: ['c1', 'c2'] })
  expect(parseWaiver({ body: '  /qa-waive payouts  ledger ' })).toEqual({
    criterionIds: ['payouts', 'ledger'],
  })
  expect(parseWaiver({ label: 'qa-waived' })).toEqual({
    rejected: 'qa-waived label names no criteria; comment /qa-waive <ids> instead',
  })
  expect(parseWaiver({ body: '/qa-waive bad:id, a/../b, ok-id' })).toEqual({
    criterionIds: ['ok-id'],
  })
  expect(parseWaiver({ body: '/qa-waive :colon' })).toEqual({ rejected: 'no valid criterion ids' })
})

test('recordWaiver overrides named criteria, shows the waiver in evidence, verdict waived', () => {
  const result = recordWaiver(allProven, { criterionIds: ['payouts'], by: 'hana' })
  expect(result.verdict).toBe('waived')
  expect(result.criteria[0]).toEqual({ id: 'payouts', outcome: 'unverified', reason: 'waived by hana' })
  expect(result.waived).toEqual([{ criterionId: 'payouts', by: 'hana' }])
  expect(result.criteria[1]?.outcome).toBe('proven')
})

test('waived never rescues a failure', () => {
  const failed: RunResult = {
    ...allProven,
    verdict: 'failed',
    criteria: [
      { id: 'payouts', outcome: 'failed', evidence: [] },
      { id: 'ledger', outcome: 'proven', evidence: ['checks/ledger/1/stdout.txt'] },
    ],
  }
  const result = recordWaiver(failed, { criterionIds: ['ledger'], by: 'hana' })
  expect(result.verdict).toBe('failed')
  expect(result.waived).toEqual([{ criterionId: 'ledger', by: 'hana' }])
})

test('a refused result passes through unchanged; the waiver is never applied to it', () => {
  const refused: RunResult = { ...allProven, verdict: 'refused' }
  const result = recordWaiver(refused, { criterionIds: ['payouts'], by: 'hana' })
  expect(result).toBe(refused)
  expect(result.waived).toBeUndefined()
})

test('the result loader round-trips a waived field and rejects malformed ones', () => {
  const text = `${JSON.stringify({ ...recordWaiver(allProven, { criterionIds: ['payouts'], by: 'hana' }), job: { id: 'job-3' } }, null, 2)}\n`
  const parsed = loadResult(text)
  expect(parsed.waived).toEqual([{ criterionId: 'payouts', by: 'hana' }])
  expect(parsed.verdict).toBe('waived')

  const malformed = JSON.parse(text)
  malformed.waived = 'payouts'
  expect(() => loadResult(JSON.stringify(malformed))).toThrow(/waived must be an array/)
  const empty = JSON.parse(text)
  empty.waived = []
  expect(() => loadResult(JSON.stringify(empty))).toThrow(/must not be empty/)
})

test('waiving a nonexistent or empty id list is a no-op, never a verdict flip', () => {
  const noop = recordWaiver(allProven, { criterionIds: ['typo-id'], by: 'hana' })
  expect(noop.verdict).toBe('passed')
  expect(noop.waived).toBeUndefined()
  const empty = recordWaiver(allProven, { criterionIds: [], by: 'hana' })
  expect(empty.verdict).toBe('passed')
  expect(empty.waived).toBeUndefined()
  const blankActor = recordWaiver(allProven, { criterionIds: ['payouts'], by: '   ' })
  expect(blankActor.verdict).toBe('passed')
  expect(blankActor.waived).toBeUndefined()
})

test('parseWaiver deduplicates repeated ids', () => {
  expect(parseWaiver({ body: '/qa-waive c1, c1' })).toEqual({ criterionIds: ['c1'] })
})
