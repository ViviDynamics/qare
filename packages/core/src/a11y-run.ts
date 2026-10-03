import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decideA11y, pageOf, type A11yBaseline, type A11yConfig, type A11yCounts, type A11yFlowAudit, type A11yFlowAudits } from './a11y.js'
import { redactValue, type RedactionRule } from './redact.js'
import type { VisualComparison } from './visual-run.js'

export const A11Y_RECORD = 'a11y.json'

/** The theme audited when neither the check nor the profile names one: the browser's default colour scheme. */
export const DEFAULT_A11Y_THEME = 'light'

/**
 * What a side's accessibility audits run with (#149): the rule set and what
 * fails under it, the widths and themes a check that names none is audited
 * at, whether every action flow is audited, and what the head's violations
 * are compared with. The comparison is the one visual checks use (#143): one
 * side compares with nothing, the base side only records, and the head side
 * reads what the base side saved.
 */
export interface A11yContext {
  config: A11yConfig
  defaults: { widths: number[]; themes: string[] }
  standing: boolean
  comparison: VisualComparison
}

export interface A11ySettleInput {
  /** What the record calls the check, and whether a plan asked for it or the profile made it standing. */
  check: { name?: string; standing: boolean }
  audited: A11yFlowAudits
  context: A11yContext
  criterionId: string
  /** The check's position in its criterion: where the base side saved the same check's record. */
  index: number
  evidenceDir: string
  /** The check's directory, relative to the evidence directory. */
  checkDir: string
  rules: readonly RedactionRule[]
}

export interface A11ySettleOutcome {
  status: 'passed' | 'failed' | 'unverified'
  reason?: string
  /** The outcome is this run's only: the base had no audit to compare with, so a cache must not serve it. */
  transient?: true
  counts: A11yCounts
  evidence: string[]
}

/** The audits the base side recorded for the same check, rebuilt from its record. */
async function baseAuditsOf(input: A11ySettleInput, comparison: Extract<VisualComparison, { with: 'base' }>): Promise<A11yBaseline> {
  let record: { audits?: unknown; findings?: unknown }
  try {
    record = JSON.parse(await readFile(join(comparison.evidenceDir, 'checks', input.criterionId, String(input.index), A11Y_RECORD), 'utf8')) as typeof record
  } catch {
    return { with: 'base', unavailable: `no base audit to compare with: ${comparison.why(input.criterionId)}` }
  }
  const audits: A11yFlowAudit[] = []
  const byKey = new Map<string, A11yFlowAudit>()
  for (const entry of Array.isArray(record.audits) ? (record.audits as Array<Record<string, unknown>>) : []) {
    if (typeof entry?.point !== 'number' || typeof entry.width !== 'number' || typeof entry.theme !== 'string') continue
    const audit: A11yFlowAudit = {
      point: entry.point,
      width: entry.width,
      theme: entry.theme,
      url: typeof entry.page === 'string' ? entry.page : '',
      engine: { name: '', version: '' },
      incomplete: 0,
      violations: [],
    }
    audits.push(audit)
    byKey.set(`${audit.point}|${audit.width}|${audit.theme}`, audit)
  }
  for (const finding of Array.isArray(record.findings) ? (record.findings as Array<Record<string, unknown>>) : []) {
    const audit = byKey.get(`${String(finding?.point)}|${String(finding?.width)}|${String(finding?.theme)}`)
    if (audit === undefined || typeof finding.rule !== 'string' || typeof finding.target !== 'string') continue
    audit.violations.push({
      rule: finding.rule,
      ...(typeof finding.impact === 'string' ? { impact: finding.impact } : {}),
      help: '',
      nodes: [{ target: finding.target, ...(typeof finding.path === 'string' ? { path: finding.path } : {}) }],
    })
  }
  return { with: 'base', audits }
}

/**
 * Turn the audits a flow made into the check's outcome and its record
 * (#149). The outcome is decided in code by `decideA11y`; an audit that could
 * not be made leaves the check unverified, naming why, and never reads as a
 * clean page. `a11y.json` names the rule set in force, each audit, and each
 * violation with its rule, impact, element and status.
 *
 * The audits are swept by the run's redaction rules before anything is
 * compared, because the base's record was: both sides then name an element
 * the same way, and a redacted name does not read as a new violation.
 */
export async function settleA11y(input: A11ySettleInput): Promise<A11ySettleOutcome> {
  const { context, checkDir } = input
  const audits = redactValue(input.audited.audits, input.rules)
  const comparison = context.comparison
  const baseline: A11yBaseline =
    comparison.with === 'nothing' ? { with: 'nothing' } : comparison.with === 'base-side' ? { with: 'base-side' } : await baseAuditsOf(input, comparison)
  const decision = decideA11y(audits, context.config, baseline)

  let decided: Pick<A11ySettleOutcome, 'status' | 'reason' | 'transient'>
  if (input.audited.error !== undefined) decided = { status: 'unverified', reason: input.audited.error }
  else if (audits.length === 0) decided = { status: 'unverified', reason: 'the flow reached no page to audit, so nothing says the pages it visits are accessible' }
  else decided = { status: decision.status, ...(decision.reason === undefined ? {} : { reason: decision.reason }), ...(decision.transient === true ? { transient: true as const } : {}) }

  const engine = audits[0]?.engine
  const record = {
    ...(input.check.name === undefined ? {} : { check: input.check.name }),
    asked: input.check.standing ? 'standing: the profile audits every flow' : 'planned',
    side: comparison.with === 'base-side' ? 'base' : 'head',
    standard: context.config.standard,
    fail: context.config.fail,
    accept: context.config.accept,
    ...(engine === undefined ? {} : { engine }),
    comparison:
      comparison.with === 'nothing'
        ? { with: 'nothing', reason: `${comparison.reason}; every violation at a failing impact fails the check` }
        : comparison.with === 'base-side'
          ? { with: 'nothing', reason: 'this is the base side of the run: the head side holds its violations against these' }
          : 'audits' in baseline
            ? { with: 'base' }
            : { with: 'nothing', reason: 'unavailable' in baseline ? baseline.unavailable : 'no base audit to compare with' },
    audits: audits.map((audit) => ({
      point: audit.point,
      page: pageOf(audit.url),
      url: audit.url,
      width: audit.width,
      theme: audit.theme,
      violations: audit.violations.reduce((sum, violation) => sum + violation.nodes.length, 0),
      incomplete: audit.incomplete,
      ...(audit.screenshotPath === undefined ? {} : { screenshot: audit.screenshotPath }),
    })),
    findings: decision.findings,
    counts: decision.counts,
    outcome: decided.status,
    ...(decided.reason === undefined ? {} : { reason: decided.reason }),
  }
  const outDir = join(input.evidenceDir, checkDir)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, A11Y_RECORD), `${JSON.stringify(redactValue(record, input.rules), null, 2)}\n`)
  return { ...decided, counts: decision.counts, evidence: [`${checkDir}/${A11Y_RECORD}`] }
}
