import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { PLAN_SCHEMA_VERSION, PlanValidationError, parsePlan, parsePlanJson } from '../src/index.js'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')

function planError(run: () => unknown): PlanValidationError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(PlanValidationError)
    return error as PlanValidationError
  }
  throw new Error('expected the loader to throw PlanValidationError')
}

const valid = {
  schemaVersion: '1',
  criteria: [
    {
      id: 'c1',
      text: 'bin/rails test test/payout_tax_test.rb passes.',
      checks: [{ kind: 'command', name: 'payout-tax-spec', command: 'bin/rails test test/payout_tax_test.rb' }],
    },
  ],
}

test('plan.valid.json loads and keeps every check as planned', () => {
  const plan = parsePlanJson(fixture('plan.valid.json'))
  expect(plan.schemaVersion).toBe(PLAN_SCHEMA_VERSION)
  expect(plan.criteria).toHaveLength(3)

  expect(plan.criteria[0]).toEqual({
    id: 'payout-1099-notice',
    text: 'A host paid over the threshold sees the 1099 notice on the payouts page.',
    checks: [
      { kind: 'command', name: 'payout-tax-spec', command: 'bin/rails test test/payout_tax_test.rb' },
      { kind: 'flow', name: 'payouts-notice-flow', suite: 'browser-e2e' },
      { kind: 'visual', name: 'payouts-page-1440-light', screenshot: 'payouts', widths: [1440, 390], themes: ['light', 'dark'] },
    ],
  })
})

test('plan.valid.json carries the inferred-check marker and an unplannable criterion', () => {
  const plan = parsePlanJson(fixture('plan.valid.json'))

  expect(plan.criteria[1]).toEqual({
    id: 'ledger-export-csv',
    text: 'The ledger exports to CSV.',
    checks: [{ kind: 'flow', name: 'ledger-export-actions', actions: ['open the ledger', 'click export'] , inferred: true }],
  })
  expect(plan.criteria[2]).toEqual({
    id: 'multi-currency-totals',
    text: 'Totals convert to the viewer currency.',
    unplannable: 'no staging environment with multi-currency data is reachable from the sandbox',
  })
})

test('plan.invalid.json fails closed with a named error on the offending field', () => {
  const text = fixture('plan.invalid.json')
  expect(() => parsePlanJson(text)).toThrow(PlanValidationError)

  const error = planError(() => parsePlanJson(text))
  expect(error.name).toBe('PlanValidationError')
  expect(error.field).toBe('criteria[0].checks[0].kind')
  expect(error.message).toContain('unknown check kind "screenshot"')
})

test('an empty plan fails closed', () => {
  const error = planError(() => parsePlan({ schemaVersion: '1', criteria: [] }))
  expect(error.field).toBe('criteria')
  expect(error.message).toContain('empty')
})

test('an unknown schemaVersion fails closed', () => {
  const error = planError(() => parsePlan({ schemaVersion: '9', criteria: [{ id: 'c1', text: 't', checks: [{ kind: 'command', name: 'n', command: 'x' }] }] }))
  expect(error.field).toBe('schemaVersion')
  expect(error.message).toContain('unknown schemaVersion "9"')
})

test('a missing schemaVersion fails closed', () => {
  const error = planError(() => parsePlan({ criteria: [] }))
  expect(error.field).toBe('schemaVersion')
})

test('text that is not JSON at all fails closed with a named error', () => {
  const error = planError(() => parsePlanJson('{not json'))
  expect(error.field).toBe('json')
  expect(error.message).toContain('not valid JSON')
})

const criterion = { id: 'c1', text: 'works.' }
const commandCheck = { kind: 'command', name: 'n', command: 'x' }

test('schema violations name the field', () => {
  expect(planError(() => parsePlan({ schemaVersion: '1' })).field).toBe('criteria')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{}] })).field).toBe('criteria[0].id')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ id: 'c1', checks: [commandCheck] }] })).field).toBe('criteria[0].text')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ id: 'c1', text: 't' }] })).field).toBe('criteria[0]')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [], unplannable: 'why' }] })).field).toBe('criteria[0]')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [] }] })).field).toBe('criteria[0].checks')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{}] }] })).field).toBe('criteria[0].checks[0].kind')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'command', name: 'n' }] }] })).field).toBe('criteria[0].checks[0].command')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'flow', name: 'n' }] }] })).field).toBe('criteria[0].checks[0].suite')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'flow', name: 'n', suite: 's', actions: ['a'] }] }] })).field).toBe('criteria[0].checks[0].suite')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'visual', name: 'n' }] }] })).field).toBe('criteria[0].checks[0].screenshot')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ ...commandCheck, inferred: 'yes' }] }] })).field).toBe('criteria[0].checks[0].inferred')
  expect(planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, unplannable: '' }] })).field).toBe('criteria[0].unplannable')
})

test('a valid inline plan round-trips with inferred omitted when absent', () => {
  const plan = parsePlan(valid)
  expect(plan.criteria[0]).toEqual({
    id: 'c1',
    text: 'bin/rails test test/payout_tax_test.rb passes.',
    checks: [{ kind: 'command', name: 'payout-tax-spec', command: 'bin/rails test test/payout_tax_test.rb' }],
  })
  expect('inferred' in plan.criteria[0]).toBe(false)
  expect('unplannable' in plan.criteria[0]).toBe(false)
})
