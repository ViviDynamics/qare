import { describe, expect, test } from 'vitest'
import {
  MAIN_PASSES_PATH,
  MainPassesError,
  classifyMainRun,
  mainPassEntryDigest,
  mainPassesToRecord,
  parseMainPasses,
  parseResult,
  recordMainPasses,
  serializeMainPasses,
  standingMainPasses,
} from '../src/index.js'
import type { LedgerDocument, LedgerEntry, MainPasses, RunResult } from '../src/index.js'

// #295: what a run on the default branch proved, recorded beside the ledger
// so a later failure can be called a regression and traced to a change.

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function entry(criterion: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return { criterion, status: 'active', source: ['suite:billing'], proof: 'flow', text: `${criterion} holds.`, checks: ['suite:billing'], ...extra }
}

function ledger(entries: LedgerEntry[]): LedgerDocument {
  return { entries, changes: [] }
}

function result(verdict: RunResult['verdict'], criteria: unknown[]): RunResult {
  return parseResult({ schemaVersion: '1', verdict, criteria })
}

const RUN_A = { sha: SHA_A, at: '2026-10-08T12:00:00Z', run: 'main-1-1', recordedAt: '2026-10-08T12:09:00.000Z' }
const RUN_B = { sha: SHA_B, at: '2026-10-09T12:00:00Z', run: 'main-2-1', recordedAt: '2026-10-09T12:09:00.000Z' }
const EMPTY: MainPasses = { passes: {} }

describe('which criteria a run records a pass for', () => {
  test('the ones the judged result proved that the ledger carries as active, and no others', () => {
    const run = result('failed', [
      { id: 'BIL-014', outcome: 'proven', evidence: ['checks/BIL-014/0/stdout.txt'] },
      { id: 'BIL-021', outcome: 'failed', evidence: ['checks/BIL-021/0/stdout.txt'] },
      { id: 'BIL-030', outcome: 'unverified', reason: 'verifier gave no readable answer' },
      { id: 'PROPOSED', outcome: 'proven', evidence: ['checks/PROPOSED/0/stdout.txt'] },
      { id: 'RETIRED', outcome: 'proven', evidence: ['checks/RETIRED/0/stdout.txt'] },
      { id: 'NOT-IN-LEDGER', outcome: 'proven', evidence: ['checks/NOT-IN-LEDGER/0/stdout.txt'] },
    ])
    const book = ledger([entry('BIL-014'), entry('BIL-021'), entry('BIL-030'), entry('PROPOSED', { status: 'proposed' }), entry('RETIRED', { status: 'retired' })])
    expect(mainPassesToRecord(run, book)).toEqual(['BIL-014'])
  })

  test('a run that proved nothing records nothing', () => {
    const run = result('blocked', [{ id: 'BIL-014', outcome: 'unverified', reason: 'boot did not come up' }])
    expect(mainPassesToRecord(run, ledger([entry('BIL-014')]))).toEqual([])
  })
})

describe('the record', () => {
  test('a run\'s passes are written over the ones it had, and a criterion it did not prove keeps its pass', () => {
    const book = ledger([entry('BIL-014'), entry('BIL-021')])
    const first = recordMainPasses(EMPTY, RUN_A, ['BIL-014', 'BIL-021'], book)
    const second = recordMainPasses(first, RUN_B, ['BIL-021'], book)
    expect(second.passes['BIL-014']).toMatchObject({ sha: SHA_A, at: RUN_A.at, run: 'main-1-1' })
    expect(second.passes['BIL-021']).toMatchObject({ sha: SHA_B, at: RUN_B.at, run: 'main-2-1' })
    // Only the ledger's active criteria are ever written, whatever is asked.
    const third = recordMainPasses(second, RUN_B, ['NOT-IN-LEDGER'], book)
    expect(Object.keys(third.passes)).toEqual(['BIL-014', 'BIL-021'])
  })

  test('is written the same for the same passes, and reads back as it was written', () => {
    const book = ledger([entry('BIL-021'), entry('BIL-014')])
    const store = recordMainPasses(EMPTY, RUN_A, ['BIL-021', 'BIL-014'], book)
    const text = serializeMainPasses(store)
    expect(text).toBe(serializeMainPasses(recordMainPasses(EMPTY, RUN_A, ['BIL-014', 'BIL-021'], book)))
    expect(parseMainPasses(text)).toEqual(store)
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: '1' })
    expect(MAIN_PASSES_PATH).toBe('passes/main.json')
  })

  test('is read strictly: what it does not expect is an error by name, never no record', () => {
    const good = JSON.parse(serializeMainPasses(recordMainPasses(EMPTY, RUN_A, ['BIL-014'], ledger([entry('BIL-014')]))))
    const refused = (mutate: (document: { schemaVersion: unknown; extra?: unknown; passes: Record<string, Record<string, unknown>> }) => void): string => {
      const document = structuredClone(good)
      mutate(document)
      try {
        parseMainPasses(JSON.stringify(document))
      } catch (error) {
        expect(error).toBeInstanceOf(MainPassesError)
        return (error as Error).message
      }
      throw new Error('expected the record to be refused')
    }
    expect(refused((document) => (document.schemaVersion = '2'))).toContain('schemaVersion')
    expect(refused((document) => (document.extra = true))).toContain('document.extra')
    expect(refused((document) => void Object.assign(document, { passes: [] }))).toContain('document.passes')
    expect(refused((document) => void Object.assign(document.passes['BIL-014'] ?? {}, { sha: 'main' }))).toContain('.sha')
    expect(refused((document) => void Object.assign(document.passes['BIL-014'] ?? {}, { at: 'yesterday' }))).toContain('.at')
    expect(refused((document) => void Object.assign(document.passes['BIL-014'] ?? {}, { run: 'one\ntwo' }))).toContain('.run')
    expect(refused((document) => void Object.assign(document.passes['BIL-014'] ?? {}, { entry: 'nope' }))).toContain('.entry')
    expect(refused((document) => void Object.assign(document.passes['BIL-014'] ?? {}, { verdict: 'passed' }))).toContain('.verdict')
    expect(refused((document) => void Object.assign(document.passes, { 'a/b': document.passes['BIL-014'] }))).toContain('a/b')
    expect(() => parseMainPasses('{"schemaVersion":')).toThrow(MainPassesError)
    expect(() => parseMainPasses('[]')).toThrow(MainPassesError)
  })
})

describe('a pass is of one wording', () => {
  test('a criterion whose text, proof or checks changed since has no standing pass, and one whose status, note or sources changed still has', () => {
    const before = ledger([entry('BIL-014'), entry('BIL-021'), entry('BIL-030'), entry('BIL-040'), entry('BIL-050')])
    const store = recordMainPasses(EMPTY, RUN_A, ['BIL-014', 'BIL-021', 'BIL-030', 'BIL-040', 'BIL-050'], before)
    const after = ledger([
      entry('BIL-014', { text: 'BIL-014 holds, and more.' }),
      entry('BIL-021', { checks: ['suite:other'] }),
      entry('BIL-030', { proof: 'command' }),
      entry('BIL-040', { note: 'reviewed', source: ['suite:billing', 'elsewhere'] }),
      // BIL-050 is gone from the ledger.
    ])
    expect([...standingMainPasses(store, after).keys()]).toEqual(['BIL-040'])
    expect(mainPassEntryDigest(entry('BIL-014'))).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('classifying a run on main against the record', () => {
  const book = ledger([entry('BIL-014'), entry('BIL-021')])
  const failed = result('failed', [
    { id: 'BIL-014', outcome: 'failed', evidence: ['checks/BIL-014/0/stdout.txt'] },
    { id: 'BIL-021', outcome: 'failed', evidence: ['checks/BIL-021/0/stdout.txt'] },
  ])

  test('a failed criterion with a recorded pass is a regression, with the revision, the time and the run it last passed in', () => {
    const store = recordMainPasses(EMPTY, RUN_A, ['BIL-014'], book)
    const classified = classifyMainRun(failed, book, store)
    expect(classified.findings.map((finding) => [finding.criterionId, finding.kind])).toEqual([
      ['BIL-014', 'regression'],
      ['BIL-021', 'failure'],
    ])
    expect(classified.findings[0]?.lastProven).toEqual({ run: 'main-1-1', at: RUN_A.at, sha: SHA_A })
    expect(classified.findings[1]?.lastProven).toBeUndefined()
  })

  test('without a record, and with a pass of other wording, a failure is not called a regression', () => {
    expect(classifyMainRun(failed, book).findings.map((finding) => finding.kind)).toEqual(['failure', 'failure'])
    const store = recordMainPasses(EMPTY, RUN_A, ['BIL-014'], book)
    const reworded = ledger([entry('BIL-014', { text: 'Something else.' }), entry('BIL-021')])
    expect(classifyMainRun(failed, reworded, store).findings.map((finding) => finding.kind)).toEqual(['failure', 'failure'])
  })

  test('of a pass the ledger records and one the record holds, the later is the last pass', () => {
    const store = recordMainPasses(EMPTY, RUN_B, ['BIL-014'], book)
    const older: LedgerDocument = {
      ...book,
      changes: [{ seq: 1, kind: 'verify', actor: 'run-9', timestamp: '2026-09-28T04:17:00.000Z', reason: 'run run-9: pass', criteria: ['BIL-014'], digest: 'unchecked-here' }],
    }
    expect(classifyMainRun(failed, older, store).findings[0]?.lastProven).toEqual({ run: 'main-2-1', at: RUN_B.at, sha: SHA_B })
    const newer: LedgerDocument = {
      ...book,
      changes: [{ seq: 1, kind: 'verify', actor: 'run-99', timestamp: '2026-10-20T04:17:00.000Z', reason: 'run run-99: pass', criteria: ['BIL-014'], digest: 'unchecked-here' }],
    }
    expect(classifyMainRun(failed, newer, store).findings[0]?.lastProven).toEqual({ run: 'run-99', at: '2026-10-20T04:17:00.000Z' })
  })
})
