/**
 * Accessibility checks (#149): the rule sets a profile may name, what an
 * audit reports, and the rules that turn audits into an outcome. Everything
 * here is decided in code from what the rule engine found (rule 3): a
 * violation is new, existing, accepted or merely reported by comparison and
 * configuration, never by a model.
 */

/** The impacts the rule engine grades a violation with, mildest first. */
export const A11Y_IMPACTS = ['minor', 'moderate', 'serious', 'critical'] as const

export type A11yImpact = (typeof A11Y_IMPACTS)[number]

/**
 * The rule sets a profile may name, each with the engine tags it selects. A
 * WCAG level includes the levels below it and the versions before it, which
 * is how the standard itself is written.
 */
export const A11Y_STANDARDS: Record<string, readonly string[]> = {
  wcag2a: ['wcag2a'],
  wcag2aa: ['wcag2a', 'wcag2aa'],
  wcag21a: ['wcag2a', 'wcag21a'],
  wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
}

export const DEFAULT_A11Y_STANDARD = 'wcag22aa'

export const DEFAULT_A11Y_FAIL: readonly A11yImpact[] = ['serious', 'critical']

/** A violation the profile accepts (#149): known debt, carried with its reason. */
export interface A11yAccepted {
  rule: string
  /** The URL path of the page it is accepted on; every page when absent. */
  page?: string
  /** The element it is accepted on, by snapshot path or selector; every element when absent. */
  element?: string
  reason: string
}

/** The profile's `a11y` section. Every field is optional: an empty section is the defaults. */
export interface ProfileA11y {
  standard?: string
  fail?: A11yImpact[]
  accept?: A11yAccepted[]
  /** Audit every action flow of the run, without a planned check. */
  standing?: boolean
}

/** The configuration an audit runs under, with the defaults filled in. */
export interface A11yConfig {
  standard: string
  tags: readonly string[]
  fail: readonly A11yImpact[]
  accept: readonly A11yAccepted[]
}

export function a11yConfigOf(profile: ProfileA11y | undefined): A11yConfig {
  const standard = profile?.standard ?? DEFAULT_A11Y_STANDARD
  return {
    standard,
    tags: A11Y_STANDARDS[standard] ?? A11Y_STANDARDS[DEFAULT_A11Y_STANDARD] ?? [],
    fail: profile?.fail ?? DEFAULT_A11Y_FAIL,
    accept: profile?.accept ?? [],
  }
}

/** What the driver is asked for: one audit of the page as it stands. */
export interface A11yAuditRequest {
  /** The engine tags of the rule set in force. */
  tags: readonly string[]
  /** The viewport width to audit at; the viewport the flow ran in when absent. */
  width?: number
  /** The colour scheme to audit in. */
  theme: string
  /** Where to save the page's screenshot when the audit finds a violation; none is taken when absent. */
  screenshot?: string
}

/** One element a rule is violated on, as the driver found it. */
export interface A11yAuditNode {
  /** The engine's selector for the element. */
  target: string
  /** The element's role in the normalised snapshot (#82), when the snapshot holds it. */
  role?: string
  /** Its accessible name there; absent when it has none. */
  name?: string
  /** Its path in the normalised snapshot. */
  path?: string
}

export interface A11yAuditViolation {
  rule: string
  impact?: string
  help: string
  helpUrl?: string
  nodes: A11yAuditNode[]
}

/** One audit of one page state at one width and theme. */
export interface A11yPageAudit {
  url: string
  width: number
  theme: string
  engine: { name: string; version: string }
  violations: A11yAuditViolation[]
  /** How many results the engine could not decide and left for a person. */
  incomplete: number
  /** Whether the screenshot the request named was taken. */
  screenshot?: boolean
}

/** An audit the flow made, with where in the flow it was made. */
export interface A11yFlowAudit extends A11yPageAudit {
  /** The action the page had settled after; the same number at both sides of a run. */
  point: number
  /** The screenshot of the page, relative to the check's directory, when one was taken. */
  screenshotPath?: string
}

/** What a flow's audits came to: the audits made, and the first reason one could not be. */
export interface A11yFlowAudits {
  audits: A11yFlowAudit[]
  error?: string
}

export type A11yStatus = 'new' | 'existing' | 'accepted' | 'reported' | 'uncompared'

/** One violation on one element, as the record lists it. */
export interface A11yFinding {
  rule: string
  impact?: string
  help: string
  helpUrl?: string
  status: A11yStatus
  /** Why it is accepted; carried exactly when the status is `accepted`. */
  reason?: string
  page: string
  point: number
  width: number
  theme: string
  target: string
  role?: string
  name?: string
  path?: string
  screenshot?: string
}

/** What the head's violations are held against. */
export type A11yBaseline =
  /** One side: nothing excuses a violation, so each one counts as new. */
  | { with: 'nothing' }
  /** This is the base side: it records and decides nothing. */
  | { with: 'base-side' }
  /** The base side's audits, or why there are none. */
  | { with: 'base'; audits: readonly A11yFlowAudit[] }
  | { with: 'base'; unavailable: string }

export interface A11yCounts {
  new: number
  existing: number
  accepted: number
  reported: number
  uncompared: number
}

export interface A11yDecision {
  status: 'passed' | 'failed' | 'unverified'
  reason?: string
  /** The outcome says nothing lasting: the base had no audit this time, so a cache must not serve it. */
  transient?: true
  findings: A11yFinding[]
  counts: A11yCounts
}

/** The path of a URL, which is what an accepted violation and a record name a page by. */
export function pageOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** A snapshot path with its occurrence indexes dropped: the element's place, whichever sibling it is. */
function loosePath(path: string): string {
  return path.replace(/\[\d+\](?=\/|$)/g, '')
}

const describeElement = (finding: Pick<A11yFinding, 'path' | 'target'>): string => finding.path ?? finding.target

function accepted(finding: Pick<A11yFinding, 'rule' | 'page' | 'path' | 'target'>, accept: readonly A11yAccepted[]): A11yAccepted | undefined {
  return accept.find(
    (entry) =>
      entry.rule === finding.rule &&
      (entry.page === undefined || entry.page === finding.page) &&
      (entry.element === undefined || entry.element === finding.path || entry.element === finding.target),
  )
}

type Flat = Omit<A11yFinding, 'status' | 'reason'>

function flatten(audits: readonly A11yFlowAudit[]): Flat[] {
  const flat: Flat[] = []
  for (const audit of audits)
    for (const violation of audit.violations)
      for (const node of violation.nodes)
        flat.push({
          rule: violation.rule,
          ...(violation.impact === undefined ? {} : { impact: violation.impact }),
          help: violation.help,
          ...(violation.helpUrl === undefined ? {} : { helpUrl: violation.helpUrl }),
          page: pageOf(audit.url),
          point: audit.point,
          width: audit.width,
          theme: audit.theme,
          target: node.target,
          ...(node.role === undefined ? {} : { role: node.role }),
          ...(node.name === undefined ? {} : { name: node.name }),
          ...(node.path === undefined ? {} : { path: node.path }),
          ...(audit.screenshotPath === undefined ? {} : { screenshot: audit.screenshotPath }),
        })
  return flat
}

const auditKey = (entry: { point: number; width: number; theme: string }): string => `${entry.point}|${entry.width}|${entry.theme}`

/**
 * Decide what a check's audits come to (#149), in code.
 *
 * Every violation on every element becomes one finding. One the profile
 * accepts is `accepted`; one below the failing impacts is `reported`. Each of
 * the rest is held against the baseline: with one side it is `new`; with two
 * it is `existing` when the base audit of the same point, width and theme
 * had it, `new` when that audit did not, and `uncompared` when the base has
 * no such audit. A new violation fails the check, an uncompared one leaves
 * it unverified, and anything else passes it. The base side records and
 * always passes.
 */
export function decideA11y(audits: readonly A11yFlowAudit[], config: A11yConfig, baseline: A11yBaseline): A11yDecision {
  const findings: A11yFinding[] = []
  // What the base had, per audit: each entry excuses one head violation.
  const baseAudits = baseline.with === 'base' && 'audits' in baseline ? baseline.audits : []
  const audited = new Set(baseAudits.map(auditKey))
  const exact = new Map<string, number>()
  const loose = new Map<string, number>()
  const exactKey = (flat: Flat): string => `${auditKey(flat)}|${flat.rule}|${flat.path ?? ''}|${flat.target}`
  const looseKey = (flat: Flat): string | undefined => (flat.path === undefined ? undefined : `${auditKey(flat)}|${flat.rule}|${loosePath(flat.path)}`)
  const add = (map: Map<string, number>, key: string | undefined, by: number): void => {
    if (key !== undefined) map.set(key, (map.get(key) ?? 0) + by)
  }
  for (const flat of flatten(baseAudits)) {
    add(exact, exactKey(flat), 1)
    add(loose, looseKey(flat), 1)
  }

  const pending: Array<{ flat: Flat; index: number }> = []
  for (const flat of flatten(audits)) {
    const entry = accepted(flat, config.accept)
    if (entry !== undefined) findings.push({ ...flat, status: 'accepted', reason: entry.reason })
    else if (flat.impact === undefined || !(config.fail as readonly string[]).includes(flat.impact)) findings.push({ ...flat, status: 'reported' })
    else {
      pending.push({ flat, index: findings.length })
      findings.push({ ...flat, status: baseline.with === 'base' ? 'uncompared' : 'new' })
    }
  }
  if (baseline.with === 'base' && 'audits' in baseline) {
    const set = (index: number, status: A11yStatus): void => {
      const finding = findings[index]
      if (finding !== undefined) finding.status = status
    }
    // Exact identities first, so the element that was there keeps its match
    // and the one beside it is the new one.
    const unmatched: typeof pending = []
    for (const entry of pending) {
      if (!audited.has(auditKey(entry.flat))) continue
      const key = exactKey(entry.flat)
      if ((exact.get(key) ?? 0) > 0) {
        add(exact, key, -1)
        add(loose, looseKey(entry.flat), -1)
        set(entry.index, 'existing')
      } else unmatched.push(entry)
    }
    for (const entry of unmatched) {
      const key = looseKey(entry.flat)
      if (key !== undefined && (loose.get(key) ?? 0) > 0) {
        add(loose, key, -1)
        set(entry.index, 'existing')
      } else set(entry.index, 'new')
    }
  }

  const counts: A11yCounts = { new: 0, existing: 0, accepted: 0, reported: 0, uncompared: 0 }
  for (const finding of findings) counts[finding.status] += 1
  if (baseline.with === 'base-side') {
    // The base only records: what it found is what the head is excused.
    for (const finding of findings) if (finding.status === 'new') finding.status = 'existing'
    return { status: 'passed', findings, counts: { ...counts, new: 0, existing: counts.existing + counts.new } }
  }

  // The same violation seen at two points or two widths is named once.
  const named = (status: A11yStatus): string[] => [
    ...new Set(findings.filter((finding) => finding.status === status).map((finding) => `${finding.rule} on ${describeElement(finding)} (${finding.page})`)),
  ]
  if (counts.new > 0) {
    const names = named('new')
    const kind = baseline.with === 'nothing' ? 'accessibility violation' : 'new accessibility violation'
    return { status: 'failed', reason: `${names.length} ${kind}${names.length === 1 ? '' : 's'}: ${names.join('; ')}`, findings, counts }
  }
  if (counts.uncompared > 0) {
    const names = named('uncompared')
    const why =
      baseline.with === 'base' && 'unavailable' in baseline
        ? baseline.unavailable
        : 'the base side made no audit at the same point of the flow, width and theme'
    return {
      status: 'unverified',
      reason: `${names.length} accessibility violation${names.length === 1 ? '' : 's'} could not be told new from existing (${names.join('; ')}): ${why}`,
      transient: true,
      findings,
      counts,
    }
  }
  return { status: 'passed', findings, counts }
}
