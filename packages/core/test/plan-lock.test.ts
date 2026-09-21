import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { comparePlan, fingerprintPlan, loadPlan, lockPlan, parsePlan, type Plan } from '../src/index.js'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')

const basePlanInput = {
  schemaVersion: '1',
  criteria: [
    { id: 'c1', text: 'first criterion.', checks: [{ kind: 'command', name: 'n1', command: 'x' }] },
    { id: 'c2', text: 'second criterion.', checks: [{ kind: 'visual', name: 'n2', screenshot: 's', widths: [1440, 390], themes: ['light', 'dark'] }] },
    { id: 'c3', text: 'third criterion.', unplannable: 'no data reachable' },
  ],
}

const basePlan = parsePlan(basePlanInput)

function planWithCriterion1Checks(checks: unknown[]): Plan {
  return parsePlan({
    schemaVersion: '1',
    criteria: [{ id: 'c1', text: 'first criterion.', checks }],
  })
}

test('the fingerprint is stable across key insertion order', () => {
  const a: Plan = {
    schemaVersion: '1',
    criteria: [{ id: 'c1', text: 't', checks: [{ kind: 'command', name: 'n', command: 'x', inferred: true }] }],
  }
  const b: Plan = {
    criteria: [{ checks: [{ command: 'x', name: 'n', kind: 'command', inferred: true }], text: 't', id: 'c1' }],
    schemaVersion: '1',
  }
  expect(fingerprintPlan(a)).toBe(fingerprintPlan(b))
  expect(fingerprintPlan(a)).toMatch(/^[0-9a-f]{64}$/)
})

test('lock then compare the same plan with different key insertion order matches with no findings', () => {
  const reordered = parsePlan({
    criteria: [
      { unplannable: 'no data reachable', text: 'third criterion.', id: 'c3' },
      { text: 'second criterion.', id: 'c2', checks: [{ widths: [1440, 390], themes: ['light', 'dark'], screenshot: 's', name: 'n2', kind: 'visual' }] },
      { checks: [{ command: 'x', name: 'n1', kind: 'command' }], text: 'first criterion.', id: 'c1' },
    ],
    schemaVersion: '1',
  })
  const { locked, fingerprint } = lockPlan(reordered)
  expect(fingerprint).toBe(fingerprintPlan(basePlan))
  expect(comparePlan(reordered, locked)).toEqual({ matches: true, findings: [] })
})

test('lockPlan returns the canonicalized locked plan: criteria sorted by id, checks sorted canonically', () => {
  const shuffled = parsePlan({
    schemaVersion: '1',
    criteria: [
      { id: 'c2', text: 'second.', checks: [{ kind: 'command', name: 'b', command: 'x' }, { kind: 'command', name: 'a', command: 'x' }] },
      { id: 'c1', text: 'first.', checks: [{ kind: 'command', name: 'n', command: 'x' }] },
    ],
  })
  const { locked, fingerprint } = lockPlan(shuffled)
  expect(locked.criteria.map(criterion => criterion.id)).toEqual(['c1', 'c2'])
  const c2 = locked.criteria[1]
  expect(c2 && 'checks' in c2 ? c2.checks.map(check => check.name) : []).toEqual(['a', 'b'])
  expect(fingerprint).toBe(fingerprintPlan(parsePlan({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: 'first.', checks: [{ kind: 'command', name: 'n', command: 'x' }] },
      { id: 'c2', text: 'second.', checks: [{ kind: 'command', name: 'a', command: 'x' }, { kind: 'command', name: 'b', command: 'x' }] },
    ],
  })))
})

test('a modified check command is a mismatch with a finding naming the criterion, the field, before and after', () => {
  const { locked } = lockPlan(basePlan)
  const current = parsePlan({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: 'first criterion.', checks: [{ kind: 'command', name: 'n1', command: 'y' }] },
      { id: 'c2', text: 'second criterion.', checks: [{ kind: 'visual', name: 'n2', screenshot: 's', widths: [1440, 390], themes: ['light', 'dark'] }] },
      { id: 'c3', text: 'third criterion.', unplannable: 'no data reachable' },
    ],
  })
  const comparison = comparePlan(current, locked)
  expect(comparison.matches).toBe(false)
  expect(comparison.findings).toEqual(['criterion c1: check 0 changed: command "x" -> "y"'])
})

test('a modified check name is found even when the canonical sort order shifts', () => {
  const { locked } = lockPlan(planWithCriterion1Checks([
    { kind: 'command', name: 'a', command: 'x' },
    { kind: 'command', name: 'b', command: 'x' },
  ]))
  const current = planWithCriterion1Checks([
    { kind: 'command', name: 'b', command: 'x' },
    { kind: 'command', name: 'a2', command: 'x' },
  ])
  expect(comparePlan(current, locked).findings).toEqual(['criterion c1: check 0 changed: name "a" -> "a2"'])
})

test('the fingerprint changes when any check field changes', () => {
  const locked = fingerprintPlan(basePlan)
  const mutations = [
    parsePlan({ ...basePlanInput, criteria: [{ id: 'c1', text: 'first criterion.', checks: [{ kind: 'command', name: 'n1', command: 'x2' }] }] }),
    parsePlan({ ...basePlanInput, criteria: [{ id: 'c1', text: 'first criterion.', checks: [{ kind: 'command', name: 'n1x', command: 'x' }] }] }),
    parsePlan({ ...basePlanInput, criteria: [{ id: 'c1', text: 'first criterion.', checks: [{ kind: 'command', name: 'n1', command: 'x', inferred: true }] }] }),
    parsePlan({ ...basePlanInput, criteria: [{ id: 'c2', text: 'second criterion.', checks: [{ kind: 'visual', name: 'n2', screenshot: 's', widths: [390, 1440], themes: ['light', 'dark'] }] }] }),
    parsePlan({ ...basePlanInput, criteria: [{ id: 'c2', text: 'second criterion.', checks: [{ kind: 'visual', name: 'n2', screenshot: 's', widths: [1440, 390], themes: ['dark', 'light'] }] }] }),
    parsePlan({ ...basePlanInput, criteria: [{ id: 'c2', text: 'second criterion.', checks: [{ kind: 'visual', name: 'n2', screenshot: 's2', widths: [1440, 390], themes: ['light', 'dark'] }] }] }),
    parsePlan({ ...basePlanInput, criteria: [{ id: 'c1', text: 'first criterion.', checks: [{ kind: 'flow', name: 'n1', suite: 'browser-e2e' }] }] }),
    parsePlan({ ...basePlanInput, criteria: [{ id: 'c1', text: 'first criterion.', checks: [{ kind: 'flow', name: 'n1', actions: ['open the app'] }] }] }),
  ]
  for (const mutation of mutations) expect(fingerprintPlan(mutation)).not.toBe(locked)
})

test('the fingerprint does not change when only criterion text or the unplannable reason changes', () => {
  const textOnly = parsePlan({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: 'rewritten wording, the check is untouched.', checks: [{ kind: 'command', name: 'n1', command: 'x' }] },
      { id: 'c2', text: 'second criterion.', checks: [{ kind: 'visual', name: 'n2', screenshot: 's', widths: [1440, 390], themes: ['light', 'dark'] }] },
      { id: 'c3', text: 'third criterion.', unplannable: 'no data reachable' },
    ],
  })
  const reasonOnly = parsePlan({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: 'first criterion.', checks: [{ kind: 'command', name: 'n1', command: 'x' }] },
      { id: 'c2', text: 'second criterion.', checks: [{ kind: 'visual', name: 'n2', screenshot: 's', widths: [1440, 390], themes: ['light', 'dark'] }] },
      { id: 'c3', text: 'third criterion.', unplannable: 'reworded: environment unreachable' },
    ],
  })
  const locked = fingerprintPlan(basePlan)
  expect(fingerprintPlan(textOnly)).toBe(locked)
  expect(fingerprintPlan(reasonOnly)).toBe(locked)
})

test('an added check is a named finding', () => {
  const { locked } = lockPlan(planWithCriterion1Checks([{ kind: 'command', name: 'n1', command: 'x' }]))
  const current = planWithCriterion1Checks([
    { kind: 'command', name: 'n1', command: 'x' },
    { kind: 'command', name: 'extra', command: 'z' },
  ])
  expect(comparePlan(current, locked)).toEqual({ matches: false, findings: ['criterion c1: check added: command "extra" (z)'] })
})

test('a removed check is a named finding', () => {
  const lockedPlan = lockPlan(planWithCriterion1Checks([
    { kind: 'command', name: 'n1', command: 'x' },
    { kind: 'command', name: 'extra', command: 'z' },
  ])).locked
  const current = planWithCriterion1Checks([{ kind: 'command', name: 'n1', command: 'x' }])
  expect(comparePlan(current, lockedPlan)).toEqual({ matches: false, findings: ['criterion c1: check removed: command "extra" (z)'] })
})

test('an added criterion is a named finding', () => {
  const { locked } = lockPlan(basePlan)
  const current = parsePlan({
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: 'first criterion.', checks: [{ kind: 'command', name: 'n1', command: 'x' }] },
      { id: 'c2', text: 'second criterion.', checks: [{ kind: 'visual', name: 'n2', screenshot: 's', widths: [1440, 390], themes: ['light', 'dark'] }] },
      { id: 'c3', text: 'third criterion.', unplannable: 'no data reachable' },
      { id: 'c4', text: 'fourth criterion.', checks: [{ kind: 'command', name: 'n4', command: 'w' }] },
    ],
  })
  expect(comparePlan(current, locked)).toEqual({ matches: false, findings: ['criterion c4: criterion added'] })
})

test('a removed criterion is a named finding', () => {
  const { locked } = lockPlan(basePlan)
  const current = parsePlan({
    schemaVersion: '1',
    criteria: basePlanInput.criteria.slice(0, 2),
  })
  expect(comparePlan(current, locked)).toEqual({ matches: false, findings: ['criterion c3: criterion removed'] })
})

test('findings are deterministic: a modified check is reported before an added check', () => {
  const { locked } = lockPlan(planWithCriterion1Checks([{ kind: 'command', name: 'n1', command: 'x' }]))
  const current = planWithCriterion1Checks([
    { kind: 'command', name: 'n1', command: 'y' },
    { kind: 'command', name: 'extra', command: 'z' },
  ])
  expect(comparePlan(current, locked).findings).toEqual([
    'criterion c1: check 0 changed: command "x" -> "y"',
    'criterion c1: check added: command "extra" (z)',
  ])
})

test('reordering criteria or checks alone is not an edit: the fingerprint holds and the plan still matches', () => {
  const reordered = parsePlan({
    schemaVersion: '1',
    criteria: [
      { id: 'c3', text: 'third criterion.', unplannable: 'no data reachable' },
      { id: 'c2', text: 'second criterion.', checks: [{ kind: 'visual', name: 'n2', screenshot: 's', widths: [1440, 390], themes: ['light', 'dark'] }] },
      { id: 'c1', text: 'first criterion.', checks: [{ kind: 'command', name: 'n1', command: 'x' }] },
    ],
  })
  expect(fingerprintPlan(reordered)).toBe(fingerprintPlan(basePlan))
  const { locked } = lockPlan(basePlan)
  expect(comparePlan(reordered, locked)).toEqual({ matches: true, findings: [] })
})

test('the loader round-trips through the lock: lock(loadPlan) then compare(loadPlan) matches', () => {
  const text = fixture('plan.valid.json')
  const { locked, fingerprint } = lockPlan(loadPlan(text))
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
  expect(comparePlan(loadPlan(text), locked)).toEqual({ matches: true, findings: [] })
  expect(locked.criteria.map(criterion => criterion.id)).toEqual(['ledger-export-csv', 'multi-currency-totals', 'payout-1099-notice'])
})
