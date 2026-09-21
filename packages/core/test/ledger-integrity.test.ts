import { describe, expect, test } from 'vitest'
import {
  integrityOf,
  parseLedgerEntries,
  serializeLedger,
  type LedgerEntry,
  type LedgerStatus,
} from '../src/ledger.js'

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    criterion: 'spec-up-200',
    status: 'active',
    source: ['https:' + '//example.test/pr/1'],
    proof: 'command',
    ...overrides,
  }
}

describe('ledger integrity', () => {
  test('serialize embeds a deterministic content hash', () => {
    const entries = [entry(), entry({ criterion: 'other-criterion' })]
    expect(integrityOf(entries)).toBe(integrityOf([...entries].reverse()))
    expect(integrityOf([entry({ status: 'retired' as LedgerStatus })])).not.toBe(integrityOf(entries))
    expect(JSON.parse(serializeLedger(entries)).integrity).toBe(integrityOf(entries))
  })

  test('round-trips a document with its integrity field', () => {
    const parsed = parseLedgerEntries(JSON.parse(serializeLedger([entry()])))
    expect(parsed).toEqual([entry()])
  })

  test('tampered documents fail closed with named errors', () => {
    const good = JSON.parse(serializeLedger([entry(), entry({ criterion: 'flow-login', status: 'proposed' })]))
    expect(() => parseLedgerEntries({ ...good, integrity: 'sha256:' + '0'.repeat(64) })).toThrow(
      /ledger integrity check failed: expected sha256:.../,
    )
    expect(() => parseLedgerEntries({ entries: good.entries, schemaVersion: '1' })).toThrow(
      /ledger integrity check failed: expected sha256:..+, got undefined/,
    )
    expect(() => parseLedgerEntries({ ...good, integrity: 'md5:deadbeef' })).toThrow(
      /ledger integrity check failed/,
    )
  })

  test('a single flipped status byte is tamper, not format drift', () => {
    const text = serializeLedger([entry()])
    const doc = JSON.parse(text)
    doc.entries[0].status = 'proposed'
    expect(() => parseLedgerEntries(doc)).toThrow(/ledger integrity check failed/)
  })
})
