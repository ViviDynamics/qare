import {
  DEFAULT_STALE_AFTER,
  FLEET_LABEL,
  FLEET_SUMMARY_MARKER,
  LEDGER_FILE,
  classifySweep,
  fleetAttention,
  fleetAttentionKeyOf,
  fleetLedger,
  fleetRunOf,
  fleetSummaryDraft,
  parseLedgerDocument,
  parseSweepConfig,
  renderFleetReport,
} from '@qare/core'
import type { FleetConfig, FleetIssue, FleetIssues, FleetLedger, FleetRepositoryConfig, FleetRepositoryState, FleetRun, SweepConfig, Unread } from '@qare/core'
import type { GitHubClient } from './github.js'

/**
 * The fleet report's reading and publishing half (#151). It reads each listed
 * repository through GitHub's API with whatever identity the caller holds,
 * and publishes one page and one summary issue in the repository it runs in.
 *
 * It only reads the other repositories: it files nothing there, comments on
 * nothing, and writes no reference GitHub would record on their issues.
 *
 * Every part of a repository is read on its own. One that cannot be read
 * (the identity cannot see the repository, a ledger that does not parse, a
 * record that is not one) is reported as unread with the reason, and the
 * rest of the report still stands.
 */

/** The branch run records ride on (ADR-0002, #51). */
const ASSETS_BRANCH = 'qa-assets'
const METRICS_PREFIX = 'metrics/'
/** The most run records one report reads from a repository: each is one request. */
const MAX_RECORDS_READ = 400

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 300)
}

async function readLedger(client: GitHubClient, config: FleetRepositoryConfig, now: Date): Promise<FleetLedger | 'absent' | Unread> {
  try {
    // A file that is not there and a branch that is not there both answer
    // 404. Only the first is a repository with no ledger.
    if ((await client.getBranchHead(config.branch)) === undefined) return { unread: `the branch ${config.branch} was not found, so its ledger cannot be read` }
    const text = await client.getContents(`${config.ledger}/${LEDGER_FILE}`, config.branch)
    if (text === undefined) return 'absent'
    const document = parseLedgerDocument(JSON.parse(text.toString('utf8')))
    // The repository's own thresholds for what is stale, when it sets any.
    const sweep = await client.getContents(`${config.ledger}/sweep.json`, config.branch)
    const thresholds: SweepConfig = sweep === undefined ? { default: { staleAfter: DEFAULT_STALE_AFTER } } : parseSweepConfig(JSON.parse(sweep.toString('utf8')))
    return fleetLedger(classifySweep(document.entries, document.changes, thresholds, { now }))
  } catch (error) {
    return { unread: reason(error) }
  }
}

async function readRuns(client: GitHubClient, limit: number): Promise<FleetRun[] | Unread> {
  try {
    const head = await client.getBranchHead(ASSETS_BRANCH)
    if (head === undefined) return []
    const records = (await client.listTreePaths(await client.getCommitTree(head))).filter((path) => path.startsWith(METRICS_PREFIX) && path.endsWith('.json'))
    // A record's path is its date, then the commit it ran on: the records
    // of one day sort by commit, not by time. So whole days are read, newest
    // first, until there are at least as many records as are shown, and the
    // order within them is each record's own moment.
    const byDay = new Map<string, string[]>()
    for (const path of records) {
      const day = path.slice(METRICS_PREFIX.length).split('/')[0] ?? ''
      byDay.set(day, [...(byDay.get(day) ?? []), path])
    }
    const paths: string[] = []
    for (const day of [...byDay.keys()].sort().reverse()) {
      const held = byDay.get(day) ?? []
      // A day too busy to read whole cannot be searched for its latest run:
      // said, never guessed at from a part of it.
      if (paths.length + held.length > MAX_RECORDS_READ)
        return { unread: `${day} holds ${held.length} run records on ${ASSETS_BRANCH}, more than the ${MAX_RECORDS_READ} the report reads to find the latest` }
      paths.push(...held)
      if (paths.length >= limit) break
    }
    const runs: FleetRun[] = []
    let unreadable = 0
    for (const path of paths) {
      const content = await client.getContents(path, ASSETS_BRANCH)
      let run: FleetRun | undefined
      try {
        run = content === undefined ? undefined : fleetRunOf(JSON.parse(content.toString('utf8')))
      } catch {
        run = undefined
      }
      if (run === undefined) unreadable += 1
      else runs.push(run)
    }
    // Any record that cannot be read may be the latest run: said, never
    // skipped, since an older run that passed would otherwise stand in for it.
    if (unreadable > 0) return { unread: `${unreadable} of the ${paths.length} newest run records on ${ASSETS_BRANCH} could not be read as one, so the latest run is not known` }
    return runs.sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt)).slice(0, limit)
  } catch (error) {
    return { unread: reason(error) }
  }
}

async function readIssues(client: GitHubClient): Promise<FleetIssues | Unread> {
  try {
    // Read from the issue listing, not the search: the search index lags a
    // new issue by minutes, so a regression filed a moment ago would be
    // missing and its repository shown healthy, and the search has a rate
    // limit of its own that a fleet would reach.
    const open = async (label: string): Promise<FleetIssue[]> =>
      (await client.listOpenIssuesByLabel(label)).map((issue) => ({ number: issue.number, title: issue.title })).sort((a, b) => a.number - b.number)
    return { regression: await open('qa-regression'), environment: await open('qa-environment'), failure: await open('qa-failure') }
  } catch (error) {
    return { unread: reason(error) }
  }
}

export async function readFleetRepository(client: GitHubClient, config: FleetRepositoryConfig, opts: { now: Date; runs: number }): Promise<FleetRepositoryState> {
  // GitHub answers 404 for a repository the identity cannot see, exactly as
  // for a file or a branch that is not there. Asked first, so a repository
  // that cannot be seen is unread in every part, and never one with no
  // ledger, no runs and no issues.
  let visible: boolean
  let why = `this identity (${client.identity.kind}) cannot see ${config.repository}: GitHub answers that it is not found`
  try {
    visible = await client.canSeeRepository()
  } catch (error) {
    visible = false
    why = reason(error)
  }
  if (!visible) return { repository: config.repository, ledger: { unread: why }, runs: { unread: why }, issues: { unread: why } }
  return {
    repository: config.repository,
    ledger: await readLedger(client, config, opts.now),
    runs: await readRuns(client, opts.runs),
    issues: await readIssues(client),
  }
}

export interface FleetReport {
  states: FleetRepositoryState[]
  /** The page, as Markdown. */
  page: string
  summary: { title: string; key: string; body: string }
  attention: number
}

/**
 * Read every listed repository and render the report. `clientFor` hands back
 * the client a repository is read through; a repository no client can be made
 * for is reported as unread in every part, like one that cannot be reached.
 */
export async function buildFleetReport(config: FleetConfig, clientFor: (repository: string) => GitHubClient, opts: { now: Date; where?: string }): Promise<FleetReport> {
  const states: FleetRepositoryState[] = []
  for (const repository of config.repositories) {
    let client: GitHubClient
    try {
      client = clientFor(repository.repository)
    } catch (error) {
      const unread = { unread: reason(error) }
      states.push({ repository: repository.repository, ledger: unread, runs: unread, issues: unread })
      continue
    }
    states.push(await readFleetRepository(client, repository, { now: opts.now, runs: config.runs }))
  }
  const at = opts.now.toISOString()
  return { states, page: renderFleetReport(states, at), summary: fleetSummaryDraft(states, at, opts.where), attention: fleetAttention(states).length }
}

export interface FleetPublication {
  /** The path the page was committed at, on the branch. */
  page: { branch: string; path: string }
  /** The summary issue, and whether this report rewrote it. */
  summary: { issue: number; action: 'created' | 'updated' | 'unchanged' }
}

/**
 * Publish in the repository the report runs in: the page as one file on a
 * branch, rewritten in place, and the summary issue, found by its marker.
 * The issue is rewritten only when what needs attention changed, so a
 * watcher hears from it only then; the page always carries the latest.
 */
export async function publishFleetReport(home: GitHubClient, report: FleetReport, opts: { branch: string; path: string }): Promise<FleetPublication> {
  // The page: one commit on top of the branch, which only moves forward. A
  // push that loses a race with another run reads the head again, three times.
  const blob = await home.createBlob(Buffer.from(report.page, 'utf8'))
  let pushed = false
  let last: unknown
  for (let attempt = 1; attempt <= 3 && !pushed; attempt += 1) {
    const parent = await home.getBranchHead(opts.branch)
    const tree = await home.createTree([{ path: opts.path, mode: '100644', type: 'blob', sha: blob }], parent === undefined ? undefined : await home.getCommitTree(parent))
    const commit = await home.createCommit(`fleet report: ${report.states.length} ${report.states.length === 1 ? 'repository' : 'repositories'}, ${report.attention} needing attention`, tree, parent === undefined ? [] : [parent])
    try {
      await home.pushBranch(opts.branch, commit, parent)
      pushed = true
    } catch (error) {
      last = error
    }
  }
  if (!pushed) throw last

  // Found by its label in the issue listing, not by the search: the search
  // index lags an issue's creation by minutes, so a run soon after the first
  // would not find the issue and would open a second. The listing reads the
  // issues themselves. Should two ever exist (two runs at the same instant;
  // the guide's workflow takes a concurrency group against that), the oldest
  // is the one kept current, every time.
  const marked = (issues: Array<{ number: number; body?: string }>): Array<{ number: number; body?: string }> => issues.filter((issue) => (issue.body ?? '').includes(FLEET_SUMMARY_MARKER)).sort((a, b) => a.number - b.number)
  let existing = marked(await home.listOpenIssuesByLabel(FLEET_LABEL))[0]
  // GitHub drops a label without a word when the identity may not apply one,
  // and an issue without its label is not in that listing. So when the
  // listing holds none, the marker is looked for through the search as well:
  // late for an issue opened minutes ago, but it keeps an unlabelled one
  // from being opened again on every run.
  if (existing === undefined) existing = marked(await home.searchIssues(`repo:${home.repository} in:body is:issue is:open "${FLEET_SUMMARY_MARKER}"`))[0]
  if (existing === undefined) {
    const created = await home.createIssue(report.summary.title, report.summary.body, [FLEET_LABEL])
    return { page: opts, summary: { issue: created.number, action: 'created' } }
  }
  if (fleetAttentionKeyOf(existing.body ?? '') === report.summary.key) return { page: opts, summary: { issue: existing.number, action: 'unchanged' } }
  await home.patchIssueBody(existing.number, report.summary.body)
  return { page: opts, summary: { issue: existing.number, action: 'updated' } }
}
