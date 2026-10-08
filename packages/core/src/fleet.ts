import { createHash } from 'node:crypto'
import { isRunMetricsRecord } from './metrics.js'
import type { SweepClassification } from './sweep.js'

/**
 * The fleet report (#151): every repository qare runs in, on one page. It is
 * built from what each repository already publishes (its ledger, the run
 * records on its `qa-assets` branch, the issues qare filed), read through
 * GitHub's API by whoever holds an identity that can read them. There is no
 * server and no state of its own: a run reads, renders and publishes.
 *
 * This module is the pure half: the config, what a repository's state is,
 * what needs attention, and the page. Nothing here reaches a network.
 *
 * A part of a repository that could not be read is said to be unread, with
 * the reason, and counts as needing attention. It is never shown as healthy:
 * a report that goes quiet when it cannot see is worse than none.
 */

export class FleetConfigError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'FleetConfigError'
    this.field = field
  }
}

export interface FleetRepositoryConfig {
  /** `owner/name`. */
  repository: string
  /** The branch its ledger is read from. */
  branch: string
  /** The directory that holds `ledger.json`. */
  ledger: string
}

export interface FleetConfig {
  repositories: FleetRepositoryConfig[]
  /** How many of each repository's latest runs the page shows. */
  runs: number
}

export const DEFAULT_FLEET_BRANCH = 'main'
export const DEFAULT_FLEET_LEDGER = '.qa'
export const DEFAULT_FLEET_RUNS = 5
const MAX_FLEET_RUNS = 50

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
// A branch or a directory as a URL path may carry it: no "..", nothing a path could climb or break out with.
const SAFE_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/

function fail(field: string, message: string): never {
  throw new FleetConfigError(field, message)
}

/**
 * The strict fleet config: the repositories, listed explicitly.
 *
 * ```json
 * { "repositories": ["acme/web", { "repository": "acme/api", "branch": "trunk", "ledger": "qa" }], "runs": 5 }
 * ```
 *
 * Unknown keys are refused: a misspelt key would otherwise leave a
 * repository out of the report without a word.
 */
export function parseFleetConfig(input: unknown): FleetConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('fleet', 'the fleet config must be a JSON object with repositories')
  const record = input as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => key !== 'repositories' && key !== 'runs')
  if (unknown.length > 0) fail(unknown[0] ?? 'fleet', `the fleet config takes repositories and runs, not ${unknown.join(', ')}`)
  if (!Array.isArray(record.repositories) || record.repositories.length === 0)
    fail('repositories', 'repositories must be a non-empty list: the fleet is the repositories named here')
  const seen = new Set<string>()
  const repositories = record.repositories.map((entry, index): FleetRepositoryConfig => {
    const at = `repositories[${index}]`
    const named = typeof entry === 'string' ? { repository: entry } : entry
    if (typeof named !== 'object' || named === null || Array.isArray(named)) fail(at, 'a repository is "owner/name", or an object with repository, branch and ledger')
    const fields = named as Record<string, unknown>
    const extra = Object.keys(fields).filter((key) => key !== 'repository' && key !== 'branch' && key !== 'ledger')
    if (extra.length > 0) fail(`${at}.${extra[0] ?? ''}`, `a repository takes repository, branch and ledger, not ${extra.join(', ')}`)
    const repository = fields.repository
    if (typeof repository !== 'string' || !REPOSITORY.test(repository)) fail(`${at}.repository`, 'repository must be "owner/name"')
    const key = (repository as string).toLowerCase()
    if (seen.has(key)) fail(`${at}.repository`, `${repository as string} is listed twice`)
    seen.add(key)
    const path = (name: 'branch' | 'ledger', fallback: string): string => {
      const value = fields[name]
      if (value === undefined) return fallback
      if (typeof value !== 'string' || !SAFE_PATH.test(value) || value.split('/').includes('..')) fail(`${at}.${name}`, `${name} must be a plain path of letters, digits, dots, dashes and slashes`)
      return value as string
    }
    return { repository: repository as string, branch: path('branch', DEFAULT_FLEET_BRANCH), ledger: path('ledger', DEFAULT_FLEET_LEDGER) }
  })
  let runs = DEFAULT_FLEET_RUNS
  if (record.runs !== undefined) {
    if (typeof record.runs !== 'number' || !Number.isInteger(record.runs) || record.runs < 1 || record.runs > MAX_FLEET_RUNS)
      fail('runs', `runs must be a whole number from 1 to ${MAX_FLEET_RUNS}`)
    runs = record.runs
  }
  return { repositories, runs }
}

/** One run of a repository, as its metrics record on `qa-assets` describes it (#51). */
export interface FleetRun {
  runId: string
  recordedAt: string
  verdict: string
  /** The pull request it checked, when the record says. */
  pr?: number
  /** How its criteria came out: outcome to count. */
  counts: Record<string, number>
}

export interface FleetIssue {
  number: number
  title: string
}

/** What a part of a repository's state is when it could not be read: the reason, in words. */
export interface Unread {
  unread: string
}

export function isUnread(value: unknown): value is Unread {
  return typeof value === 'object' && value !== null && typeof (value as Unread).unread === 'string'
}

/**
 * What the ledger's own record says. The fleet report reads the ledger and
 * nothing of a repository's last held result, so it cannot know which
 * criteria are quarantined or refused right now: it reports neither, and a
 * criterion the ledger records as verified is counted as such even when its
 * last run refused it. The repository's own standing report (#49) is where
 * those are shown.
 */
export interface FleetLedger {
  /** Active and proposed criteria: the ledger's current size. */
  size: number
  /** Verified by a run, and neither changed since nor older than the stale threshold. */
  proven: number
  stale: string[]
  unverified: number
}

export interface FleetIssues {
  regression: FleetIssue[]
  environment: FleetIssue[]
  failure: FleetIssue[]
}

/** Everything the report says about one repository. Each part is what was read, or why it was not. */
export interface FleetRepositoryState {
  repository: string
  /** The ledger's standing picture; `absent` when the repository has no ledger at the path. */
  ledger: FleetLedger | 'absent' | Unread
  /** The latest runs, newest first; empty when the repository has recorded none. */
  runs: FleetRun[] | Unread
  /** The open issues qare filed, by kind (#154). */
  issues: FleetIssues | Unread
}

export function fleetLedger(classification: SweepClassification): FleetLedger {
  const size = classification.proven.length + classification.stale.length + classification.unverified.length
  return { size, proven: classification.proven.length, stale: [...classification.stale], unverified: classification.unverified.length }
}

/**
 * The share of the ledger its own record shows verified and current, as a
 * whole percentage; undefined for an empty ledger. It is the ledger's record,
 * not a claim about the last run: see `FleetLedger`.
 */
export function coverageOf(ledger: FleetLedger): number | undefined {
  return ledger.size === 0 ? undefined : Math.round((ledger.proven / ledger.size) * 100)
}

/**
 * Read one metrics record as a fleet run. Undefined for anything that is not
 * a record: the caller counts it as one it could not read, never as a pass.
 */
export function fleetRunOf(input: unknown): FleetRun | undefined {
  // Held to the shape the metrics store holds a record to (#51), schema
  // version included: a file that merely carries a verdict is not a run.
  if (!isRunMetricsRecord(input)) return undefined
  const record = input as unknown as Record<string, unknown>
  const recorded = Date.parse(input.recordedAt)
  if (!Number.isFinite(recorded)) return undefined
  const criteria = record.criteria as { counts?: unknown } | undefined
  const counts: Record<string, number> = {}
  if (typeof criteria?.counts === 'object' && criteria.counts !== null)
    for (const [outcome, count] of Object.entries(criteria.counts as Record<string, unknown>)) if (typeof count === 'number' && Number.isInteger(count) && count >= 0) counts[outcome] = count
  const pr = (record.context as { pr?: unknown } | undefined)?.pr
  // The moment is written back as the harness writes one, so nothing of the record's own text rides in on it.
  return { runId: input.runId, recordedAt: new Date(recorded).toISOString(), verdict: input.verdict, ...(typeof pr === 'number' && Number.isInteger(pr) && pr > 0 ? { pr } : {}), counts }
}

/** One thing in the fleet a person should look at. */
export interface FleetAttention {
  repository: string
  /** What kind of thing it is; stable, so the summary changes only when the set does. */
  kind: 'unread' | 'regression' | 'environment' | 'failure' | 'stale' | 'run'
  /** What it is about: an issue number, a criterion id, a run id, or the part that could not be read. */
  subject: string
  /**
   * The line the summary shows. Everything in it that came from a repository
   * (a title, a reason, a number) is already a code span, so the line renders
   * no link, mentions nobody, and makes no reference GitHub would record on
   * the other repository's issue.
   */
  text: string
}

const HEALTHY_VERDICTS = new Set(['passed'])

/**
 * What needs attention across the fleet, in a stable order: every part that
 * could not be read, every open regression, environment and failure issue,
 * every stale criterion, and a latest run that did not pass. The summary
 * issue changes only when this set does.
 */
export function fleetAttention(states: FleetRepositoryState[]): FleetAttention[] {
  const items: FleetAttention[] = []
  for (const state of [...states].sort((a, b) => (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0))) {
    const repository = state.repository
    for (const [part, value] of [['ledger', state.ledger], ['runs', state.runs], ['issues', state.issues]] as const)
      if (isUnread(value)) items.push({ repository, kind: 'unread', subject: part, text: `its ${part} could not be read: ${code(value.unread)}` })
    if (!isUnread(state.issues)) {
      for (const kind of ['regression', 'environment', 'failure'] as const)
        for (const issue of state.issues[kind]) items.push({ repository, kind, subject: `#${issue.number}`, text: `open qa-${kind} issue ${code(`#${issue.number}`)}: ${code(issue.title)}` })
    }
    if (state.ledger !== 'absent' && !isUnread(state.ledger)) for (const criterion of state.ledger.stale) items.push({ repository, kind: 'stale', subject: criterion, text: `criterion ${code(criterion)} is stale` })
    if (!isUnread(state.runs)) {
      const latest = state.runs[0]
      if (latest !== undefined && !HEALTHY_VERDICTS.has(latest.verdict))
        items.push({ repository, kind: 'run', subject: latest.runId, text: `its latest run (${code(latest.runId)}${latest.pr === undefined ? '' : `, pull request ${code(`#${latest.pr}`)}`}) ended ${code(latest.verdict)}` })
    }
  }
  return items
}

/**
 * What identifies the attention set: the repositories, kinds and subjects,
 * not the wording and not the time. Two reports with the same key need the
 * same attention, so the summary issue is left as it is.
 */
export function fleetAttentionKey(items: FleetAttention[]): string {
  const lines = items.map((item) => `${item.repository.toLowerCase()}\t${item.kind}\t${item.subject}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/**
 * Text from a repository (a title, a reason, an issue number) in a table cell
 * or a line: a code span, so nothing in it renders, links or mentions. An
 * issue number is one too: written bare, `#7` would link to the wrong
 * repository's issue, and `owner/name#7` would leave a reference on theirs.
 */
function code(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ').replace(/`/g, "'")
  return `\`${flat.replaceAll('|', '\\|')}\``
}

function countsLine(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([outcome, count]) => `${count} ${code(outcome)}`)
  return parts.length === 0 ? 'no criteria' : parts.join(', ')
}

/**
 * The page: one table of every repository, then each repository's detail. It
 * links nowhere and mentions nobody, so it reads the same wherever it is
 * published; issue and pull request numbers are named with their repository.
 */
export function renderFleetReport(states: FleetRepositoryState[], at: string): string {
  const sorted = [...states].sort((a, b) => (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0))
  const attention = fleetAttention(sorted)
  const lines: string[] = [
    '# QARE fleet report',
    '',
    `As of ${at}. ${sorted.length} ${sorted.length === 1 ? 'repository' : 'repositories'}; ${attention.length === 0 ? 'nothing needs attention' : `${attention.length} ${attention.length === 1 ? 'thing needs' : 'things need'} attention`}.`,
    '',
    'Built from what each repository publishes: its ledger, the run records on its `qa-assets` branch, and the open issues qare filed. A part that could not be read is said to be unread, and is never counted as healthy. Coverage is what the ledger records as verified and current; a criterion a repository is holding in quarantine, or refused in its last run, is shown in that repository\'s own standing report, not here.',
    '',
    '| repository | latest run | open regressions | ledger | coverage | stale | needs attention |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const state of sorted) {
    const mine = attention.filter((item) => item.repository === state.repository).length
    const run = isUnread(state.runs) ? 'unread' : state.runs[0] === undefined ? 'no run recorded' : `${code(state.runs[0].verdict)} (${state.runs[0].recordedAt.slice(0, 10)})`
    const regressions = isUnread(state.issues) ? 'unread' : String(state.issues.regression.length)
    const ledger = isUnread(state.ledger) ? 'unread' : state.ledger === 'absent' ? 'none' : `${state.ledger.size} criteria`
    const coverage = isUnread(state.ledger) || state.ledger === 'absent' ? '' : coverageOf(state.ledger) === undefined ? '' : `${coverageOf(state.ledger)}%`
    const stale = isUnread(state.ledger) || state.ledger === 'absent' ? '' : String(state.ledger.stale.length)
    lines.push(`| ${code(state.repository)} | ${run} | ${regressions} | ${ledger} | ${coverage} | ${stale} | ${mine === 0 ? 'no' : `yes (${mine})`} |`)
  }
  for (const state of sorted) {
    lines.push('', `## ${code(state.repository)}`, '')
    if (isUnread(state.ledger)) lines.push(`- Ledger: could not be read: ${code(state.ledger.unread)}`)
    else if (state.ledger === 'absent') lines.push('- Ledger: the repository carries none at the path the fleet config names.')
    else {
      const ledger = state.ledger
      const coverage = coverageOf(ledger)
      lines.push(
        `- Ledger: ${ledger.size} criteria; by the ledger's record, ${ledger.proven} verified and current${coverage === undefined ? '' : ` (${coverage}%)`}, ${ledger.stale.length} stale, ${ledger.unverified} never verified.`,
      )
      if (ledger.stale.length > 0) lines.push(`- Stale criteria: ${ledger.stale.map(code).join(', ')}`)
    }
    if (isUnread(state.runs)) lines.push(`- Runs: could not be read: ${code(state.runs.unread)}`)
    else if (state.runs.length === 0) lines.push('- Runs: none recorded on `qa-assets`.')
    else {
      lines.push('- Latest runs, newest first:')
      for (const run of state.runs)
        lines.push(`  - ${run.recordedAt.slice(0, 10)}: ${code(run.verdict)}${run.pr === undefined ? '' : `, pull request ${code(`#${run.pr}`)}`}, ${countsLine(run.counts)} (run ${code(run.runId)})`)
    }
    if (isUnread(state.issues)) lines.push(`- Issues: could not be read: ${code(state.issues.unread)}`)
    else {
      const issues = state.issues
      const total = issues.regression.length + issues.environment.length + issues.failure.length
      if (total === 0) lines.push('- Open issues filed by qare: none.')
      for (const kind of ['regression', 'environment', 'failure'] as const)
        for (const issue of issues[kind]) lines.push(`- Open \`qa-${kind}\` issue ${code(`#${issue.number}`)}: ${code(issue.title)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export const FLEET_SUMMARY_MARKER = '<!-- qare:fleet-summary -->'
/** The label the summary issue carries, which it is found again by. */
export const FLEET_LABEL = 'qa-fleet'

export function fleetAttentionMarker(key: string): string {
  return `<!-- qare:fleet-attention:${key} -->`
}

/** The attention key a summary issue body was written for, or undefined when it carries none. */
export function fleetAttentionKeyOf(body: string): string | undefined {
  return /<!-- qare:fleet-attention:([0-9a-f]{16}) -->/.exec(body)?.[1]
}

/**
 * The summary issue: what needs attention, and nothing else. Its body carries
 * the key of the set it was written for, so the next report leaves it alone
 * unless the set changed, and a watcher is notified only then.
 */
export function fleetSummaryDraft(states: FleetRepositoryState[], at: string, where?: string): { title: string; key: string; body: string } {
  const attention = fleetAttention(states)
  const key = fleetAttentionKey(attention)
  const lines: string[] = [FLEET_SUMMARY_MARKER, fleetAttentionMarker(key), '', '# QARE fleet: what needs attention', '']
  if (attention.length === 0) lines.push(`Nothing, as of ${at}: every repository could be read, no qare issue is open, no criterion is stale, and every latest run passed.`)
  else {
    lines.push(`${attention.length} ${attention.length === 1 ? 'thing' : 'things'}, as of ${at}. This issue is rewritten only when the list changes.`, '')
    let repository: string | undefined
    for (const item of attention) {
      if (item.repository !== repository) {
        repository = item.repository
        lines.push('', `**${code(repository)}**`, '')
      }
      lines.push(`- ${item.text}`)
    }
  }
  if (where !== undefined) lines.push('', `The whole report: ${where}`)
  return { title: 'QARE fleet: what needs attention', key, body: `${lines.join('\n')}\n` }
}
