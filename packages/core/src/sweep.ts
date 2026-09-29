import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { FileLedgerStore } from './ledger.js'
import type { LedgerChange, LedgerDocument, LedgerEntry } from './ledger.js'
import { metricsSummaryLines, readMetricsStore, summarizeMetrics } from './metrics.js'

/**
 * The standing sweep (#49): on a schedule, classify every criterion in the
 * ledger by how current its verification is, and keep one GitHub issue — the
 * standing status report — current with that picture. Staleness thresholds
 * are per area, set in a strict `sweep.json` beside the ledger.
 */

export const SWEEP_STATUS_MARKER = 'qare-status: standing report'
export const DEFAULT_STALE_AFTER = '90d'

export interface SweepAreaConfig {
  staleAfter: string
}

export interface SweepConfig {
  default: SweepAreaConfig
  areas?: Record<string, SweepAreaConfig>
}

export type SweepBucket = 'proven' | 'stale' | 'unverified' | 'quarantined' | 'refused'

export interface SweepClassification {
  proven: string[]
  stale: string[]
  unverified: string[]
  quarantined: string[]
  refused: string[]
}

export interface SweepReport {
  at: string
  classification: SweepClassification
  metrics?: MetricsSection
}

export interface SweepFinding {
  fingerprint: string
  reason: string
  actor: string
}

const DURATION_UNITS: Record<string, number> = { d: 1, w: 7, y: 365 }

export class SweepConfigValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'SweepConfigValidationError'
    this.field = field
  }
}

export class SweepLedgerError extends Error {
  readonly fingerprint: string

  constructor(fingerprint: string, message: string) {
    super(message)
    this.name = 'SweepLedgerError'
    this.fingerprint = fingerprint
  }
}

function fail(field: string, message: string): never {
  throw new SweepConfigValidationError(field, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseStaleAfter(value: unknown, field: string): number {
  if (typeof value !== 'string') fail(field, 'staleAfter must be a string like "30d"')
  const match = /^(\d+)([dwy])$/.exec(value)
  if (match === null)
    fail(field, `staleAfter ${JSON.stringify(value)} must be a positive count of days, weeks or years: "30d", "2w", "1y"`)
  const digits = match[1]
  const unit = match[2]
  if (digits === undefined || unit === undefined)
    fail(field, `staleAfter ${JSON.stringify(value)} must be a positive count of days, weeks or years: "30d", "2w", "1y"`)
  const scale = DURATION_UNITS[unit]
  if (scale === undefined) fail(field, `unknown duration unit ${JSON.stringify(unit)}`)
  const days = Number(digits) * scale
  if (!Number.isFinite(days) || days <= 0) fail(field, `staleAfter ${JSON.stringify(value)} must be positive`)
  return days
}

function parseAreaConfig(value: unknown, field: string): SweepAreaConfig {
  if (!isRecord(value)) fail(field, 'must be a JSON object')
  for (const key of Object.keys(value)) if (key !== 'staleAfter') fail(`${field}.${key}`, 'unknown field in sweep area config')
  if (!('staleAfter' in value)) fail(field, 'sweep area config requires "staleAfter"')
  parseStaleAfter(value.staleAfter, `${field}.staleAfter`)
  return { staleAfter: value.staleAfter as string }
}

export function parseSweepConfig(input: unknown): SweepConfig {
  if (!isRecord(input)) fail('sweep', 'sweep config must be a JSON object')
  for (const key of Object.keys(input)) if (key !== 'default' && key !== 'areas') fail(key, 'unknown field in sweep config')
  if (!('default' in input)) fail('default', 'sweep config requires a "default" area config')
  const config: SweepConfig = {
    default: parseAreaConfig(input.default, 'default'),
  }
  if ('areas' in input) {
    if (!isRecord(input.areas)) fail('areas', 'areas must be a JSON object')
    const areas: Record<string, SweepAreaConfig> = {}
    for (const [name, value] of Object.entries(input.areas)) areas[name] = parseAreaConfig(value, `areas.${name}`)
    config.areas = areas
  }
  return config
}

/**
 * The sweep config a ledger carries. An absent `sweep.json` is not an error:
 * the whole ledger then uses the built-in default threshold, so a repository
 * gets a standing report without first writing configuration.
 */
export function loadSweepConfigText(text: string): SweepConfig {
  return parseSweepConfig(JSON.parse(text))
}

/**
 * The strict `sweep.json` beside the ledger, when the ledger carries one.
 * An unreadable one is a sweep finding, not a silent fallback: a threshold
 * nobody can read back must not quietly become the default.
 */
export async function readSweepConfig(ledgerDir: string): Promise<SweepConfig | undefined> {
  let text: string
  try {
    text = await readFile(join(ledgerDir, 'sweep.json'), 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw new SweepLedgerError('sweep:config-unreadable', `sweep.json is unreadable: ${messageOf(error)}`)
  }
  try {
    return loadSweepConfigText(text)
  } catch (error) {
    if (error instanceof SweepConfigValidationError) throw new SweepLedgerError('sweep:config-invalid', `sweep.json is invalid: ${error.message}`)
    throw error
  }
}

export function sweepConfigFor(config: SweepConfig | undefined, areas: string[]): SweepAreaConfig {
  if (config === undefined) return { staleAfter: DEFAULT_STALE_AFTER }
  let chosen: SweepAreaConfig | undefined
  for (const area of areas) {
    const match = config.areas?.[area]
    if (match === undefined) continue
    if (chosen === undefined || parseStaleAfter(match.staleAfter, 'areas') < parseStaleAfter(chosen.staleAfter, 'areas'))
      chosen = match
  }
  return chosen ?? config.default
}

/**
 * An entry's areas come from the sources it names: a suite reference names
 * the suite, a repository-relative path names its topmost directory (or
 * itself, when it sits at the root).
 */
export function areasOf(entry: Pick<LedgerEntry, 'source'>): string[] {
  const areas = new Set<string>()
  for (const reference of entry.source) {
    if (reference.startsWith('suite:')) {
      areas.add(reference.slice('suite:'.length))
      continue
    }
    const path = reference.split(':')[0] ?? ''
    if (path === '') continue
    areas.add(path.includes('/') ? path.slice(0, path.indexOf('/')) : path)
  }
  return [...areas]
}

interface SweepRecord {
  criterionId: string
  outcome: string
  reason: string
}

/**
 * The last run's result, as the ledger dir holds it: `held-result.json`
 * carries the criteria the run could not verify, which is where the standing
 * report's quarantined and refused buckets come from. An absent file means
 * the last run verified everything it could: nothing is held or refused.
 */
export async function loadHeldResult(ledgerDir: string): Promise<{ held: string[]; refused: string[] }> {
  let text: string
  try {
    text = await readFile(join(ledgerDir, 'held-result.json'), 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return { held: [], refused: [] }
    throw new SweepLedgerError('sweep:held-result-unreadable', `held-result.json is unreadable: ${messageOf(error)}`)
  }
  const parsed: unknown = JSON.parse(text)
  const criteria = (parsed as { criteria?: unknown }).criteria
  if (!Array.isArray(criteria))
    throw new SweepLedgerError('sweep:held-result-unreadable', 'held-result.json must carry a "criteria" array')
  const records: SweepRecord[] = criteria
    .filter(
      (criterion): criterion is { id: string; outcome: string; reason: string } =>
        typeof criterion === 'object' &&
        criterion !== null &&
        typeof (criterion as Record<string, unknown>).id === 'string' &&
        typeof (criterion as Record<string, unknown>).outcome === 'string' &&
        typeof (criterion as Record<string, unknown>).reason === 'string',
    )
    .map((criterion) => ({ criterionId: criterion.id, outcome: criterion.outcome, reason: criterion.reason }))
  const held = records
    .filter((record) => record.outcome === 'unverified' && record.reason.startsWith('held for an open question'))
    .map((record) => record.criterionId)
  const refused = records.filter((record) => record.outcome === 'refused').map((record) => record.criterionId)
  return { held, refused }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The standing picture of the ledger: every active or proposed criterion in
 * exactly one of the five buckets. Quarantined and refused come from the last
 * run's held result; the rest read the ledger's own history — proposed or
 * never verified is unverified, a criterion whose last verification is older
 * than its area's threshold, or that changed after it was verified, is
 * stale, and everything else is proven. Superseded and retired entries are
 * history keepers, not a current state, so they appear in no bucket.
 */
export function classifySweep(
  entries: LedgerEntry[],
  changes: LedgerChange[],
  config: SweepConfig,
  opts: { now: Date; quarantined?: string[]; refused?: string[] },
): SweepClassification {
  const lastVerify = new Map<string, { seq: number; timestamp: string }>()
  const lastEdit = new Map<string, number>()
  for (const change of changes) {
    for (const criterion of change.criteria) {
      if (change.kind === 'verify') lastVerify.set(criterion, { seq: change.seq, timestamp: change.timestamp })
      else lastEdit.set(criterion, change.seq)
    }
  }
  const held = new Set(opts.quarantined ?? [])
  const refused = new Set(opts.refused ?? [])
  const classification: SweepClassification = { proven: [], stale: [], unverified: [], quarantined: [], refused: [] }
  for (const entry of [...entries].sort(byCriterion)) {
    if (entry.status !== 'active' && entry.status !== 'proposed') continue
    if (held.has(entry.criterion)) {
      classification.quarantined.push(entry.criterion)
      continue
    }
    if (refused.has(entry.criterion)) {
      classification.refused.push(entry.criterion)
      continue
    }
    if (entry.status === 'proposed') {
      classification.unverified.push(entry.criterion)
      continue
    }
    const verified = lastVerify.get(entry.criterion)
    if (verified === undefined) {
      classification.unverified.push(entry.criterion)
      continue
    }
    const editedAt = lastEdit.get(entry.criterion)
    if (editedAt !== undefined && editedAt > verified.seq) {
      classification.stale.push(entry.criterion)
      continue
    }
    const threshold = sweepConfigFor(config, areasOf(entry))
    const verifiedAt = new Date(verified.timestamp)
    if (Number.isNaN(verifiedAt.getTime()) || opts.now.getTime() - verifiedAt.getTime() > parseStaleAfter(threshold.staleAfter, 'staleAfter') * 24 * 60 * 60 * 1000)
      classification.stale.push(entry.criterion)
    else classification.proven.push(entry.criterion)
  }
  return classification
}

function byCriterion(a: LedgerEntry, b: LedgerEntry): number {
  return a.criterion < b.criterion ? -1 : a.criterion > b.criterion ? 1 : 0
}

/**
 * The standing status report: one GitHub issue, updated in place, whose body
 * carries the marker the next sweep finds it by. Written so someone with no
 * QARE installed can read what is proven, what is stale, what never ran and
 * what is held or refused.
 */
export function renderStatusMarkdown(report: SweepReport): string {
  const buckets = report.classification
  const lines: string[] = [
    SWEEP_STATUS_MARKER,
    '',
    '# QARE standing report',
    '',
    `Generated by \`qare sweep\` at ${report.at}. The current acceptance`,
    'criteria and their verification state, published from the criteria ledger;',
    'do not comment with run requests here, the ledger, not this file, is the',
    'store.',
    '',
    `proven: ${buckets.proven.length} stale: ${buckets.stale.length} unverified: ${buckets.unverified.length} quarantined: ${buckets.quarantined.length} refused: ${buckets.refused.length}`,
    '',
  ]
  if (report.metrics !== undefined) {
    lines.push('## Whether QARE is working (#51)', '')
    for (const line of report.metrics.lines) lines.push(`- ${line}`)
    if (report.metrics.malformed > 0) lines.push(`- ${report.metrics.malformed} metrics line(s) in the store were not valid JSON and were skipped`)
    lines.push('')
  }
  lines.push(...section('Proven', buckets.proven, 'verified within its area staleness threshold'))
  lines.push(...section('Stale', buckets.stale, 'nothing has verified it within its area staleness threshold'))
  lines.push(...section('Unverified', buckets.unverified, 'admitted but never proven by a run'))
  lines.push(...section('Quarantined', buckets.quarantined, 'held for an open conflict question'))
  lines.push(...section('Refused', buckets.refused, 'the last run refused it; the reason is on the run'))
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

function section(title: string, criteria: string[], meaning: string): string[] {
  const lines = [`## ${title}`, '', `${criteria.length} criterion(s): ${meaning}`]
  if (criteria.length > 0) lines.push('', ...criteria.map((criterion) => `- ${criterion}`))
  lines.push('')
  return lines
}

export const SWEEP_STATUS_KEY = 'status-report'

export function statusDraft(report: SweepReport): { title: string; key: string; body: string } {
  return { title: 'QARE standing report', key: SWEEP_STATUS_KEY, body: renderStatusMarkdown(report) }
}

export function statusReportMarker(): string {
  return SWEEP_STATUS_MARKER
}

export function sweepFindingMarker(fingerprint: string): string {
  return `qare-finding: ${fingerprint}`
}

export function renderFindingMarkdown(finding: SweepFinding): string {
  const attribution =
    finding.actor === 'unknown' ? '' : ` Filed against @${finding.actor}, whose change last touched the ledger.`
  return [
    sweepFindingMarker(finding.fingerprint),
    '',
    `A sweep of the criteria ledger failed: ${finding.reason}.${attribution}`,
    '',
  ].join('\n')
}

export function findingDraft(finding: SweepFinding): { title: string; key: string; body: string } {
  return { title: `QARE sweep finding: ${finding.fingerprint}`, key: finding.fingerprint, body: renderFindingMarkdown(finding) }
}

export interface SweepPayload {
  at: string
  ledger: string
  classification: SweepClassification
  findings: SweepFinding[]
  lastActor: string | undefined
  /**
   * What the runs amount to over time (#51), read from the metrics store in
   * the ledger directory. Absent when there is no store: a repository that
   * has recorded no runs says so by its absence, not by an empty section.
   */
  metrics?: MetricsSection
}

export interface MetricsSection {
  lines: string[]
  /** Store lines skipped because they were not valid JSON. */
  malformed: number
}

const EMPTY_CLASSIFICATION: SweepClassification = { proven: [], stale: [], unverified: [], quarantined: [], refused: [] }

/**
 * The whole sweep of one ledger: classify what is current and, when the
 * ledger or its configuration cannot be read, say so as a finding instead of
 * failing — a scheduled sweep has no pull request to break, and its problems
 * land where a person reads them, not on a red build no one owns. The
 * `lastActor` is whoever made the ledger's most recent change, the person a
 * finding mentions.
 */
export async function sweepLedger(ledgerDir: string, now: Date = new Date()): Promise<SweepPayload> {
  let document: LedgerDocument
  try {
    document = await new FileLedgerStore(ledgerDir).loadDocument()
  } catch (error) {
    return failed(ledgerDir, now, 'sweep:ledger-unreadable', error)
  }
  const lastActor = document.changes.at(-1)?.actor
  try {
    const config = (await readSweepConfig(ledgerDir)) ?? { default: { staleAfter: DEFAULT_STALE_AFTER } }
    const { held, refused } = await loadHeldResult(ledgerDir)
    const classification = classifySweep(document.entries, document.changes, config, {
      now,
      quarantined: held,
      refused,
    })
    const metrics = await metricsSection(ledgerDir)
    return { at: now.toISOString(), ledger: ledgerDir, classification, findings: [], lastActor, ...(metrics === undefined ? {} : { metrics }) }
  } catch (error) {
    return failed(ledgerDir, now, error instanceof SweepLedgerError ? error.fingerprint : 'sweep:ledger-unreadable', error, lastActor)
  }
}

/**
 * The metrics section of a sweep (#51): what the runs recorded in the ledger
 * directory's metrics store amount to. A store that cannot be read is not a
 * finding — metrics describe runs, they do not gate them — so any error here
 * simply leaves the section out.
 */
async function metricsSection(ledgerDir: string): Promise<MetricsSection | undefined> {
  try {
    const store = await readMetricsStore(join(ledgerDir, 'metrics'))
    if (store.runs.length === 0 && store.notes.length === 0) return undefined
    return { lines: metricsSummaryLines(summarizeMetrics(store)), malformed: store.malformed }
  } catch {
    return undefined
  }
}

function failed(ledgerDir: string, now: Date, fingerprint: string, error: unknown, lastActor?: string): SweepPayload {
  const reason = error instanceof Error ? error.message : String(error)
  return {
    at: now.toISOString(),
    ledger: ledgerDir,
    classification: { ...EMPTY_CLASSIFICATION },
    findings: [{ fingerprint, reason, actor: lastActor ?? 'unknown' }],
    lastActor: undefined,
  }
}
