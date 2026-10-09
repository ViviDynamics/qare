import {
  BUILTIN_REDACTION_RULES,
  ENVIRONMENT_FINGERPRINT,
  MAIN_FINDING_MARKER_PREFIX,
  blameEnvironment,
  blameMainFinding,
  classifyMainRun,
  isBotAccount,
  mainCriterionKey,
  mainFindingMarker,
  readMainFindingMarkers,
  redactResult,
  redactValue,
  renderEnvironmentIssue,
  renderEnvironmentRecovery,
  renderEnvironmentUpdate,
  renderMainFindingIssue,
  renderMainFindingRecovery,
  renderMainFindingUpdate,
  retireMainFindingMarkers,
} from '@qare/core'
import type { BlameConfig, BlameRange, LedgerDocument, MainFinding, MainRunContext, RangePull, RedactionRule, RunResult } from '@qare/core'
import type { GitHubClient, GitHubIssue } from './github.js'
import type { ScreenshotPusher } from './qa-assets.js'

/**
 * Findings on `main` become GitHub issues (#154): one per problem, updated
 * while it stands, closed when a run proves the criterion again. This is the
 * judge-side step: it holds the GitHub identity (#61) and runs no code from
 * the repository, only reads the judged result, the ledger and the profile
 * as data (rule 7). What is a finding, of which kind, and who is named is
 * decided by `@qare/core` from the executed result (rule 3); this file asks
 * GitHub for the range and does the writing.
 *
 * An issue is found by its marker and by its author, this identity: anyone
 * can write a marker, and an issue someone else opened is never qare's to
 * comment on, close or reopen.
 */

/** The most commits of a range that are read. */
const MAX_COMMITS = 100
/** The most pull requests of a range that are read. */
const MAX_PULLS = 20
/** The most changed files of one pull request that are read. */
const MAX_FILES = 300
/**
 * The most issues one run opens. A first run over a ledger with much failing
 * must not bury a repository, or its people, in issues: the rest are left
 * for the next run, which opens the next ten.
 */
export const MAX_NEW_ISSUES = 10

export interface MainFindingsInput {
  /** The judged result of a run on `main`. */
  result: RunResult
  ledger: LedgerDocument
  /** The revision the run checked. */
  headSha: string
  /** The login qare posts as: the author its own issues carry. */
  author: string
  /** The profile's `findings` section: the fallback and the bots. */
  findings?: BlameConfig | undefined
  /** The redaction rules: the built-in ones, and the profile's when it names any. */
  rules?: readonly RedactionRule[] | undefined
  runUrl?: string | undefined
  artifactUrl?: string | undefined
  /** Pushes the failing criteria's screenshots to `qa-assets`, so the issue can link them. */
  push?: ScreenshotPusher | undefined
  evidenceDir?: string | undefined
  /** Read everything, write nothing, and report what would be done. */
  dryRun?: boolean | undefined
}

export type MainFindingAction =
  | {
      action: 'opened'
      kind: 'regression' | 'failure' | 'environment'
      criterion?: string
      fingerprint: string
      issue?: number
      mentions: string[]
      /**
       * On a dry run alone (#294): the issue a real run would have opened,
       * as it would have been written, so whoever turns filing on has read
       * what will be filed. A real run carries none: the issue is the record.
       */
      draft?: { title: string; body: string; labels: string[] }
    }
  | { action: 'updated' | 'reopened'; criterion?: string; fingerprint: string; issue: number }
  | { action: 'closed'; criterion?: string; issue: number }
  /** A finding with no issue yet that this run did not open one for: the run had opened its share. */
  | { action: 'deferred'; criterion: string; fingerprint: string }

export interface MainFindingsOutcome {
  actions: MainFindingAction[]
  /** Criteria a quarantined check holds: they file nothing here (#50). */
  flaky: string[]
  dryRun: boolean
}

interface OwnIssue {
  number: number
  body: string
  fingerprint?: string
  criterion?: string
}

export async function publishMainFindings(client: GitHubClient, input: MainFindingsInput): Promise<MainFindingsOutcome> {
  const rules = input.rules ?? BUILTIN_REDACTION_RULES
  const dryRun = input.dryRun === true
  const result = redactResult(input.result, rules)
  const classified = classifyMainRun(result, input.ledger)
  const actions: MainFindingAction[] = []

  const mine = (issue: GitHubIssue): boolean => issue.user?.login === input.author
  const own = (issue: GitHubIssue): OwnIssue => ({ number: issue.number, body: issue.body ?? '', ...readMainFindingMarkers(issue.body ?? '') })
  // Every open issue qare filed for a finding, in one search.
  const open = (await client.searchIssues(`repo:${client.repository} is:issue is:open in:body "${MAIN_FINDING_MARKER_PREFIX}"`))
    .filter(mine)
    .map(own)
    .filter((issue) => issue.fingerprint !== undefined)
  /** An issue with this fingerprint that is closed and still carries its marker: a person closed it. */
  const closedByHand = async (fingerprint: string): Promise<OwnIssue | undefined> => {
    const marker = mainFindingMarker(fingerprint)
    const hits = await client.searchIssues(`repo:${client.repository} is:issue is:closed in:body "${MAIN_FINDING_MARKER_PREFIX} ${fingerprint}"`)
    return hits
      .filter((issue) => mine(issue) && (issue.body ?? '').includes(marker))
      .map(own)
      .sort((a, b) => b.number - a.number)[0]
  }

  // The screenshots of what failed, pushed where an issue can link them. A
  // file that was not pushed has no link (rule 4).
  let screenshots: Record<string, string> | undefined
  if (!dryRun && input.push !== undefined && input.evidenceDir !== undefined && classified.findings.length > 0) {
    const failed = new Set(classified.findings.map((finding) => finding.criterionId))
    screenshots = await input.push.push({ ...result, criteria: result.criteria.filter((criterion) => failed.has(criterion.id)) }, input.evidenceDir)
  }
  const context: MainRunContext = {
    headSha: input.headSha,
    verdict: result.verdict,
    runUrl: input.runUrl,
    artifactUrl: input.artifactUrl,
    screenshots,
  }

  const close = async (issue: OwnIssue, comment: string): Promise<void> => {
    if (dryRun) return
    await client.postIssueComment(issue.number, comment)
    await client.setIssueState(issue.number, 'closed', 'completed')
    // Retired last: an issue closed with its marker intact is at worst reopened, never lost.
    await client.patchIssueBody(issue.number, retireMainFindingMarkers(issue.body))
  }

  const environment = classified.environment
  if (environment !== undefined) {
    const existing = open.find((issue) => issue.fingerprint === ENVIRONMENT_FINGERPRINT)
    if (existing !== undefined) {
      if (!dryRun) await client.postIssueComment(existing.number, renderEnvironmentUpdate(environment, context, { reopened: false }, rules))
      actions.push({ action: 'updated', fingerprint: ENVIRONMENT_FINGERPRINT, issue: existing.number })
    } else {
      const closed = await closedByHand(ENVIRONMENT_FINGERPRINT)
      if (closed !== undefined) {
        if (!dryRun) {
          await client.setIssueState(closed.number, 'open', 'reopened')
          await client.postIssueComment(closed.number, renderEnvironmentUpdate(environment, context, { reopened: true }, rules))
        }
        actions.push({ action: 'reopened', fingerprint: ENVIRONMENT_FINGERPRINT, issue: closed.number })
      } else {
        const blame = blameEnvironment(input.findings)
        const draft = renderEnvironmentIssue(environment, blame, context, rules)
        const created = dryRun ? undefined : await client.createIssue(draft.title, draft.body, draft.labels)
        actions.push({
          action: 'opened',
          kind: 'environment',
          fingerprint: ENVIRONMENT_FINGERPRINT,
          ...(created === undefined ? {} : { issue: created.number }),
          mentions: blame.mentions,
          ...(dryRun ? { draft: { title: draft.title, body: draft.body, labels: [...draft.labels] } } : {}),
        })
      }
    }
    // Nothing ran, so nothing failed and nothing recovered: the other issues stay as they are.
    return { actions, flaky: classified.flaky, dryRun }
  }

  if (classified.environmentUp) {
    for (const issue of open.filter((candidate) => candidate.fingerprint === ENVIRONMENT_FINGERPRINT)) {
      await close(issue, renderEnvironmentRecovery(context, rules))
      actions.push({ action: 'closed', issue: issue.number })
    }
  }

  const ranges = new Map<string, BlameRange>()
  const rangeSince = async (finding: MainFinding): Promise<BlameRange | undefined> => {
    const since = finding.lastProven?.at
    // A timestamp GitHub could not read as one names no range.
    if (since === undefined || Number.isNaN(Date.parse(since))) return undefined
    const known = ranges.get(since)
    if (known !== undefined) return known
    // What GitHub says about the range is published, so it is redacted like the rest.
    const range = redactValue(await readRange(client, input.headSha, since, input.findings), rules)
    ranges.set(since, range)
    return range
  }

  let opened = 0
  for (const finding of classified.findings) {
    const existing = open.find((issue) => issue.fingerprint === finding.fingerprint)
    if (existing !== undefined) {
      // No range is read and nobody is named: a failure that recurs does not notify again.
      if (!dryRun) await client.postIssueComment(existing.number, renderMainFindingUpdate(finding, context, { reopened: false }, rules))
      actions.push({ action: 'updated', criterion: finding.criterionId, fingerprint: finding.fingerprint, issue: existing.number })
      continue
    }
    const closed = await closedByHand(finding.fingerprint)
    if (closed !== undefined) {
      if (!dryRun) {
        await client.setIssueState(closed.number, 'open', 'reopened')
        await client.postIssueComment(closed.number, renderMainFindingUpdate(finding, context, { reopened: true }, rules))
      }
      actions.push({ action: 'reopened', criterion: finding.criterionId, fingerprint: finding.fingerprint, issue: closed.number })
      continue
    }
    if (opened >= MAX_NEW_ISSUES) {
      actions.push({ action: 'deferred', criterion: finding.criterionId, fingerprint: finding.fingerprint })
      continue
    }
    opened += 1
    const range = await rangeSince(finding)
    const blame = blameMainFinding(finding, range, input.findings)
    const draft = renderMainFindingIssue(finding, blame, range, context, rules)
    const created = dryRun ? undefined : await client.createIssue(draft.title, draft.body, draft.labels)
    actions.push({
      action: 'opened',
      kind: finding.kind,
      criterion: finding.criterionId,
      fingerprint: finding.fingerprint,
      ...(created === undefined ? {} : { issue: created.number }),
      mentions: blame.mentions,
      ...(dryRun ? { draft: { title: draft.title, body: draft.body, labels: [...draft.labels] } } : {}),
    })
  }

  // A criterion the run proved closes every open issue filed for it, whatever its fingerprint was.
  const recovered = new Map(classified.recovered.map((criterion) => [mainCriterionKey(criterion), criterion]))
  for (const issue of open) {
    const criterion = issue.criterion === undefined ? undefined : recovered.get(issue.criterion)
    if (criterion === undefined) continue
    await close(issue, renderMainFindingRecovery(criterion, context, rules))
    actions.push({ action: 'closed', criterion, issue: issue.number })
  }

  return { actions, flaky: classified.flaky, dryRun }
}

/**
 * The commits on the checked revision since the criterion last passed, and
 * the pull requests that brought them. Reads are bounded: a long gap between
 * runs costs a fixed number of requests, and the range says it was cut.
 */
async function readRange(client: GitHubClient, head: string, since: string, config: BlameConfig | undefined): Promise<BlameRange> {
  const { commits, truncated } = await client.listCommitsSince(head, since, MAX_COMMITS)
  const numbers: number[] = []
  let cut = truncated
  for (const commit of commits) {
    for (const number of await client.listMergedPullsForCommit(commit.sha)) {
      if (numbers.includes(number)) continue
      if (numbers.length >= MAX_PULLS) {
        cut = true
        continue
      }
      numbers.push(number)
    }
  }
  const pulls: RangePull[] = []
  for (const number of numbers) {
    const pull = await client.getPull(number)
    // Who approved it matters only when its author is not a person to name.
    const approvers = pull.author === undefined || isBotAccount(pull.author, config) ? await client.listPullApprovers(number) : []
    // The files tell several pull requests apart; one alone needs no telling.
    const files = numbers.length > 1 ? await client.listPullFiles(number, MAX_FILES) : []
    pulls.push({
      number,
      title: pull.title,
      ...(pull.author === undefined ? {} : { author: pull.author }),
      ...(pull.mergedBy === undefined ? {} : { mergedBy: pull.mergedBy }),
      approvers,
      files,
    })
  }
  return { head, commits, truncated: cut, pulls }
}
