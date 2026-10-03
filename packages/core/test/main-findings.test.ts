import { describe, expect, test } from 'vitest'
import { appendChange, classifyMainRun, mainFindingFingerprint, parseResult } from '../src/index.js'
import type { LedgerChange, LedgerDocument, LedgerEntry, RunResult } from '../src/index.js'

// #154: what a run on main amounts to, decided in code from the executed
// result and the ledger: which criteria are findings, of which kind, which
// recovered, and which file nothing.

function entry(criterion: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return { criterion, status: 'active', source: ['suite:billing'], proof: 'flow', ...extra }
}

function verified(changes: LedgerChange[], run: string, timestamp: string, criteria: string[]): LedgerChange[] {
  return appendChange(changes, { kind: 'verify', actor: run, timestamp, reason: `run ${run}: pass`, criteria })
}

function ledger(entries: LedgerEntry[], changes: LedgerChange[] = []): LedgerDocument {
  return { entries, changes }
}

function result(verdict: RunResult['verdict'], criteria: unknown[]): RunResult {
  return parseResult({ schemaVersion: '1', verdict, criteria })
}

describe('classifying a run on main', () => {
  test('a failed criterion the ledger saw pass is a regression, with when and by what it last passed', () => {
    const changes = verified(verified([], 'run-7', '2026-09-20T04:17:00.000Z', ['BIL-014']), 'run-9', '2026-09-28T04:17:00.000Z', ['BIL-014', 'BIL-021'])
    const run = result('failed', [
      { id: 'BIL-014', outcome: 'failed', evidence: ['checks/BIL-014/0/actions.json', 'checks/BIL-014/0/after.png'] },
      { id: 'BIL-021', outcome: 'proven', evidence: ['checks/BIL-021/0/stdout.txt'] },
    ])
    const classified = classifyMainRun(run, ledger([entry('BIL-014', { text: 'A host sees the 1099 notice.', checks: ['app/payouts'] }), entry('BIL-021')], changes))
    expect(classified.environment).toBeUndefined()
    expect(classified.findings).toHaveLength(1)
    expect(classified.findings[0]).toMatchObject({
      kind: 'regression',
      criterionId: 'BIL-014',
      text: 'A host sees the 1099 notice.',
      outcome: 'failed',
      evidence: ['checks/BIL-014/0/actions.json', 'checks/BIL-014/0/after.png'],
      checks: ['app/payouts'],
      // The last pass, not the first: the range of commits to blame starts there.
      lastProven: { run: 'run-9', at: '2026-09-28T04:17:00.000Z' },
    })
    expect(classified.recovered).toEqual(['BIL-021'])
    expect(classified.environmentUp).toBe(true)
  })

  test('a failed criterion nothing shows ever passed is a failure, never called a regression', () => {
    const classified = classifyMainRun(result('failed', [{ id: 'NEW-1', outcome: 'failed', evidence: ['checks/NEW-1/0/stdout.txt'] }]), ledger([entry('NEW-1')]))
    expect(classified.findings[0]).toMatchObject({ kind: 'failure', criterionId: 'NEW-1' })
    expect(classified.findings[0]?.lastProven).toBeUndefined()
  })

  test('a criterion the run itself proved at the base is a regression even when the ledger holds no pass', () => {
    const run = result('failed', [
      { id: 'BIL-014', outcome: 'failed', evidence: ['checks/BIL-014/0/after.png'], base: { outcome: 'proven', evidence: ['base/checks/BIL-014/0/after.png'] }, regression: true },
    ])
    const classified = classifyMainRun(run, ledger([entry('BIL-014')]))
    expect(classified.findings[0]).toMatchObject({ kind: 'regression' })
    expect(classified.findings[0]?.lastProven).toBeUndefined()
  })

  test('a quarantined check files nothing and proves nothing: it is flaky, and stays in quarantine', () => {
    const run = result('blocked', [
      { id: 'FLK-1', outcome: 'unverified', reason: 'quarantined (2026-09-30T00:00:00.000Z): failed then passed in 2 attempts', evidence: ['checks/FLK-1/0/quarantined.json'] },
      { id: 'BIL-021', outcome: 'proven', evidence: ['checks/BIL-021/0/stdout.txt'] },
    ])
    const classified = classifyMainRun(run, ledger([entry('FLK-1'), entry('BIL-021')]))
    expect(classified.findings).toEqual([])
    expect(classified.environment).toBeUndefined()
    expect(classified.flaky).toEqual(['FLK-1'])
    expect(classified.recovered).toEqual(['BIL-021'])
  })

  test('a run in which nothing booted is one environment finding for the whole run, never one per criterion', () => {
    const changes = verified([], 'run-9', '2026-09-28T04:17:00.000Z', ['BIL-014', 'BIL-021'])
    const run = result('blocked', [
      { id: 'BIL-014', outcome: 'unverified', reason: 'boot did not come up' },
      { id: 'BIL-021', outcome: 'unverified', reason: 'boot did not come up' },
    ])
    const classified = classifyMainRun(run, ledger([entry('BIL-014'), entry('BIL-021')], changes))
    expect(classified.findings).toEqual([])
    expect(classified.recovered).toEqual([])
    expect(classified.environmentUp).toBe(false)
    expect(classified.environment).toMatchObject({
      kind: 'environment',
      fingerprint: 'mf-environment',
      reasons: ['boot did not come up'],
      criteria: ['BIL-014', 'BIL-021'],
    })
  })

  test('a blocked run that a person or the verifier held is not an environment that is down', () => {
    const run = result('blocked', [
      { id: 'BIL-014', outcome: 'unverified', reason: 'verifier gave no readable answer' },
      { id: 'BIL-021', outcome: 'unverified', reason: 'held for an open question q-0123456789abcdef' },
    ])
    const classified = classifyMainRun(run, ledger([entry('BIL-014'), entry('BIL-021')]))
    expect(classified.environment).toBeUndefined()
    expect(classified.findings).toEqual([])
    // Nothing ran, so nothing says the environment is up either.
    expect(classified.environmentUp).toBe(false)
  })

  test('a refused run files nothing here: a missing stub has its own issue', () => {
    const run = result('refused', [{ id: 'BIL-014', outcome: 'unverified', reason: 'refused: missing stub: api.stripe.com:443 (https)' }])
    const classified = classifyMainRun(run, ledger([entry('BIL-014')]))
    expect(classified.environment).toBeUndefined()
    expect(classified.findings).toEqual([])
  })
})

describe('the fingerprint of a finding', () => {
  test('is the same for the same criterion failing the same checks, whatever the run', () => {
    const first = mainFindingFingerprint('BIL-014', 'failed', ['checks/BIL-014/0/actions.json', 'checks/BIL-014/1/stdout.txt'])
    // Another run: other files of the same checks, in another order, and a repeated attempt.
    const second = mainFindingFingerprint('BIL-014', 'failed', ['checks/BIL-014/1/stderr.txt', 'checks/BIL-014/0-attempt2/actions.json', 'checks/BIL-014/0/after.png'])
    expect(first).toMatch(/^mf-[0-9a-f]{16}$/)
    expect(second).toBe(first)
  })

  test('moves with the criterion and with the checks that failed', () => {
    const base = mainFindingFingerprint('BIL-014', 'failed', ['checks/BIL-014/0/actions.json'])
    expect(mainFindingFingerprint('BIL-015', 'failed', ['checks/BIL-014/0/actions.json'])).not.toBe(base)
    expect(mainFindingFingerprint('BIL-014', 'failed', ['checks/BIL-014/0/actions.json', 'checks/BIL-014/1/stdout.txt'])).not.toBe(base)
    // How it failed is part of the signature: the verifier overturning a proof is not the check failing.
    expect(mainFindingFingerprint('BIL-014', 'failed', ['checks/BIL-014/0/actions.json'], 'verifier found the notice missing')).not.toBe(base)
  })
})
