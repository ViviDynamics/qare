import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { PLAN_SCHEMA_VERSION, PlanValidationError, parsePlan, loadPlan } from '../src/index.js'

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
  const plan = loadPlan(fixture('plan.valid.json'))
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
  const plan = loadPlan(fixture('plan.valid.json'))

  expect(plan.criteria[1]).toEqual({
    id: 'ledger-export-csv',
    text: 'The ledger exports to CSV.',
    checks: [
      {
        kind: 'flow',
        name: 'ledger-export-actions',
        actions: [
          { action: 'open', url: ['http:', '//localhost:3000/ledger'].join('') },
          { action: 'type', element: { role: 'textbox', name: 'Search' }, value: 'Ada Lovelace' },
          { action: 'click', element: { testId: 'export-csv' } },
          { action: 'assert', text: 'Export complete' },
        ],
        inferred: true,
      },
    ],
  })
  expect(plan.criteria[2]).toEqual({
    id: 'multi-currency-totals',
    text: 'Totals convert to the viewer currency.',
    unplannable: 'no staging environment with multi-currency data is reachable from the sandbox',
  })
})

test('plan.invalid.json fails closed with a named error on the offending field', () => {
  const text = fixture('plan.invalid.json')
  expect(() => loadPlan(text)).toThrow(PlanValidationError)

  const error = planError(() => loadPlan(text))
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
  const error = planError(() => loadPlan('{not json'))
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

test('free-form flow actions are rejected: a plan is typed or it does not load', () => {
  const error = planError(() =>
    parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'flow', name: 'n', actions: ['open the ledger', 'click export'] }] }] }),
  )
  expect(error.field).toBe('criteria[0].checks[0].actions[0]')
  expect(error.message).toContain('must be an object')
})

test('a flow action whose kind is outside the vocabulary fails closed naming it', () => {
  const error = planError(() =>
    parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'flow', name: 'n', actions: [{ action: 'hover', selector: '#menu' }] }] }] }),
  )
  expect(error.field).toBe('criteria[0].checks[0].actions[0].action')
  expect(error.message).toContain('hover')
})

test('an element reference is a role with its name or a test id, never both, never a selector', () => {
  const both = planError(() =>
    parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'flow', name: 'n', actions: [{ action: 'click', element: { role: 'button', name: 'Export', testId: 'export' } }] }] }] }),
  )
  expect(both.field).toBe('criteria[0].checks[0].actions[0].element')
  const selector = planError(() =>
    parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'flow', name: 'n', actions: [{ action: 'click', element: { selector: '#export' } }] }] }] }),
  )
  expect(selector.field).toBe('criteria[0].checks[0].actions[0].element')
  expect(selector.message).toContain('role')
})

test('visual check themes become evidence file names, so they cannot escape the evidence dir', () => {
  const check = { kind: 'visual', name: 'n', screenshot: 'shot', themes: ['../../escape'] }
  const error = planError(() =>
    parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [check] }] }),
  )
  expect(error.field).toBe('criteria[0].checks[0].themes[0]')
  expect(error.message).toContain('themes become evidence file names')
  expect(planError(() =>
    parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ ...check, themes: ['dark\u0000'] }] }] }),
  ).field).toBe('criteria[0].checks[0].themes[0]')
  expect(parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ ...check, themes: ['light', 'dark'] }] }] }).criteria[0].checks[0].themes).toEqual(['light', 'dark'])
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

test('totp and backupCode flow actions parse with their element only: no secret and no code travels in the plan (#64)', () => {
  const plan = parsePlan({
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: 'a seeded profile logs in through the second factor',
        checks: [
          {
            kind: 'flow',
            name: 'two-factor sign in',
            actions: [
              { action: 'totp', element: { role: 'textbox', name: 'Verification code' } },
              { action: 'backupCode', element: { testId: 'recovery-code' } },
            ],
          },
        ],
      },
    ],
  })
  expect(plan.criteria[0]?.checks[0]).toEqual({
    kind: 'flow',
    name: 'two-factor sign in',
    actions: [
      { action: 'totp', element: { role: 'textbox', name: 'Verification code' } },
      { action: 'backupCode', element: { testId: 'recovery-code' } },
    ],
  })
})

test('a mail check that reads a one-time code parses with an optional pattern, and a bad pattern fails closed (#64)', () => {
  const plan = parsePlan({
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: 'a mail-borne code is read',
        checks: [{ kind: 'mail', name: 'signup', address: 'qa@localhost', code: { pattern: '\\d{4}' } }],
      },
    ],
  })
  expect(plan.criteria[0]?.checks[0]).toEqual({ kind: 'mail', name: 'signup', address: 'qa@localhost', code: { pattern: '\\d{4}' } })

  const error = planError(() =>
    parsePlan({
      schemaVersion: '1',
      criteria: [
        {
          id: 'c1',
          text: 'a mail-borne code is read',
          checks: [{ kind: 'mail', name: 'signup', address: 'qa@localhost', code: { pattern: '([a]+' } }],
        },
      ],
    }),
  )
  expect(error.field).toBe('criteria[0].checks[0].code.pattern')
})
