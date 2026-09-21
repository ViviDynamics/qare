import { describe, expect, test } from 'vitest'
import { integrityOf, serializeLedger, type LedgerEntry } from '../src/ledger.js'
import { parseLedgerEntries } from '../src/ledger.js'
import { buildLedgerProposal } from '../src/ledger-proposal.js'
import { VerificationRecord } from '../src/ledger-proposal.js'
import { applyLedgerProposal } from '../src/ledger-apply.js'

const SHA = 'a'.repeat(40)

function record(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    runId: 'run-42',
    sha: SHA,
    outcome: 'pass',
    evidence: ['evidence/comment-1.json'],
    timestamp: '2026-09-21T00:00:00.000Z',
    criteria: [{ criterionId: 'spec-up-200', outcome: 'pass' }],
    ...overrides,
  }
}

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    criterion: 'spec-up-200',
    status: 'proposed',
    source: ['https:' + '//example.test/pr/1'],
    proof: 'command',
    ...overrides,
  }
}

function verifiedProposal(current: LedgerEntry[], rec: VerificationRecord = record()) {
  const proposal = buildLedgerProposal(rec, current, integrityOf(current))
  return { proposal, rec, current }
}

describe('applyLedgerProposal', () => {
  test('clean promotion activates only the proposed criterion', () => {
    const current = [ledgerEntry(), ledgerEntry({ criterion: 'flow-login', status: 'active' })]
    const { proposal, rec } = verifiedProposal(current, record({ criteria: [{ criterionId: 'spec-up-200', outcome: 'pass' }, { criterionId: 'flow-login', outcome: 'pass' }] }))
    const { next } = applyLedgerProposal(proposal, rec, current)
    expect(next.find((entry) => entry.criterion === 'spec-up-200')?.status).toBe('active')
    expect(next.find((entry) => entry.criterion === 'flow-login')?.status).toBe('active')
    const loaded = parseLedgerEntries(JSON.parse(serializeLedger(next)))
    expect(serializeLedger(loaded)).toBe(serializeLedger(next))
  })

  test('empty changes leave the ledger identical', () => {
    const current = [ledgerEntry({ status: 'active' })]
    const rec = record({ criteria: [{ criterionId: 'spec-up-200', outcome: 'pass' }] })
    const proposal = buildLedgerProposal(rec, current, integrityOf(current))
    const { next } = applyLedgerProposal(proposal, rec, current)
    expect(next).toEqual(current)
  })

  test('stale base fingerprint is rejected', () => {
    const current = [ledgerEntry()]
    const proposal = buildLedgerProposal(record(), current, integrityOf(current))
    const stale = { ...proposal, baseFingerprint: 'sha256:' + '9'.repeat(64) }
    expect(() => applyLedgerProposal(stale, record(), current)).toThrow(/proposal is stale: baseFingerprint/)
  })

  test('forged changes not matching the verification record are rejected', () => {
    const current = [ledgerEntry(), ledgerEntry({ criterion: 'flow-login' })]
    const rec = record({ criteria: [{ criterionId: 'spec-up-200', outcome: 'pass' }] })
    const proposal = buildLedgerProposal(rec, current, integrityOf(current))
    const forged = {
      ...proposal,
      body: { ...proposal.body, changes: [...proposal.body.changes, { criterion: 'flow-login', from: 'proposed', to: 'active', reason: 'sneaked in' }] },
    }
    expect(() => applyLedgerProposal(forged, rec, current)).toThrow(/proposal does not match its verification record/)
  })

  test('every proposal field is constrained by re-derivation', () => {
    const current = [ledgerEntry()]
    const rec = record()
    const proposal = buildLedgerProposal(rec, current, integrityOf(current))
    expect(() => applyLedgerProposal({ ...proposal, runId: 'other-run' }, rec, current)).toThrow(
      /proposal does not match its verification record/,
    )
    expect(() => applyLedgerProposal({ ...proposal, proposedAt: '2026-09-21T00:00:01.000Z' }, rec, current)).toThrow(
      /proposal does not match its verification record/,
    )
    expect(() => applyLedgerProposal({ ...proposal, baseSha: 'b'.repeat(40) }, rec, current)).toThrow(
      /proposal does not match its verification record/,
    )
    expect(() => applyLedgerProposal({ ...proposal, ledgerText: serializeLedger([]) }, rec, current)).toThrow(
      /proposal does not match its verification record/,
    )
    expect(() =>
      applyLedgerProposal({ ...proposal, body: { summary: 'other', changes: proposal.body.changes } }, rec, current),
    ).toThrow(/proposal does not match its verification record/)
  })

  test('a demotion is refused by the weaken guard naming the criterion', () => {
    const current = [ledgerEntry({ status: 'active' })]
    const rec = record({ outcome: 'fail', criteria: [{ criterionId: 'spec-up-200', outcome: 'fail' }] })
    const demotion = {
      schemaVersion: '1',
      runId: rec.runId,
      proposedAt: rec.timestamp,
      baseFingerprint: integrityOf(current),
      baseSha: rec.sha,
      outcome: 'fail' as const,
      body: {
        summary: 'run run-42: 0 criterion(s) proposed→active',
        changes: [{ criterion: 'spec-up-200', from: 'active' as const, to: 'retired' as const, reason: 'run run-42 wants it gone' }],
      },
      ledgerText: serializeLedger(current),
    }
    expect(() => applyLedgerProposal(demotion, rec, current)).toThrow(
      /criterion "spec-up-200" cannot be weakened by the run that needs it/,
    )
  })

  test('a proposal demoting a criterion the record claims passed is refused', () => {
    const current = [ledgerEntry({ status: 'active' }), ledgerEntry({ criterion: 'flow-login', status: 'proposed' })]
    const rec = record({ criteria: [{ criterionId: 'flow-login', outcome: 'pass' }] })
    const proposal = buildLedgerProposal(rec, current, integrityOf(current))
    expect(proposal.body.changes).toHaveLength(1)
    expect(() =>
      applyLedgerProposal({ ...proposal, baseSha: rec.sha, body: { summary: 'handwritten', changes: [{ criterion: 'spec-up-200', from: 'active', to: 'retired', reason: 'because' }] } }, rec, current),
    ).toThrow(/cannot be weakened by the run that needs it/)
  })
})
