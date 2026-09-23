import type { CriterionResult, RunResult, RunVerdict } from './result.js'

export interface CheckRunPayload {
  title: string
  summary: string
  conclusion: 'success' | 'failure' | 'neutral'
}

/**
 * Where the comment's evidence lives, which decides what it may link to.
 *
 * `relative`: the comment is read beside the evidence directory (qare judge's
 * comment.md), so relative links resolve. `artifact`: the comment is posted on
 * a pull request, where a relative path resolves to nothing; files are named,
 * and the only link is to the run's evidence artifact, when one was uploaded.
 * Nothing links to a file that is not there to open (CONSTITUTION rule 4).
 */
export type EvidenceLinks = { kind: 'relative' } | { kind: 'artifact'; url?: string | undefined }

export interface EvidencePoster {
  postComment(body: string): Promise<void>
  createCheckRun(payload: CheckRunPayload): Promise<void>
}

const CHECK_RUN_CONCLUSIONS: Record<RunVerdict, CheckRunPayload['conclusion']> = {
  passed: 'success',
  failed: 'failure',
  blocked: 'neutral',
  refused: 'neutral',
  waived: 'neutral',
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ')
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function failedReason(criterion: CriterionResult): string {
  if (criterion.outcome === 'failed' && 'reason' in criterion && typeof criterion.reason === 'string')
    return criterion.reason
  return ''
}

type UnverifiedCause = 'waived' | 'verifier' | 'environment'

// judge names the cause at the start of the reason: a human waiver, or the
// verifier being unable to check what the checks proved. Anything else is the
// environment, which is where every other unverified criterion comes from.
function unverifiedCause(criterion: CriterionResult): UnverifiedCause {
  const reason = 'reason' in criterion && typeof criterion.reason === 'string' ? criterion.reason : ''
  if (reason.startsWith('waived by ')) return 'waived'
  if (reason.startsWith('verifier ')) return 'verifier'
  return 'environment'
}

function reasonCell(criterion: CriterionResult): string {
  if (criterion.outcome === 'unverified') {
    const cause = unverifiedCause(criterion)
    if (cause === 'waived') return `waived (human): ${criterion.reason}`
    if (cause === 'verifier') return `not independently checked: ${criterion.reason}`
    return `could not verify (environment): ${criterion.reason}`
  }
  return failedReason(criterion)
}

function detailLinks(criteria: CriterionResult[]): string[] {
  const lines: string[] = []
  for (const criterion of criteria) {
    const links = (criterion.evidence ?? [])
      .filter(path => path !== '')
      // angle brackets keep destinations intact for paths with spaces or parens
      .map(path => `[${escapeLinkText(basename(path))}](<${path}>)`)
    if (links.length > 0) lines.push(`- ${escapeLinkText(criterion.id)}: ${links.join(', ')}`)
  }
  return lines
}

function detailNames(criteria: CriterionResult[]): string[] {
  const lines: string[] = []
  for (const criterion of criteria) {
    const names = (criterion.evidence ?? []).filter(path => path !== '').map(codeSpan)
    if (names.length > 0) lines.push(`- ${codeSpan(criterion.id)}: ${names.join(', ')}`)
  }
  return lines
}

// Text shown on a pull request goes in a code span, where nothing renders: a
// link, raw HTML, a bare URL or an @mention in a reason or a path stays text.
// The fence is longer than any backtick run inside, so the text is shown
// exactly (a path can still be found in the artifact) and cannot end the span.
function codeSpan(text: string): string {
  const flat = text.replaceAll('\r', ' ').replaceAll('\n', ' ')
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

// In a table a pipe ends the cell even inside a code span unless escaped.
function cellSpan(text: string): string {
  return text === '' ? '' : codeSpan(text).replaceAll('|', '\\|')
}

function artifactLine(url: string | undefined): string {
  if (url === undefined) return "The run's evidence was not uploaded, so these files are named but not linked."
  return `The run's evidence is in its [evidence artifact](<${url}>), for as long as GitHub keeps it.`
}

function escapeLinkText(text: string): string {
  return text.replace(/[\[\]]/g, ' ')
}

export function renderComment(result: RunResult, links: EvidenceLinks = { kind: 'relative' }): string {
  const posted = links.kind === 'artifact'
  const cell = posted ? cellSpan : escapeCell
  const job = result.job === undefined ? '' : ` (job ${posted ? codeSpan(result.job.id) : result.job.id})`
  const lines = [
    `## QARE run: ${result.verdict}${job}`,
    '',
    '| criterion | outcome | reason |',
    '| --- | --- | --- |',
    ...result.criteria.map(
      criterion => `| ${cell(criterion.id)} | ${criterion.outcome} | ${cell(reasonCell(criterion))} |`,
    ),
  ]
  if (links.kind === 'relative') {
    const details = detailLinks(result.criteria)
    if (details.length > 0) lines.push('', 'Details:', '', ...details)
  } else {
    const details = detailNames(result.criteria)
    if (details.length > 0) lines.push('', 'Details:', '', ...details)
    // The artifact holds result.json and the logs even when no criterion
    // lists a file, so it is linked whenever it was uploaded.
    if (details.length > 0 || links.url !== undefined) lines.push('', artifactLine(links.url))
  }
  const unverified = result.criteria.filter(criterion => criterion.outcome === 'unverified')
  const causes = new Set(unverified.map(unverifiedCause))
  if (causes.has('waived'))
    lines.push(
      '',
      'Waived criteria are recorded as waived (human) — a waiver is not a pass and needs out-of-band confirmation.',
    )
  if (causes.has('verifier'))
    lines.push(
      '',
      'Criteria not independently checked passed their checks, but the verifier could not review them, so they do not count as proven.',
    )
  if (causes.has('environment'))
    lines.push('', 'Unverified criteria could not verify (environment) — that is not a code defect.')
  return lines.join('\n')
}

export function renderCheckRun(result: RunResult): CheckRunPayload {
  const counts = { proven: 0, failed: 0, unverified: 0 }
  for (const criterion of result.criteria) counts[criterion.outcome] += 1
  return {
    title: 'QARE',
    summary: `verdict ${result.verdict}: ${counts.proven} proven, ${counts.failed} failed, ${counts.unverified} unverified`,
    conclusion: CHECK_RUN_CONCLUSIONS[result.verdict],
  }
}
