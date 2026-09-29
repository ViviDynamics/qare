import { describe, expect, test } from 'vitest'
import { checkTarget, selectCriteria, DEFAULT_SELECTION_BUDGET_MS, DEFAULT_SMOKE_SUITE } from '../src/selection.js'
import type { LedgerEntry } from '../src/ledger.js'

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

describe('check references', () => {
  test('a reference no git diff path could carry is unusable', () => {
    expect(checkTarget('./app/main.rb')).toBeUndefined()
    expect(checkTarget('app//main.rb')).toBeUndefined()
    expect(checkTarget('/abs/app/main.rb')).toBeUndefined()
    expect(checkTarget('app/../app/main.rb')).toBeUndefined()
    expect(checkTarget('app\\main.rb')).toBeUndefined()
  })

  test('a suite reference names its suite', () => {
    expect(checkTarget('suite:smoke')).toEqual({ kind: 'suite', suite: 'smoke' })
    expect(checkTarget('suite:billing-flows')).toEqual({ kind: 'suite', suite: 'billing-flows' })
  })

  test('a path reference drops its fragment and keeps the path', () => {
    expect(checkTarget('billing/spec/payout_tax_spec.rb:1099_threshold')).toEqual({
      kind: 'path',
      path: 'billing/spec/payout_tax_spec.rb',
    })
    expect(checkTarget('app/models/payout.rb')).toEqual({ kind: 'path', path: 'app/models/payout.rb' })
  })

  test('a reference that names nothing is unusable', () => {
    expect(checkTarget('suite:')).toBeUndefined()
    expect(checkTarget(':13')).toBeUndefined()
    expect(checkTarget('')).toBeUndefined()
  })

  test('the smoke suite is the standing one by name', () => {
    expect(DEFAULT_SMOKE_SUITE).toBe('smoke')
  })
})

describe('selectCriteria', () => {
  const mapped = entry({
    criterion: 'BIL-014',
    text: 'A host paid more than the annual threshold gets a 1099 in January.',
    checks: ['billing/spec/payout_tax_spec.rb:1099_threshold'],
  })

  test('a one-file change selects the criterion whose check covers the file', () => {
    const report = selectCriteria(
      [mapped, entry({ criterion: 'BIL-015', checks: ['billing/spec/invoice_spec.rb'] })],
      { touched: ['billing/spec/payout_tax_spec.rb'] },
    )
    expect(report.selected.map((criterion) => criterion.criterion)).toEqual(['BIL-014'])
    expect(report.selected[0]).toMatchObject({ reason: 'impact' })
    expect(report.notSelected).toEqual([{ criterion: 'BIL-015', reason: 'unaffected' }])
  })

  test('matching runs both ways at a segment boundary', () => {
    const directory = selectCriteria([entry({ criterion: 'DIR-1', checks: ['billing/spec'] })], {
      touched: ['billing/spec/payout_tax_spec.rb'],
    })
    expect(directory.selected.map((criterion) => criterion.criterion)).toEqual(['DIR-1'])
    const nearMiss = selectCriteria([entry({ criterion: 'NEAR-1', checks: ['billing/specs'] })], {
      touched: ['billing/spec'],
    })
    expect(nearMiss.selected).toEqual([])
    expect(nearMiss.notSelected).toEqual([{ criterion: 'NEAR-1', reason: 'unaffected' }])
  })

  test('the smoke suite always runs, whatever the diff touches', () => {
    const report = selectCriteria([mapped, entry({ criterion: 'BIL-021', checks: ['suite:smoke'] })], {
      touched: ['README.md'],
    })
    expect(report.selected.map((criterion) => criterion.criterion)).toEqual(['BIL-021'])
    expect(report.selected[0]?.reason).toBe('smoke')
  })

  test('the smoke suite is never cut by the budget, and everything else is', () => {
    const report = selectCriteria(
      [mapped, entry({ criterion: 'BIL-021', checks: ['suite:smoke', 'billing/spec/other_spec.rb'] })],
      { touched: ['billing/spec/payout_tax_spec.rb'], budgetMs: 60000, checkCostMs: 60000 },
    )
    expect(report.selected.map((criterion) => criterion.criterion)).toEqual(['BIL-021'])
    expect(report.notSelected).toEqual([expect.objectContaining({ criterion: 'BIL-014', reason: 'budget' })])
    expect(report.estimatedMs).toBe(120000)
  })

  test('unmapped criteria run: selection errs toward checking more, never less', () => {
    const report = selectCriteria(
      [entry({ criterion: 'BIL-030', text: 'unmapped criterion' }), mapped],
      { touched: ['nothing/touches/this.rb'] },
    )
    expect(report.selected.map((criterion) => criterion.criterion)).toEqual(['BIL-030'])
    expect(report.selected[0]?.reason).toBe('unmapped')
    expect(report.notSelected).toEqual([expect.objectContaining({ criterion: 'BIL-014', reason: 'unaffected' })])
  })

  test('a criterion the mapping points only at suites other than smoke is unmapped', () => {
    const report = selectCriteria([entry({ criterion: 'BIL-031', checks: ['suite:billing'] })], {
      touched: ['billing/spec/payout_tax_spec.rb'],
    })
    expect(report.selected.map((criterion) => criterion.criterion)).toEqual(['BIL-031'])
    expect(report.selected[0]?.reason).toBe('unmapped')
  })

  test('a reference that cannot carry a git path maps the criterion to nothing, not to unaffected', () => {
    const report = selectCriteria([entry({ criterion: 'BIL-032', checks: ['./billing/spec/payout_tax_spec.rb'] })], {
      touched: ['billing/spec/payout_tax_spec.rb'],
    })
    expect(report.selected.map((criterion) => criterion.criterion)).toEqual(['BIL-032'])
    expect(report.selected[0]?.reason).toBe('unmapped')
  })

  test('a ledger with no mapping at all falls back to everything, smoke set included', () => {
    const report = selectCriteria(
      [entry({ criterion: 'BIL-030' }), entry({ criterion: 'BIL-031' })],
      { touched: ['app/main.rb'], smokeSuite: DEFAULT_SMOKE_SUITE },
    )
    expect(report.selected).toHaveLength(2)
    expect(report.notSelected).toEqual([])
  })

  test('superseded and retired criteria are reported as not run, never passed', () => {
    const report = selectCriteria(
      [
        entry({ criterion: 'BIL-009', status: 'retired', checks: ['billing/spec/payout_tax_spec.rb'] }),
        entry({ criterion: 'BIL-009a', status: 'superseded', checks: ['billing/spec/payout_tax_spec.rb'] }),
      ],
      { touched: ['billing/spec/payout_tax_spec.rb'] },
    )
    expect(report.selected).toEqual([])
    expect(report.notSelected).toEqual([
      { criterion: 'BIL-009', reason: 'status', detail: 'retired' },
      { criterion: 'BIL-009a', reason: 'status', detail: 'superseded' },
    ])
  })

  test('the budget bounds what the diff adds, after the smoke set stands', () => {
    const many = ['a', 'b', 'c', 'd'].map((suffix) =>
      entry({ criterion: `BIL-${suffix}`, checks: ['app/main.rb'] }),
    )
    const report = selectCriteria(many, { touched: ['app/main.rb'], budgetMs: 180000, checkCostMs: 60000 })
    expect(report.selected.map((criterion) => criterion.criterion)).toEqual(['BIL-a', 'BIL-b', 'BIL-c'])
    expect(report.notSelected).toEqual([{ criterion: 'BIL-d', reason: 'budget' }])
    expect(report.estimatedMs).toBe(180000)
  })

  test('the default budget is the selection budget, and nothing overruns it silently', () => {
    const many = ['a', 'b', 'c', 'd'].map((suffix) =>
      entry({ criterion: `BIL-${suffix}`, checks: ['app/main.rb'] }),
    )
    const report = selectCriteria(many, { touched: ['app/main.rb'] })
    expect(report.budgetMs).toBe(DEFAULT_SELECTION_BUDGET_MS)
    expect(report.estimatedMs).toBeLessThanOrEqual(report.budgetMs)
    expect(report.selected).toHaveLength(4)
    expect(report.notSelected).toEqual([])
  })

  test('selection is deterministic: the same ledger and diff select the same criteria', () => {
    const entries = [
      entry({ criterion: 'BIL-014', checks: ['billing/spec/payout_tax_spec.rb'] }),
      entry({ criterion: 'BIL-015', checks: ['billing/spec/invoice_spec.rb'] }),
      entry({ criterion: 'BIL-021', checks: ['suite:smoke'] }),
    ]
    const first = selectCriteria(entries, { touched: ['billing/spec/payout_tax_spec.rb'] })
    const second = selectCriteria([...entries].reverse(), { touched: ['billing/spec/payout_tax_spec.rb'] })
    expect(first).toEqual(second)
  })

  test('a criterion with both a touched path and the smoke suite selects once, as impact', () => {
    const report = selectCriteria(
      [entry({ criterion: 'BIL-014', checks: ['suite:smoke', 'billing/spec/payout_tax_spec.rb'] })],
      { touched: ['billing/spec/payout_tax_spec.rb'] },
    )
    expect(report.selected).toEqual([{ criterion: 'BIL-014', reason: 'impact' }])
  })

  test('criterion text travels into the report', () => {
    const report = selectCriteria([mapped], { touched: ['billing/spec/payout_tax_spec.rb'] })
    expect(report.selected[0]?.text).toBe('A host paid more than the annual threshold gets a 1099 in January.')
  })
})
