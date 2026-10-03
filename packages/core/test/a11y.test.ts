import { expect, test } from 'vitest'
import { a11yConfigOf, decideA11y, pageOf, type A11yAuditViolation, type A11yFlowAudit } from '../src/index.js'

const PAGE = ['http:', '//127.0.0.1:3000/settings?tab=profile'].join('')

const violation = (rule: string, impact: string | undefined, ...nodes: Array<{ target: string; path?: string }>): A11yAuditViolation => ({
  rule,
  ...(impact === undefined ? {} : { impact }),
  help: `help for ${rule}`,
  nodes,
})

const audit = (violations: A11yAuditViolation[], at: Partial<A11yFlowAudit> = {}): A11yFlowAudit => ({
  url: PAGE,
  width: 1280,
  theme: 'light',
  engine: { name: 'axe-core', version: '4.13.0' },
  incomplete: 0,
  point: 0,
  violations,
  ...at,
})

const UNNAMED = violation('button-name', 'critical', { target: 'button:nth-child(2)', path: 'document/main/button' })
const config = a11yConfigOf(undefined)

test('the defaults are WCAG 2.2 AA, failing on serious and critical (#149)', () => {
  expect(config.standard).toBe('wcag22aa')
  expect(config.tags).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
  expect(config.fail).toEqual(['serious', 'critical'])
  expect(a11yConfigOf({ standard: 'wcag2a', fail: ['minor'] })).toMatchObject({ tags: ['wcag2a'], fail: ['minor'] })
  expect(pageOf(PAGE)).toBe('/settings')
})

test('with one side every violation at a failing impact fails, naming rule and element (#149)', () => {
  const decision = decideA11y([audit([UNNAMED])], config, { with: 'nothing' })
  expect(decision.status).toBe('failed')
  expect(decision.reason).toBe('1 accessibility violation: button-name on document/main/button (/settings)')
  expect(decision.findings).toEqual([
    expect.objectContaining({ rule: 'button-name', impact: 'critical', status: 'new', page: '/settings', path: 'document/main/button', target: 'button:nth-child(2)', width: 1280, theme: 'light', point: 0 }),
  ])
  expect(decision.counts).toEqual({ new: 1, existing: 0, accepted: 0, reported: 0, uncompared: 0 })
})

test('a clean page passes, and a violation below the failing impacts is reported without failing (#149)', () => {
  expect(decideA11y([audit([])], config, { with: 'nothing' })).toMatchObject({ status: 'passed', findings: [] })
  const decision = decideA11y([audit([violation('region', 'moderate', { target: 'div' }), violation('odd', undefined, { target: 'p' })])], config, { with: 'nothing' })
  expect(decision.status).toBe('passed')
  expect(decision.findings.map((finding) => finding.status)).toEqual(['reported', 'reported'])
  expect(decision.counts.reported).toBe(2)
})

test('an accepted violation is listed with its reason and never fails (#149)', () => {
  const accepting = a11yConfigOf({ accept: [{ rule: 'button-name', page: '/settings', element: 'document/main/button', reason: 'tracked in the redesign' }] })
  const decision = decideA11y([audit([UNNAMED])], accepting, { with: 'nothing' })
  expect(decision.status).toBe('passed')
  expect(decision.findings[0]).toMatchObject({ status: 'accepted', reason: 'tracked in the redesign' })
  // The entry names a page and an element: another page, or another element, is not accepted.
  const elsewhere = a11yConfigOf({ accept: [{ rule: 'button-name', page: '/billing', reason: 'x' }] })
  expect(decideA11y([audit([UNNAMED])], elsewhere, { with: 'nothing' }).status).toBe('failed')
  const bySelector = a11yConfigOf({ accept: [{ rule: 'button-name', element: 'button:nth-child(2)', reason: 'x' }] })
  expect(decideA11y([audit([UNNAMED])], bySelector, { with: 'nothing' }).status).toBe('passed')
})

test('a violation the base had is existing and does not fail; one it did not have is new (#149)', () => {
  const contrast = violation('color-contrast', 'serious', { target: 'p.muted', path: 'document/main/paragraph' })
  const existing = decideA11y([audit([contrast])], config, { with: 'base', audits: [audit([contrast])] })
  expect(existing.status).toBe('passed')
  expect(existing.findings[0]?.status).toBe('existing')
  expect(existing.counts).toMatchObject({ existing: 1, new: 0 })

  const added = decideA11y([audit([contrast, UNNAMED])], config, { with: 'base', audits: [audit([contrast])] })
  expect(added.status).toBe('failed')
  expect(added.reason).toBe('1 new accessibility violation: button-name on document/main/button (/settings)')
  expect(added.findings.map((finding) => finding.status)).toEqual(['existing', 'new'])
})

test('an unnamed button added beside an old one is one new violation, not two (#149)', () => {
  // The old button was `button`; with a sibling it is `button[2]`, and its selector moved too.
  const before = violation('button-name', 'critical', { target: 'button', path: 'document/main/button' })
  const after = violation(
    'button-name',
    'critical',
    { target: 'button:nth-child(1)', path: 'document/main/button[1]' },
    { target: 'button:nth-child(2)', path: 'document/main/button[2]' },
  )
  const decision = decideA11y([audit([after])], config, { with: 'base', audits: [audit([before])] })
  expect(decision.status).toBe('failed')
  expect(decision.counts).toMatchObject({ existing: 1, new: 1 })
})

test('the base excuses only the same point of the flow, width and theme (#149)', () => {
  const head = [audit([UNNAMED], { point: 2 })]
  // The base audited another point only: its flow stopped before this one.
  const decision = decideA11y(head, config, { with: 'base', audits: [audit([UNNAMED], { point: 0 })] })
  expect(decision.status).toBe('unverified')
  expect(decision.transient).toBe(true)
  expect(decision.reason).toContain('could not be told new from existing')
  expect(decision.reason).toContain('the base side made no audit at the same point of the flow, width and theme')
  expect(decision.findings[0]?.status).toBe('uncompared')
  // A base audit at that point that did not have it makes it new.
  expect(decideA11y(head, config, { with: 'base', audits: [audit([], { point: 2 })] }).status).toBe('failed')
  expect(decideA11y(head, config, { with: 'base', audits: [audit([UNNAMED], { point: 2, width: 390 })] }).status).toBe('unverified')
})

test('a base with no audit leaves failing violations unverified, and a clean head proven (#149)', () => {
  const unavailable = { with: 'base', unavailable: 'no base audit to compare with: the base side did not run: boot timed out' } as const
  const decision = decideA11y([audit([UNNAMED])], config, unavailable)
  expect(decision.status).toBe('unverified')
  expect(decision.transient).toBe(true)
  expect(decision.reason).toContain('the base side did not run: boot timed out')
  // Nothing can be new on a page with nothing wrong: the base is not needed.
  expect(decideA11y([audit([])], config, unavailable)).toMatchObject({ status: 'passed' })
  expect(decideA11y([audit([violation('region', 'moderate', { target: 'div' })])], config, unavailable).status).toBe('passed')
})

test('the base side records what it found and decides nothing (#149)', () => {
  const decision = decideA11y([audit([UNNAMED])], config, { with: 'base-side' })
  expect(decision.status).toBe('passed')
  expect(decision.findings[0]?.status).toBe('existing')
  expect(decision.counts).toEqual({ new: 0, existing: 1, accepted: 0, reported: 0, uncompared: 0 })
})

test('the same violation at two widths is named once in the reason and listed at each (#149)', () => {
  const decision = decideA11y([audit([UNNAMED]), audit([UNNAMED], { width: 390 })], config, { with: 'nothing' })
  expect(decision.reason).toBe('1 accessibility violation: button-name on document/main/button (/settings)')
  expect(decision.findings).toHaveLength(2)
})
