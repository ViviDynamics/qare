import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { PLAN_SCHEMA_VERSION, PlanValidationError, parsePlan, loadPlan } from '../src/index.js'
import { parseFlowActions } from '../src/plan.js'

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
          { action: 'assertText', text: 'Export complete' },
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

test('a visual check names the page it captures, and the page is a string (#143)', () => {
  const check = { kind: 'visual', name: 'article', screenshot: 'ada', url: '/wiki/Ada_Lovelace', widths: [390, 1440] }
  const plan = parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [check] }] })
  expect(plan.criteria[0]).toMatchObject({ checks: [check] })

  // Without one the check captures the app's root, so it stays optional.
  const rootOnly = parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'visual', name: 'home', screenshot: 'home' }] }] })
  expect(rootOnly.criteria[0]).toMatchObject({ checks: [{ kind: 'visual', name: 'home', screenshot: 'home' }] })

  for (const url of ['', 7]) {
    const error = planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ ...check, url }] }] }))
    expect(error.field).toBe('criteria[0].checks[0].url')
  }
  // A width is a viewport in whole pixels: the planner hears about anything else in its correction round.
  for (const width of [0, -390, 390.5]) {
    const error = planError(() => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [{ ...check, widths: [width] }] }] }))
    expect(error.field).toBe('criteria[0].checks[0].widths[0]')
    expect(error.message).toContain('whole number of pixels')
  }
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

test('an a11y check names a page or drives to one with the flow vocabulary, never both (#149)', () => {
  const planOf = (check: unknown) => parsePlan({ schemaVersion: '1', criteria: [{ ...criterion, checks: [check] }] })
  const byUrl = { kind: 'a11y', name: 'settings', url: '/settings', widths: [390], themes: ['dark'], inferred: true }
  expect(planOf(byUrl).criteria[0]).toMatchObject({ checks: [byUrl] })
  const actions = [{ action: 'open', url: '/login' }, { action: 'click', element: { role: 'button', name: 'Sign in' } }]
  expect(planOf({ kind: 'a11y', name: 'after sign in', actions }).criteria[0]).toMatchObject({ checks: [{ kind: 'a11y', name: 'after sign in', actions }] })
  // Neither audits the app's root.
  expect(planOf({ kind: 'a11y', name: 'home' }).criteria[0]).toMatchObject({ checks: [{ kind: 'a11y', name: 'home' }] })

  expect(planError(() => planOf({ kind: 'a11y', name: 'n', url: '/x', actions })).field).toBe('criteria[0].checks[0].url')
  expect(planError(() => planOf({ kind: 'a11y', name: 'n', url: '' })).field).toBe('criteria[0].checks[0].url')
  expect(planError(() => planOf({ kind: 'a11y', name: 'n', actions: ['open it'] })).field).toBe('criteria[0].checks[0].actions[0]')
  expect(planError(() => planOf({ kind: 'a11y', name: 'n', widths: [0] })).field).toBe('criteria[0].checks[0].widths[0]')
  expect(planError(() => planOf({ kind: 'a11y', name: 'n', themes: ['a/b'] })).field).toBe('criteria[0].checks[0].themes[0]')
  expect(planError(() => planOf({ kind: 'sixth-sense', name: 'n' })).message).toContain('"a11y"')
})

test('an a11y check that drives a flow is held to the actions the driver declares (#149, #70)', () => {
  const driver = { name: 'kiosk', actions: ['open'], evidence: [] }
  const error = planError(() =>
    parsePlan(
      { schemaVersion: '1', criteria: [{ ...criterion, checks: [{ kind: 'a11y', name: 'n', actions: [{ action: 'click', element: { testId: 'go' } }] }] }] },
      [],
      driver,
    ),
  )
  expect(error.field).toBe('criteria[0].checks[0].actions[0].action')
  expect(error.message).toContain('kiosk')
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

test('a flow action in the change\'s own vocabulary is carried verbatim when the loader is told about it', () => {
  // The base revision's loader has no shape for a kind the change introduces
  // (#64): it carries the object as planned, and the head revision's loader,
  // which knows its own vocabulary, is the authority for the shape.
  const plan = parsePlan(
    {
      schemaVersion: '1',
      criteria: [
        {
          id: 'c1',
          text: 'the second factor signs in',
          checks: [{ kind: 'flow', name: 'totp-login', actions: [{ action: 'magicLink', element: { testId: 'sign-in' } }] }],
        },
      ],
    },
    ['magicLink'],
  )

  expect(plan.criteria[0]).toMatchObject({
    checks: [{ kind: 'flow', name: 'totp-login', actions: [{ action: 'magicLink', element: { testId: 'sign-in' } }] }],
  })
})

test('a flow action outside the declared vocabulary is refused, naming what was offered', () => {
  const error = planError(() =>
    parsePlan({
      schemaVersion: '1',
      criteria: [
        {
          id: 'c1',
          text: 'the second factor signs in',
          checks: [{ kind: 'flow', name: 'totp-login', actions: [{ action: 'magicLink', element: { testId: 'sign-in' } }] }],
        },
      ],
    }),
  )

  expect(error.field).toBe('criteria[0].checks[0].actions[0].action')
  expect(error.message).toContain('"magicLink"')
})

test('the refusal names the whole vocabulary it was offered, including the change\'s kinds', () => {
  const error = planError(() =>
    parsePlan(
      {
        schemaVersion: '1',
        criteria: [
          {
            id: 'c1',
            text: 'the second factor signs in',
            checks: [{ kind: 'flow', name: 'totp-login', actions: [{ action: 'smoke', element: { testId: 'sign-in' } }] }],
          },
        ],
      },
      ['magicLink'],
    ),
  )

  expect(error.message).toContain('"totp", "backupCode", "magicLink"')
})

test('a plan naming an action the driver lacks is refused, naming the action and the driver (#70)', () => {
  const error = planError(() =>
    parsePlan(
      {
        schemaVersion: '1',
        criteria: [
          {
            id: 'c1',
            text: 'the ledger exports to CSV',
            checks: [
              {
                kind: 'flow',
                name: 'ledger-export',
                actions: [
                  { action: 'open', url: ['http:', '//localhost:3000/ledger'].join('') },
                  { action: 'capture' },
                ],
              },
            ],
          },
        ],
      },
      [],
      { name: 'flat-file', actions: ['open'], evidence: [] },
    ),
  )

  expect(error.field).toBe('criteria[0].checks[0].actions[1].action')
  expect(error.message).toContain('"capture"')
  expect(error.message).toContain('flat-file')
  expect(error.message).toContain('"open"')
})

test('a plan whose actions all sit in the driver\'s declared set loads with that driver (#70)', () => {
  const plan = parsePlan(
    {
      schemaVersion: '1',
      criteria: [
        {
          id: 'c1',
          text: 'the ledger exports to CSV',
          checks: [
            {
              kind: 'flow',
              name: 'ledger-export',
              actions: [
                { action: 'open', url: ['http:', '//localhost:3000/ledger'].join('') },
                { action: 'assertText', text: 'Export complete' },
              ],
            },
          ],
        },
      ],
    },
    [],
    { name: 'browser', actions: ['open', 'assertText'], evidence: [] },
  )

  expect(plan.criteria[0].checks[0]).toMatchObject({ kind: 'flow', name: 'ledger-export' })
})

test('a criterion names a profile the plan does not carry is refused, because the single-profile run would silently ignore the routing (#55)', () => {
  const error = planError(() =>
    parsePlan({
      schemaVersion: '1',
      criteria: [
        {
          id: 'c1',
          text: 'admin boots',
          checks: [{ kind: 'command', name: 'boot', command: 'true' }],
          profile: 'admin',
        },
      ],
    }),
  )

  expect(error.field).toBe('criteria[0].profile')
  expect(error.message).toContain('"admin"')
  expect(error.message).toContain('the plan names no profiles')
})

test('an element reference may pin the snapshot path it was authored against (#83)', () => {
  const actions = parseFlowActions(
    [{ action: 'click', element: { role: 'button', name: 'Save', at: 'document/main/button "Save"' } }],
    'flow-83',
  )
  expect(actions[0]).toEqual({ action: 'click', element: { role: 'button', name: 'Save', at: 'document/main/button "Save"' } })
})

test('a snapshot path is validated against the shape the snapshot itself produces (#83)', () => {
  const bad = (element: unknown) => () => parseFlowActions([{ action: 'click', element }], 'flow-83')
  expect(bad({ role: 'button', name: 'Save', at: 'main/button' })).toThrow(PlanValidationError)
  expect(bad({ role: 'button', name: 'Save', at: 7 })).toThrow(PlanValidationError)
  expect(bad({ role: 'button', name: 'Save', at: 'document/main/button "Save"[0]' })).toThrow(PlanValidationError)
  expect(bad({ testId: 'save', at: 'document/main' })).toThrow(PlanValidationError)
})

test('a snapshot path ends on the element the reference names (#83)', () => {
  expect(() =>
    parseFlowActions([{ action: 'click', element: { role: 'button', name: 'Save', at: 'document/main/button "Delete"' } }], 'flow-83'),
  ).toThrow(PlanValidationError)
  expect(() =>
    parseFlowActions([{ action: 'click', element: { role: 'button', name: 'Save', at: 'document/main/region "Billing"/button "Delete"' } }], 'flow-83'),
  ).toThrow(PlanValidationError)
  // The occurrence is the pinning the path exists for: the role and name are
  // what the reference itself names.
  expect(
    parseFlowActions([{ action: 'click', element: { role: 'button', name: 'Save', at: 'document/main/button "Save"[2]' } }], 'flow-83'),
  ).toEqual([{ action: 'click', element: { role: 'button', name: 'Save', at: 'document/main/button "Save"[2]' } }])
})

test('a plan carries what the planner model spent, when the runner says so (#51)', () => {
  const base = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    criteria: [{ id: 'c1', text: 'Totals convert to the viewer currency.', checks: [{ kind: 'command', name: 'look', command: 'true' }] }],
  }
  const planned = parsePlan({ ...base, usage: { inputTokens: 9, outputTokens: 4 } })
  expect(planned.usage).toEqual({ inputTokens: 9, outputTokens: 4 })
  // A plan written before the field existed still loads, and a malformed
  // spend is refused: the metrics record joins numbers it must be able to add.
  expect(parsePlan(base).usage).toBeUndefined()
  expect(() => parsePlan({ ...base, usage: { inputTokens: 9 } })).toThrow(PlanValidationError)
  // A token count is a count: negative and non-finite numbers are refused,
  // the schema says at least 0 (#51).
  expect(() => parsePlan({ ...base, usage: { inputTokens: -1, outputTokens: 4 } })).toThrow(/at least 0/)
  expect(() => parsePlan({ ...base, usage: { inputTokens: 9, outputTokens: Number.POSITIVE_INFINITY } })).toThrow(/at least 0/)
})
