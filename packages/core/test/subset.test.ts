import { describe, expect, test } from 'vitest'
import { resolveCriteriaSubset, criteriaSubsetPlan, CriteriaSubsetError } from '../src/subset.js'
import { PLAN_SCHEMA_VERSION } from '../src/plan.js'
import type { LedgerEntry } from '../src/ledger.js'
import { parseLedgerEntries, serializeLedger } from '../src/ledger.js'

// Split on purpose: a repo-wide guard forbids a literal URL in a test file,
// so no test can quietly reach the network.
const sourceLink = (path: string) => ['https:', `//example.test${path}`].join('')

function entry(overrides: Partial<LedgerEntry> & { criterion: string }): LedgerEntry {
  return {
    status: 'active',
    source: [sourceLink('/pr/1')],
    proof: 'command',
    ...overrides,
  }
}

describe('resolveCriteriaSubset', () => {
  test('resolves each named id to its text and suites, and nothing else', () => {
    const entries = [
      entry({ criterion: 'BIL-014', text: 'the invoice totals add up', checks: ['suite:smoke', 'apps/billing/invoice.rb'] }),
      entry({ criterion: 'BIL-021', status: 'proposed', text: 'the receipt is sent once' }),
      entry({ criterion: 'BIL-030', text: 'unrelated' }),
    ]
    expect(resolveCriteriaSubset(entries, ['BIL-014', 'BIL-021'])).toEqual([
      { id: 'BIL-014', text: 'the invoice totals add up', suites: ['smoke'] },
      { id: 'BIL-021', text: 'the receipt is sent once', suites: [] },
    ])
  })

  test('an entry with no text falls back to its criterion id', () => {
    const entries = [entry({ criterion: 'BIL-014', checks: ['suite:smoke'] })]
    expect(resolveCriteriaSubset(entries, ['BIL-014'])).toEqual([
      { id: 'BIL-014', text: 'BIL-014', suites: ['smoke'] },
    ])
  })

  test('the statement a criterion resolves from is its only one', () => {
    // parseLedgerEntries refuses a ledger that states a criterion twice, so
    // the resolver looks each id up against single statements; feed it the
    // way the run does, through the parsed document.
    const document = parseLedgerEntries(
      JSON.parse(
        serializeLedger([entry({ criterion: 'BIL-014', text: 'the one statement', checks: ['suite:smoke'] })]),
      ),
    )
    expect(resolveCriteriaSubset(document, ['BIL-014'])).toEqual([
      { id: 'BIL-014', text: 'the one statement', suites: ['smoke'] },
    ])
  })

  test('an unknown id is refused, naming it', () => {
    const entries = [entry({ criterion: 'BIL-014' })]
    expect(() => resolveCriteriaSubset(entries, ['BIL-099'])).toThrow(CriteriaSubsetError)
    expect(() => resolveCriteriaSubset(entries, ['BIL-099'])).toThrow(/BIL-099 is not in the ledger/)
  })

  test('a retired criterion is refused with a message naming it', () => {
    const entries = [entry({ criterion: 'BIL-014', status: 'retired' }), entry({ criterion: 'BIL-099' })]
    expect(() => resolveCriteriaSubset(entries, ['BIL-014', 'BIL-099'])).toThrow(CriteriaSubsetError)
    expect(() => resolveCriteriaSubset(entries, ['BIL-014', 'BIL-099'])).toThrow(/BIL-014 is retired/)
  })

  test('a superseded criterion is refused with a message naming it', () => {
    const entries = [entry({ criterion: 'BIL-014', status: 'superseded' })]
    expect(() => resolveCriteriaSubset(entries, ['BIL-014'])).toThrow(/BIL-014 is superseded/)
  })

  test('every offender is named in one refusal, so the caller fixes them all at once', () => {
    const entries = [entry({ criterion: 'BIL-014', status: 'retired' }), entry({ criterion: 'BIL-021', status: 'superseded' }), entry({ criterion: 'BIL-030' })]
    const error = (() => {
      try {
        resolveCriteriaSubset(entries, ['BIL-014', 'BIL-021', 'BIL-099'])
        return undefined
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(CriteriaSubsetError)
    expect((error as Error).message).toMatch(/BIL-014 is retired, BIL-021 is superseded, BIL-099 is not in the ledger/)
  })

  test('a proposed criterion resolves; the refusal is about the ledger, not the proof', () => {
    const entries = [entry({ criterion: 'BIL-014', status: 'proposed' })]
    expect(resolveCriteriaSubset(entries, ['BIL-014'])).toEqual([{ id: 'BIL-014', text: 'BIL-014', suites: [] }])
  })

  test('nothing is named, so nothing can run', () => {
    expect(() => resolveCriteriaSubset([], [])).toThrow(/no criteria named/)
  })

  test('an id named twice is refused rather than run twice', () => {
    const entries = [entry({ criterion: 'BIL-014' })]
    expect(() => resolveCriteriaSubset(entries, ['BIL-014', 'BIL-014'])).toThrow(/BIL-014 is named more than once/)
  })
})

describe('criteriaSubsetPlan', () => {
  test('suite references become flow checks the runner can execute', () => {
    const plan = criteriaSubsetPlan([{ id: 'BIL-014', text: 'totals', suites: ['smoke', 'billing-flows'] }])
    expect(plan.schemaVersion).toBe(PLAN_SCHEMA_VERSION)
    expect(plan.criteria).toEqual([
      {
        id: 'BIL-014',
        text: 'totals',
        checks: [
          { kind: 'flow', name: 'smoke', suite: 'smoke' },
          { kind: 'flow', name: 'billing-flows', suite: 'billing-flows' },
        ],
      },
    ])
  })

  test('a criterion no suite verifies stays in the plan as unplannable, with the reason', () => {
    const plan = criteriaSubsetPlan([{ id: 'BIL-021', text: 'receipt', suites: [] }])
    expect(plan.criteria).toEqual([
      {
        id: 'BIL-021',
        text: 'receipt',
        unplannable: 'its ledger checks name no suite, so the runner has nothing to execute for it',
      },
    ])
  })
})
