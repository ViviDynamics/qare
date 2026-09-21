import { describe, expect, test } from 'vitest'
import { serializeLedger, type LedgerEntry } from '../src/ledger.js'
import {
  buildLedgerProposal,
  parseVerificationRecord,
  VerificationRecordValidationError,
} from '../src/ledger-proposal.js'

const SHA_LOWER = 'abcdef0123abcdef0123abcdef0123abcdef0123'
const SHA_UPPER = 'ABCDEF0123ABCDEF0123ABCDEF0123ABCDEF0123'

const link = (host: string, path: string) => ['https:', `//${host}${path}`].join('')

function recordFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-42',
    sha: SHA_LOWER,
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
    source: [link('example.test', '/pr/1')],
    proof: 'command',
    ...overrides,
  }
}

describe('parseVerificationRecord', () => {
  test('round-trips a well-formed record and normalizes sha case', () => {
    const parsed = parseVerificationRecord(recordFixture({ sha: SHA_UPPER }))
    expect(parsed).toEqual({
      runId: 'run-42',
      sha: SHA_LOWER,
      outcome: 'pass',
      evidence: ['evidence/comment-1.json'],
      timestamp: '2026-09-21T00:00:00.000Z',
      criteria: [{ criterionId: 'spec-up-200', outcome: 'pass' }],
    })
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
  })

  test('accepts a seconds-precision UTC instant', () => {
    const parsed = parseVerificationRecord(recordFixture({ timestamp: '2026-09-21T12:34:56Z' }))
    expect(parsed.timestamp).toBe('2026-09-21T12:34:56.000Z')
  })

  test('rejects malformed values with named errors', () => {
    const bad = (input: unknown, message: RegExp | string): void => {
      expect(() => parseVerificationRecord(input), String(message)).toThrow(
        VerificationRecordValidationError,
      )
      expect(() => parseVerificationRecord(input), String(message)).toThrow(message)
    }

    bad(null, /must be a JSON object/)
    bad('nope', /must be a JSON object/)
    bad(recordFixture({ runId: '' }), /runId: run id must be a non-empty string/)
    bad(recordFixture({ runId: '  ' }), /runId: run id must be a non-empty string/)
    bad(recordFixture({ sha: 'tooshort' }), /must be a 40-character hex commit sha/)
    bad(recordFixture({ sha: 'z'.repeat(40) }), /must be a 40-character hex commit sha/)
    bad(recordFixture({ sha: 123 }), /must be a 40-character hex commit sha/)
    bad(recordFixture({ timestamp: '2026-09-21' }), /timestamp .*strict ISO-8601 instant/)
    bad(recordFixture({ timestamp: '2026-02-31T00:00:00Z' }), /timestamp .*strict ISO-8601 instant/)
    bad(recordFixture({ timestamp: '2026-09-21T00:00:00+02:00' }), /timestamp .*strict ISO-8601 instant/)
    bad(recordFixture({ timestamp: 42 }), /timestamp .*must be a non-empty string/)
    bad(recordFixture({ outcome: 'passed' }), /outcome: unknown outcome "passed" \(/)
    bad(recordFixture({ evidence: [] }), /evidence: must carry at least one evidence reference/)
    bad(recordFixture({ evidence: ['ok', ''] }), /evidence\[1\]: evidence reference must be a non-empty string/)
    bad(recordFixture({ evidence: ['bad\nnewline'] }), /evidence\[0\]: evidence reference must not contain newlines/)
    bad(recordFixture({ evidence: 'evidence/comment-1.json' }), /evidence: must be an array of evidence references/)
    bad(recordFixture({ extra: 1 }), /extra: unknown field in verification record/)
    bad(recordFixture({ criteria: [{ criterionId: 'a', outcome: 'pass', extra: 1 }] }), /criteria\[0\].extra: unknown field in verification criterion/)
    bad(recordFixture({ criteria: [{ criterionId: 'a', outcome: 'promoted' }] }), /criteria\[0\].outcome: unknown outcome "promoted"/)
    bad(recordFixture({ criteria: [{ criterionId: 'a:b', outcome: 'pass' }] }), /criteria\[0\].criterionId: unknown namespace in criterion id "a:b"/)
    bad(recordFixture({ criteria: [{ criterionId: '../escape', outcome: 'pass' }] }), /path separators, "\.\." or control characters/)
    bad(recordFixture({ criteria: [{ criterionId: 'a\u0000b', outcome: 'pass' }] }), /path separators, "\.\." or control characters/)
    bad(recordFixture({ criteria: [{ criterionId: '', outcome: 'pass' }] }), /criteria\[0\].criterionId: criterion id must be a non-empty string/)
    bad(recordFixture({ criteria: 'nope' }), /criteria: must be an array of criterion outcomes/)
  })
})

describe('buildLedgerProposal', () => {
  const baseFingerprint = 'fp-9f2c1e'

  test('pass promotes proposed→active only; already-active is untouched', () => {
    const current = [
      ledgerEntry(),
      ledgerEntry({ criterion: 'other-thing', status: 'active' }),
    ]
    const parsed = parseVerificationRecord(
      recordFixture({ criteria: [{ criterionId: 'spec-up-200', outcome: 'pass' }, { criterionId: 'other-thing', outcome: 'pass' }] }),
    )
    const proposal = buildLedgerProposal(parsed, current, baseFingerprint)
    expect(proposal).toEqual({
      schemaVersion: '1',
      runId: 'run-42',
      proposedAt: '2026-09-21T00:00:00.000Z',
      baseFingerprint: 'fp-9f2c1e',
      baseSha: SHA_LOWER,
      outcome: 'pass',
      body: {
        summary: 'run run-42: 1 criterion(s) proposed→active',
        changes: [
          {
            criterion: 'spec-up-200',
            from: 'proposed',
            to: 'active',
            reason: 'run run-42: pass on "spec-up-200" promotes proposed → active',
          },
        ],
      },
      ledgerText: serializeLedger(current),
    })
  })

  test('identical-text already-active criteria produce no changes', () => {
    const current = [ledgerEntry({ status: 'active' })]
    const parsed = parseVerificationRecord(recordFixture())
    const proposal = buildLedgerProposal(parsed, current, baseFingerprint)
    expect(proposal.body.changes).toEqual([])
    expect(proposal.body.summary).toBe('run run-42: 0 criterion(s) proposed→active')
    expect(proposal.ledgerText).toBe(serializeLedger(current))
  })

  test('fail, waived and absent criteria never change the ledger', () => {
    const current = [ledgerEntry({ status: 'proposed' }), ledgerEntry({ criterion: 'kept-2', status: 'active' })]
    const failRun = parseVerificationRecord(
      recordFixture({ outcome: 'fail', criteria: [{ criterionId: 'spec-up-200', outcome: 'fail' }] }),
    )
    expect(buildLedgerProposal(failRun, current, baseFingerprint).body.changes).toEqual([])

    const waivedRun = parseVerificationRecord(
      recordFixture({ outcome: 'waived', criteria: [{ criterionId: 'spec-up-200', outcome: 'waived' }] }),
    )
    expect(buildLedgerProposal(waivedRun, current, baseFingerprint).body.changes).toEqual([])

    const absentRun = parseVerificationRecord(
      recordFixture({ criteria: [{ criterionId: 'ghost-criterion', outcome: 'pass' }] }),
    )
    expect(buildLedgerProposal(absentRun, current, baseFingerprint).body.changes).toEqual([])

    for (const proposal of [
      buildLedgerProposal(failRun, current, baseFingerprint),
      buildLedgerProposal(waivedRun, current, baseFingerprint),
      buildLedgerProposal(absentRun, current, baseFingerprint),
    ]) {
      expect(proposal.ledgerText).toBe(serializeLedger(current))
    }
  })

  test('summary is deterministic and counts promotions in order', () => {
    const current = [ledgerEntry(), ledgerEntry({ criterion: 'kept-2', status: 'proposed' }), ledgerEntry({ criterion: 'kept-3', status: 'proposed' })]
    const parsed = parseVerificationRecord(
      recordFixture({
        criteria: [
          { criterionId: 'kept-3', outcome: 'pass' },
          { criterionId: 'spec-up-200', outcome: 'pass' },
          { criterionId: 'kept-2', outcome: 'pass' },
        ],
      }),
    )
    const first = buildLedgerProposal(parsed, current, baseFingerprint)
    const second = buildLedgerProposal(parsed, current, baseFingerprint)
    expect(first.body.changes.map((change) => change.criterion)).toEqual(['kept-3', 'spec-up-200', 'kept-2'])
    expect(first.body.summary).toBe('run run-42: 3 criterion(s) proposed→active')
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  test('the proposal is a plain serializable payload', () => {
    const current = [ledgerEntry()]
    const parsed = parseVerificationRecord(recordFixture())
    const proposal = buildLedgerProposal(parsed, current, baseFingerprint)
    expect(JSON.parse(JSON.stringify(proposal))).toEqual(proposal)
  })
})

test('duplicate criterion ids in the record fail closed', () => {
  expect(() =>
    parseVerificationRecord(
      recordFixture({
        criteria: [
          { criterionId: 'spec-up-200', outcome: 'pass' },
          { criterionId: 'spec-up-200', outcome: 'fail' },
        ],
      }),
    ),
  ).toThrow(/duplicate criterion "spec-up-200"/)
})

test('timestamp is normalized to canonical millisecond precision', () => {
  const parsed = parseVerificationRecord(recordFixture({ timestamp: '2026-09-21T12:34:56Z' }))
  expect(parsed.timestamp).toBe('2026-09-21T12:34:56.000Z')
  expect(() => parseVerificationRecord(recordFixture({ timestamp: '2026-02-31T00:00:00.000Z' }))).toThrow(
    /strict ISO-8601 instant/,
  )
})
