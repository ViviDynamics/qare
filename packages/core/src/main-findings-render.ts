import { createHash } from 'node:crypto'
import { codeSpan } from './evidence.js'
import {
  ENVIRONMENT_FINGERPRINT,
  QA_ENVIRONMENT_LABEL,
  QA_FAILURE_LABEL,
  QA_REGRESSION_LABEL,
  type EnvironmentFinding,
  type MainFinding,
} from './main-findings.js'
import { MAX_MENTIONS, isMentionable, type Blame, type BlameRange, type BlamedPerson } from './main-findings-blame.js'
import { BUILTIN_REDACTION_RULES, redactText, type RedactionRule } from './redact.js'
import type { RunVerdict } from './result.js'

/**
 * What an issue for a finding on `main` says (#154), and the markers it is
 * found by. Text that came from a run, the ledger or the repository sits in
 * code spans, where nothing renders and nothing mentions; the only mentions
 * are the ones blame decided on, written once, on the new issue. Every body
 * is swept by the redaction rules as it is rendered (#52), and a file is
 * linked only when it was uploaded (rule 4).
 */

/** The run a finding or a recovery is reported from. */
export interface MainRunContext {
  /** The revision the run checked. */
  headSha: string
  /** The run's verdict, as qare's code computed it. */
  verdict: RunVerdict
  /** The workflow run, when the caller names it. */
  runUrl?: string | undefined
  /** The run's uploaded evidence artifact, when there is one. */
  artifactUrl?: string | undefined
  /** Evidence paths pushed to the `qa-assets` branch, valued at the link each was pushed to. */
  screenshots?: Record<string, string> | undefined
}

export interface MainFindingIssue {
  title: string
  body: string
  labels: string[]
}

/** What every finding issue's marker opens with: one search finds them all. */
export const MAIN_FINDING_MARKER_PREFIX = 'qare:main-finding'

/** The hidden marker an issue is found again by: one issue per fingerprint. */
export function mainFindingMarker(fingerprint: string): string {
  return `<!-- ${MAIN_FINDING_MARKER_PREFIX} ${fingerprint} -->`
}

/** A criterion id as a marker carries it: hashed, so no id can end the comment or change the search. */
export function mainCriterionKey(criterionId: string): string {
  return `mc-${createHash('sha256').update(criterionId, 'utf8').digest('hex').slice(0, 16)}`
}

function criterionMarker(criterionId: string): string {
  return `<!-- qare:main-criterion ${mainCriterionKey(criterionId)} -->`
}

/** The markers a body carries: the fingerprint, and the criterion a recovery closes it by. */
export function readMainFindingMarkers(body: string): { fingerprint?: string; criterion?: string } {
  const fingerprint = /<!-- qare:main-finding (mf-[0-9a-z-]+) -->/.exec(body)?.[1]
  const criterion = /<!-- qare:main-criterion (mc-[0-9a-f]{16}) -->/.exec(body)?.[1]
  return {
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(criterion === undefined ? {} : { criterion }),
  }
}

/**
 * The body of an issue qare closed on recovery: its markers no longer find
 * it. The same problem coming back later is a new regression, with a new
 * range and new people to tell, so it opens a new issue; an issue that is
 * closed and still carries its marker was closed by a person.
 */
export function retireMainFindingMarkers(body: string): string {
  return body
    .replaceAll('<!-- qare:main-finding mf-', '<!-- qare:main-finding-recovered mf-')
    .replaceAll('<!-- qare:main-criterion mc-', '<!-- qare:main-criterion-recovered mc-')
}

function safeUrl(url: string | undefined): string | undefined {
  return url !== undefined && /^https:\/\/[^\s<>]+$/.test(url) ? url : undefined
}

/** A commit is written bare, so GitHub links it, only when it is nothing but a commit id. */
function revision(sha: string, span: Span): string {
  return /^[0-9a-f]{40}$/.test(sha) ? sha : span(sha)
}

function where(context: MainRunContext, span: Span): string {
  const run = safeUrl(context.runUrl)
  return `at ${revision(context.headSha, span)}${run === undefined ? '' : `, in [the run](<${run}>)`}`
}

function verdictLine(context: MainRunContext): string {
  return `- Verdict of the run: ${context.verdict}, decided by qare's code from the checks it executed`
}

/** A picture's alternative text is outside any code span, so it keeps only what cannot render or mention. */
function basename(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/[^A-Za-z0-9._-]/g, ' ')
}

function evidenceSection(evidence: string[], context: MainRunContext, span: Span): string[] {
  const paths = evidence.filter((path) => path !== '')
  if (paths.length === 0) return ['### Evidence', '', 'The run saved no evidence for this.', '']
  let pushed = 0
  const lines = paths.map((path) => {
    const url = safeUrl(context.screenshots?.[path])
    if (url === undefined) return `- ${span(path)}`
    pushed += 1
    return `- ![${basename(path)}](<${url}>)`
  })
  const artifact = safeUrl(context.artifactUrl)
  const note =
    artifact !== undefined
      ? `The run's evidence is in its [evidence artifact](<${artifact}>), for as long as GitHub keeps it.`
      : pushed === paths.length
        ? undefined
        : pushed > 0
          ? 'Only the screenshots were pushed where they can be linked; the other files are named but not linked.'
          : "The run's evidence was not uploaded, so these files are named but not linked."
  return ['### Evidence', '', ...lines, ...(note === undefined ? [] : ['', note]), '']
}

function titled(prefix: string, criterionId: string): string {
  return `${prefix}: ${criterionId.replace(/[@\r\n]/g, ' ').trim()}`
}

const SHOWN_COMMITS = 20

function mention(login: string, blame: Blame, span: Span): string {
  // A person past the cap is named, never notified.
  return blame.mentions.includes(login) ? `@${login}` : span(login)
}

function pullLine(person: BlamedPerson, title: string, blame: Blame, span: Span): string {
  const head = `- #${person.pull} ${span(title)}`
  const bot = person.bot === undefined ? undefined : `opened by the bot ${span(person.bot)}`
  if (person.login === undefined || person.role === 'nobody')
    return bot === undefined ? `${head}; no person could be named for it` : `${head}, ${bot}; no person merged or approved it`
  const who = mention(person.login, blame, span)
  if (person.role === 'author') return `${head}, opened by ${who}`
  const did = person.role === 'merged' ? 'merged' : 'approved'
  return bot === undefined
    ? `${head}, ${did} by ${who}`
    : `${head}, ${bot} and ${did} by ${who}, who is mentioned because a bot cannot act on a notification`
}

function rangeSection(finding: MainFinding, blame: Blame, range: BlameRange | undefined, span: Span): string[] {
  if (finding.lastProven === undefined || range === undefined) return []
  const lines = ['### Changes since it last passed', '']
  if (range.commits.length === 0) lines.push('No commit landed since.')
  else {
    lines.push(`${range.commits.length} commit(s):`, '')
    for (const commit of range.commits.slice(0, SHOWN_COMMITS)) lines.push(`- ${revision(commit.sha, span)} ${span(commit.subject)}`)
    if (range.commits.length > SHOWN_COMMITS) lines.push(`- and ${range.commits.length - SHOWN_COMMITS} more`)
  }
  if (range.truncated) lines.push('', 'The range is longer than what was read: the commits and pull requests above are its most recent part.')
  if (blame.people.length > 0) {
    const titles = new Map(range.pulls.map((pull) => [pull.number, pull.title]))
    lines.push('', 'The pull requests that brought them:', '')
    for (const person of blame.people) lines.push(pullLine(person, titles.get(person.pull) ?? '', blame, span))
  }
  lines.push('')
  return lines
}

/**
 * The fallback's names as mentions (#298): the one place a configured handle
 * is written after an at sign. Each is a login or a team by the time it is
 * here (the blame keeps nothing else), and one that somehow is not is written
 * as code, where it mentions nobody.
 */
function mentionList(logins: readonly string[]): string {
  const written = logins.map((login) => (isMentionable(login) ? `@${login}` : codeSpan(login)))
  return written.length <= 1 ? written.join('') : `${written.slice(0, -1).join(', ')} and ${written.at(-1) ?? ''}`
}

function audienceSection(blame: Blame): string[] {
  const lines = ['### Who this is for', '']
  if (blame.fallback !== undefined) {
    lines.push(
      blame.fallback.logins.length === 0
        ? `Nobody is mentioned: ${blame.fallback.why}. Name a person or a team as \`findings.fallback\` in the profile to have an issue like this one reach someone.`
        : `${mentionList(blame.fallback.logins)} ${blame.fallback.logins.length === 1 ? 'is' : 'are'} the fallback this repository's profile names (\`findings.fallback\`). No author is named because ${blame.fallback.why}.`,
    )
  } else {
    // The mentions sit beside the pull requests above, once each: this line repeats none of them.
    lines.push('Each person mentioned above brought a change to `main` after this criterion last passed.')
    if (blame.pointed !== undefined) lines.push('', `The evidence points most at #${blame.pointed.pull}: ${blame.pointed.why}.`)
    if (blame.unpointed !== undefined) lines.push('', `No pull request is singled out: ${blame.unpointed}.`)
    if (blame.unmentioned > 0)
      lines.push('', `${blame.unmentioned} more people are in the range and are not mentioned: one issue mentions at most ${MAX_MENTIONS}.`)
  }
  lines.push('')
  return lines
}

type Span = (text: string) => string

/**
 * Text is redacted before it is fenced, never after: a rule that ran over
 * the finished Markdown could swallow the backtick that closes a span, and
 * whatever followed would render.
 */
function spanner(rules: readonly RedactionRule[]): Span {
  return (text) => codeSpan(redactText(text, rules))
}

function publish(lines: string[]): string {
  return lines.join('\n').replace(/\n+$/, '')
}

function outcomeLine(finding: MainFinding, span: Span): string {
  return `- Outcome: ${finding.outcome}${finding.reason === undefined ? '' : ` (${span(finding.reason)})`}`
}

/** The issue a failed criterion becomes: opened once per fingerprint, and the only place a mention is written. */
export function renderMainFindingIssue(
  finding: MainFinding,
  blame: Blame,
  range: BlameRange | undefined,
  context: MainRunContext,
  rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES,
): MainFindingIssue {
  const span = spanner(rules)
  const regression = finding.kind === 'regression'
  const passed =
    finding.lastProven === undefined
      ? regression
        ? "The run proved it at the base revision, and the ledger has no record of its last pass."
        : 'Nothing shows it ever passed: the ledger has no record of a pass.'
      : finding.lastProven.sha === undefined
        ? `It last passed in run ${span(finding.lastProven.run)} at ${span(finding.lastProven.at)}.`
        : // A pass from the record of runs on the default branch (#295) names the revision too.
          `It last passed in run ${span(finding.lastProven.run)}, on revision ${span(finding.lastProven.sha)}, committed at ${span(finding.lastProven.at)}${
            finding.lastProven.recordedAt === undefined ? '' : `; that pass was recorded at ${span(finding.lastProven.recordedAt)}`
          }.`
  const lines = [
    mainFindingMarker(finding.fingerprint),
    criterionMarker(finding.criterionId),
    `Criterion ${span(finding.criterionId)} failed on \`main\` ${where(context, span)}. ${passed}`,
    '',
    ...(finding.text === undefined ? [] : [`> ${span(finding.text)}`, '']),
    outcomeLine(finding, span),
    verdictLine(context),
    '',
    ...evidenceSection(finding.evidence, context, span),
    ...rangeSection(finding, blame, range, span),
    ...audienceSection(blame),
    ...(regression
      ? [
          '### Hand-off',
          '',
          `The \`${QA_REGRESSION_LABEL}\` label is the signal an orchestrator picks this issue up by. qare does not fix it and does not merge anything: it comments here while the criterion still fails, and closes the issue when a run proves it again.`,
        ]
      : ['qare comments here while the criterion still fails, and closes the issue when a run proves it.']),
  ]
  return {
    title: redactText(titled(regression ? 'QA regression on main' : 'QA failure on main', finding.criterionId), rules),
    body: publish(lines),
    labels: [regression ? QA_REGRESSION_LABEL : QA_FAILURE_LABEL],
  }
}

/** The comment a later run leaves on an open issue. It mentions nobody, so a failure that recurs does not notify again. */
export function renderMainFindingUpdate(
  finding: MainFinding,
  context: MainRunContext,
  opts: { reopened: boolean },
  rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES,
): string {
  const span = spanner(rules)
  return publish([
    opts.reopened
      ? `Reopened: this issue was closed while the criterion still fails on \`main\` ${where(context, span)}.`
      : `Still failing on \`main\` ${where(context, span)}.`,
    '',
    outcomeLine(finding, span),
    verdictLine(context),
    '',
    ...evidenceSection(finding.evidence, context, span),
  ])
}

/** The comment that closes an issue: the run that proved the criterion again. */
export function renderMainFindingRecovery(
  criterionId: string,
  context: MainRunContext,
  rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES,
): string {
  const span = spanner(rules)
  return publish([
    `Criterion ${span(criterionId)} is proven again on \`main\` ${where(context, span)}.`,
    '',
    'Closing this issue. If the same problem comes back, qare opens a new one for it.',
  ])
}

function environmentLines(environment: EnvironmentFinding, span: Span): string[] {
  return [
    `${environment.criteria.length} criterion(s) could not be checked, and none of them is reported as failing: nothing ran.`,
    '',
    ...environment.reasons.slice(0, 5).map((reason) => `- ${span(reason)}`),
    ...(environment.reasons.length > 5 ? [`- and ${environment.reasons.length - 5} more reason(s)`] : []),
    '',
  ]
}

/** The one issue a run files when nothing could boot or be reached: never one per criterion. */
export function renderEnvironmentIssue(
  environment: EnvironmentFinding,
  blame: Blame,
  context: MainRunContext,
  rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES,
): MainFindingIssue {
  const span = spanner(rules)
  return {
    title: 'QA environment down on main',
    body: publish([
      mainFindingMarker(ENVIRONMENT_FINGERPRINT),
      `qare could not boot or reach the app on \`main\` ${where(context, span)}, so no criterion was checked.`,
      '',
      ...environmentLines(environment, span),
      verdictLine(context),
      '',
      ...audienceSection(blame),
      'qare comments here while the environment stays down, and closes the issue when a run executes a check again.',
    ]),
    labels: [QA_ENVIRONMENT_LABEL],
  }
}

/** The comment a later run leaves while the environment is still down. It mentions nobody. */
export function renderEnvironmentUpdate(
  environment: EnvironmentFinding,
  context: MainRunContext,
  opts: { reopened: boolean },
  rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES,
): string {
  const span = spanner(rules)
  return publish([
    opts.reopened
      ? `Reopened: this issue was closed while the environment is still down on \`main\` ${where(context, span)}.`
      : `Still down on \`main\` ${where(context, span)}.`,
    '',
    ...environmentLines(environment, span),
    verdictLine(context),
  ])
}

/** The comment that closes the environment issue: a run in which a check executed. */
export function renderEnvironmentRecovery(context: MainRunContext, rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES): string {
  return publish([`The environment is up again on \`main\` ${where(context, spanner(rules))}: a check executed.`, '', 'Closing this issue.'])
}
