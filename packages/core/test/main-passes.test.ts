import { describe, expect, test } from 'vitest'
import {
  MAIN_PASSES_PATH,
  MainPassesError,
  mainPassesPath,
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

  test('a run whose revision is not ahead of a recorded pass leaves that pass exactly as it is', () => {
    // A run that was started first and finished last, or was run again days
    // later. It reads its own revision's ledger, which may word a criterion
    // differently and may not carry criteria added since. Whatever it
    // proved, it is not the last word on a pass of a later revision: it
    // neither replaces it nor drops it.
    const newer = ledger([entry('BIL-014', { text: 'New words.' }), entry('NEW-001')])
    const later = recordMainPasses(EMPTY, RUN_B, ['BIL-014', 'NEW-001'], newer)
    const older = ledger([entry('BIL-014'), entry('BIL-021')])
    const notBehind = (): boolean => false
    const afterOlder = recordMainPasses(later, RUN_A, ['BIL-014', 'BIL-021'], older, notBehind)
    expect(afterOlder.passes['BIL-014']).toEqual(later.passes['BIL-014'])
    expect(afterOlder.passes['NEW-001']).toEqual(later.passes['NEW-001'])
    // What the late run proved that has no pass yet is recorded: it is a true pass and the only one.
    expect(afterOlder.passes['BIL-021']).toMatchObject({ sha: SHA_A })
    // The same revision proven again is the same pass, by the run that proved it last.
    const again = recordMainPasses(later, { ...RUN_B, run: 'main-3-1' }, ['BIL-014'], newer, notBehind)
    expect(again.passes['BIL-014']).toMatchObject({ sha: SHA_B, run: 'main-3-1' })
    // And a run that is ahead of the recorded revision writes over it and prunes, as ever.
    const ahead = recordMainPasses(later, { ...RUN_B, sha: 'c'.repeat(40) }, ['BIL-014'], ledger([entry('BIL-014', { text: 'New words.' })]), (sha) => sha === SHA_B)
    expect(Object.keys(ahead.passes)).toEqual(['BIL-014'])
    expect(ahead.passes['BIL-014']).toMatchObject({ sha: 'c'.repeat(40) })
  })

  test('a pass of a criterion the ledger no longer carries is dropped when the record is next written, so the record does not only grow', () => {
    const before = ledger([entry('BIL-014'), entry('GONE')])
    const store = recordMainPasses(EMPTY, RUN_A, ['BIL-014', 'GONE'], before)
    const after = recordMainPasses(store, RUN_B, ['BIL-014'], ledger([entry('BIL-014')]))
    expect(Object.keys(after.passes)).toEqual(['BIL-014'])
  })

  test('every criterion id the ledger takes has a pass of its own, the ones an object would mistake for its own machinery among them', () => {
    // The ledger's schema allows these ids, so the record holds them like any other.
    const odd = ['__proto__', 'constructor', 'toString', 'hasOwnProperty']
    const book = ledger([...odd.map((id) => entry(id)), entry('BIL-014')])
    // Nothing recorded yet: none of them has a pass, whatever an object inherits.
    expect([...standingMainPasses(EMPTY, book).keys()]).toEqual([])
    expect(classifyMainRun(result('failed', odd.map((id) => ({ id, outcome: 'failed', evidence: ['checks/x/0/stdout.txt'] }))), book, EMPTY).findings.map((finding) => finding.kind)).toEqual(odd.map(() => 'failure'))
    const store = parseMainPasses(serializeMainPasses(recordMainPasses(EMPTY, RUN_A, [...odd, 'BIL-014'], book)))
    expect(Object.keys(store.passes).sort()).toEqual([...odd, 'BIL-014'].sort())
    expect([...standingMainPasses(store, book).keys()].sort()).toEqual([...odd, 'BIL-014'].sort())
    // Written over like any other, and kept when the run did not prove them.
    const again = recordMainPasses(store, RUN_B, ['__proto__'], book)
    expect(Object.getOwnPropertyDescriptor(again.passes, '__proto__')?.value).toMatchObject({ sha: SHA_B })
    expect(Object.getOwnPropertyDescriptor(again.passes, 'constructor')?.value).toMatchObject({ sha: SHA_A })
    expect(Object.getPrototypeOf(again.passes)).toBe(Object.prototype)
  })

  test('a moment that is no moment of the calendar is refused, not read as another day', () => {
    const good = serializeMainPasses(recordMainPasses(EMPTY, RUN_A, ['BIL-014'], ledger([entry('BIL-014')])))
    for (const impossible of ['2026-02-31T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-08T24:30:00Z', '2026-04-31T12:00:00.000Z'])
      expect(() => parseMainPasses(good.replace(RUN_A.at, impossible)), impossible).toThrow(MainPassesError)
    // With and without a fraction of a second, a real moment is taken.
    for (const real of ['2026-02-28T23:59:59Z', '2024-02-29T00:00:00.5Z', '2026-10-08T12:00:00.000Z'])
      expect(parseMainPasses(good.replace(RUN_A.at, real)).passes['BIL-014']?.at, real).toBe(real)
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

  test('each profile of a repository has a record of its own, so one profile never drops another\'s passes', () => {
    // The usual profile keeps the one path every single-profile repository has.
    for (const usual of [undefined, '', '.qa', './.qa', '.qa/']) expect(mainPassesPath(usual)).toBe('passes/main.json')
    expect(mainPassesPath('services/web/qa')).toBe('passes/profiles/services/web/qa/main.json')
    expect(mainPassesPath('./services/api/.qa/')).toBe('passes/profiles/services/api/.qa/main.json')
    // Two directories are two records, however alike their names: the path is the directory itself.
    expect(mainPassesPath('qa/web')).not.toBe(mainPassesPath('qa-web'))
    // And none of them can sit on the usual record or inside another's.
    expect(mainPassesPath('main.json')).toBe('passes/profiles/main.json/main.json')
    expect(mainPassesPath('services/web/qa')).not.toBe(mainPassesPath('services/api/qa'))
    // A name is a path segment on a branch: nothing that climbs or hides.
    for (const bad of ['..', '../x', 'a/../b', 'a b', 'a\nb', '/', '.']) expect(() => mainPassesPath(bad), bad).toThrow(MainPassesError)
  })

  test('the order of a criterion\'s checks is no part of what a pass is of', () => {
    expect(mainPassEntryDigest(entry('BIL-014', { checks: ['suite:a', 'app/x'] }))).toBe(mainPassEntryDigest(entry('BIL-014', { checks: ['app/x', 'suite:a'] })))
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
    expect(classified.findings[0]?.lastProven).toEqual({ run: 'main-1-1', at: RUN_A.at, sha: SHA_A, recordedAt: RUN_A.recordedAt })
    expect(classified.findings[1]?.lastProven).toBeUndefined()
  })

  test('without a record, and with a pass of other wording, a failure is not called a regression', () => {
    expect(classifyMainRun(failed, book).findings.map((finding) => finding.kind)).toEqual(['failure', 'failure'])
    const store = recordMainPasses(EMPTY, RUN_A, ['BIL-014'], book)
    const reworded = ledger([entry('BIL-014', { text: 'Something else.' }), entry('BIL-021')])
    expect(classifyMainRun(failed, reworded, store).findings.map((finding) => finding.kind)).toEqual(['failure', 'failure'])
  })

  test('a criterion that fails on the very revision it passed on is a failure of that revision, whatever older pass the ledger records', () => {
    const store = recordMainPasses(EMPTY, RUN_A, ['BIL-014'], book)
    // The ledger also carries an older verify record for it: it must not be fallen back on.
    const withVerify: LedgerDocument = {
      ...book,
      changes: [{ seq: 1, kind: 'verify', actor: 'run-9', timestamp: '2026-09-28T04:17:00.000Z', reason: 'run run-9: pass', criteria: ['BIL-014'], digest: 'unchecked-here' }],
    }
    for (const ledgerOf of [book, withVerify]) {
      const finding = classifyMainRun(failed, ledgerOf, store, SHA_A).findings[0]
      expect(finding?.kind).toBe('failure')
      expect(finding?.lastProven).toBeUndefined()
      expect(finding?.passedHere).toEqual({ run: 'main-1-1', recordedAt: RUN_A.recordedAt })
    }
    // Where the run's own base side proved it and its head failed it, that is
    // the run's own evidence of a regression, and it is not talked over: the
    // finding is a regression and does not also say it is none.
    const based = result('failed', [{ id: 'BIL-014', outcome: 'failed', evidence: ['checks/BIL-014/0/stdout.txt'], base: { outcome: 'proven', evidence: ['base/checks/BIL-014/0/stdout.txt'] }, regression: true }])
    const basedFinding = classifyMainRun(based, book, store, SHA_A).findings[0]
    expect(basedFinding?.kind).toBe('regression')
    expect(basedFinding?.passedHere).toBeUndefined()
    // And the pass of this very revision is not its last pass either: there is no change since it to count.
    expect(basedFinding?.lastProven).toBeUndefined()
    // With an older pass in the ledger's own history, that one is the last pass.
    expect(classifyMainRun(based, withVerify, store, SHA_A).findings[0]?.lastProven).toEqual({ run: 'run-9', at: '2026-09-28T04:17:00.000Z' })
    // Checked at another revision, the same pass is an earlier one: a regression.
    expect(classifyMainRun(failed, book, store, SHA_B).findings[0]).toMatchObject({ kind: 'regression', lastProven: { sha: SHA_A } })
    expect(classifyMainRun(failed, book, store, SHA_B).findings[0]?.passedHere).toBeUndefined()
  })

  test('of a pass the ledger records and one the record holds, the later is the last pass', () => {
    const store = recordMainPasses(EMPTY, RUN_B, ['BIL-014'], book)
    const older: LedgerDocument = {
      ...book,
      changes: [{ seq: 1, kind: 'verify', actor: 'run-9', timestamp: '2026-09-28T04:17:00.000Z', reason: 'run run-9: pass', criteria: ['BIL-014'], digest: 'unchecked-here' }],
    }
    expect(classifyMainRun(failed, older, store).findings[0]?.lastProven).toEqual({ run: 'main-2-1', at: RUN_B.at, sha: SHA_B, recordedAt: RUN_B.recordedAt })
    const newer: LedgerDocument = {
      ...book,
      changes: [{ seq: 1, kind: 'verify', actor: 'run-99', timestamp: '2026-10-20T04:17:00.000Z', reason: 'run run-99: pass', criteria: ['BIL-014'], digest: 'unchecked-here' }],
    }
    expect(classifyMainRun(failed, newer, store).findings[0]?.lastProven).toEqual({ run: 'run-99', at: '2026-10-20T04:17:00.000Z' })
  })
})
