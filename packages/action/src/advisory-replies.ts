import { ADVISORY_DISMISS_COMMAND, ADVISORY_PROMOTE_COMMAND, codeSpan } from '@qare/core'
import type { AdvisoryFinding, DismissedFinding, RunResult } from '@qare/core'
import type { GitHubClient, GitHubComment } from './github.js'
import { EVIDENCE_MARKER } from './post-evidence.js'

/**
 * What a person does with an advisory finding (#150). The findings ride
 * qare's evidence comment as data; a reply on the pull request dismisses one
 * (`/qa-dismiss <id>`) or files it as an issue (`/qa-promote <id>`). qare
 * carries a reply out as itself, records that it did in a comment of its own,
 * and never does either unasked: a model's opinion interrupts nobody.
 *
 * Trust: findings and records are read only from comments this identity
 * wrote, found by author as the evidence comment is, because anyone can write
 * a marker. A reply counts only from someone GitHub says has a hand in the
 * repository.
 */

/** Opens the findings a posted evidence comment carries as data. */
export const ADVISORY_DATA_MARKER = '<!-- qare:advisory-data '

/** Opens the comment qare writes when it has carried a reply out; it is the record that it did. */
export const ADVISORY_REPLY_MARKER = '<!-- qare:advisory-reply '

const MARKER_END = ' -->'

/** Who may dismiss or promote: the associations GitHub gives people with a hand in the repository. */
const MAY_REPLY = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** A finding as the posted comment carries it: with the link its screenshot was pushed to, when it was. */
export interface PostedFinding extends AdvisoryFinding {
  screenshotUrl?: string
}

/** JSON inside an HTML comment: nothing in it may end the comment early. */
function embed(marker: string, value: unknown): string {
  return `${marker}${JSON.stringify(value).replaceAll('--', '-\\u002d')}${MARKER_END}`
}

function embedded(body: string, marker: string): unknown {
  const start = body.indexOf(marker)
  if (start === -1) return undefined
  const end = body.indexOf(MARKER_END, start + marker.length)
  if (end === -1) return undefined
  try {
    return JSON.parse(body.slice(start + marker.length, end))
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The findings of a run as data for its evidence comment, so a reply can
 * name one by id after the run's artifacts are gone. A screenshot carries its
 * link only when it was pushed (rule 4). Empty when there is nothing to act
 * on, so a comment without findings is what it was.
 */
export function advisoryData(result: RunResult, screenshots: Record<string, string> | undefined): string {
  const findings = result.advisory?.findings ?? []
  if (findings.length === 0) return ''
  const posted: PostedFinding[] = findings.map((finding) => {
    const url = finding.screenshot === undefined ? undefined : screenshots?.[finding.screenshot]
    return url === undefined ? finding : { ...finding, screenshotUrl: url }
  })
  return `\n\n${embed(ADVISORY_DATA_MARKER, { findings: posted })}`
}

/** The findings an evidence comment carries; none when it carries none, or its data cannot be read. */
export function readAdvisoryData(body: string): PostedFinding[] {
  const data = embedded(body, ADVISORY_DATA_MARKER)
  if (!isRecord(data) || !Array.isArray(data.findings)) return []
  return data.findings.filter(
    (finding): finding is PostedFinding =>
      isRecord(finding) &&
      typeof finding.id === 'string' &&
      typeof finding.screen === 'string' &&
      typeof finding.criterionId === 'string' &&
      typeof finding.category === 'string' &&
      typeof finding.severity === 'string' &&
      typeof finding.saw === 'string' &&
      typeof finding.why === 'string',
  )
}

interface ReplyRecord {
  /** The comment that asked. */
  comment: number
  dismissed?: DismissedFinding[]
  promoted?: Array<{ id: string; issue: number }>
}

function readRecord(body: string): ReplyRecord | undefined {
  const data = embedded(body, ADVISORY_REPLY_MARKER)
  if (!isRecord(data) || typeof data.comment !== 'number') return undefined
  const dismissed = Array.isArray(data.dismissed)
    ? data.dismissed.filter(
        (entry): entry is DismissedFinding =>
          isRecord(entry) && typeof entry.id === 'string' && typeof entry.screen === 'string' && typeof entry.category === 'string' && typeof entry.saw === 'string',
      )
    : []
  const promoted = Array.isArray(data.promoted)
    ? data.promoted.filter((entry): entry is { id: string; issue: number } => isRecord(entry) && typeof entry.id === 'string' && typeof entry.issue === 'number')
    : []
  return { comment: data.comment, dismissed, promoted }
}

interface Reply {
  command: 'dismiss' | 'promote'
  ids: string[]
}

/**
 * A reply is a comment that opens with the command: `/qa-dismiss <id>` or
 * `/qa-promote <id>`, one id or several. The command quoted further down a
 * comment, or inside qare's own, is not one.
 */
export function parseAdvisoryReply(body: string | undefined): Reply | undefined {
  const first = (body ?? '').trim().split('\n')[0]?.trim() ?? ''
  const match = /^(\/qa-dismiss|\/qa-promote)\s+(.+)$/.exec(first)
  if (match === null) return undefined
  const ids = [...new Set((match[2] ?? '').split(/[,\s]+/).filter((id) => /^[0-9a-f]{8}$/.test(id)))]
  if (ids.length === 0) return undefined
  return { command: match[1] === ADVISORY_DISMISS_COMMAND ? 'dismiss' : 'promote', ids }
}

/**
 * What marks the issue a finding was promoted to, in the issue's own body:
 * the pull request and the finding. The reply record on the pull request is
 * written after the issue is, so a run that dies between the two leaves an
 * issue no record names; the marker is how the next sweep finds it again
 * instead of filing a second one.
 */
export function advisoryIssueMarker(pr: number, id: string): string {
  return `qare:advisory-issue pr-${pr} ${id}`
}

function issueTitle(finding: PostedFinding): string {
  const flat = finding.saw.replace(/\s+/g, ' ').trim()
  return `UX: ${flat.length <= 100 ? flat : `${flat.slice(0, 99)}…`}`
}

/**
 * The issue a promoted finding becomes: the finding, its screen, its
 * screenshot and the way back to the pull request. Model text stays in code
 * spans, and the body says what it is: an opinion a person chose to track.
 */
export function advisoryIssueBody(finding: PostedFinding, pr: number, by: string): string {
  const screenshot =
    finding.screenshotUrl !== undefined
      ? [`![The screen](<${finding.screenshotUrl}>)`]
      : finding.screenshot !== undefined
        ? [`The screenshot ${codeSpan(finding.screenshot)} is in the evidence artifact of the run on pull request #${pr}; it was not pushed anywhere it can be linked.`]
        : ['The run saved no screenshot of this screen.']
  return [
    `<!-- ${advisoryIssueMarker(pr, finding.id)} -->`,
    `A UX finding qare's advisory review raised on pull request #${pr}, filed here because @${by} asked for it (${codeSpan(`${ADVISORY_PROMOTE_COMMAND} ${finding.id}`)}).`,
    '',
    `- Screen: ${codeSpan(finding.screen)}, reached while checking criterion ${codeSpan(finding.criterionId)}`,
    ...(finding.element === undefined ? [] : [`- Element: ${codeSpan(finding.element)}`]),
    `- Severity: ${finding.severity}`,
    `- Category: ${finding.category}`,
    '',
    '### What the reviewer saw',
    '',
    codeSpan(finding.saw),
    '',
    '### Why it matters',
    '',
    codeSpan(finding.why),
    '',
    '### Screenshot',
    '',
    ...screenshot,
    '',
    `This is a model's opinion about a screen, not a failed check: no verdict on pull request #${pr} depended on it.`,
  ].join('\n')
}

export interface AdvisoryReplies {
  /** Every finding dismissed on this pull request, for the reviewer of the next run. */
  dismissed: DismissedFinding[]
  /** Every finding promoted on this pull request, with the issue it became. */
  promoted: Array<{ id: string; issue: number }>
  /** How many replies this sweep carried out. */
  answered: number
}

/**
 * Carry out the replies on a pull request, and report what stands dismissed
 * and promoted. It is a sweep over the comments, safe to run as often as
 * anything asks: a reply qare already answered is found by the record qare
 * wrote, so nothing is dismissed, filed or said twice.
 */
export async function carryOutAdvisoryReplies(client: GitHubClient, pr: number, author: string): Promise<AdvisoryReplies> {
  const comments = await client.listIssueComments(pr)
  const own = (comment: GitHubComment): boolean => comment.user?.login === author
  const evidence = comments.filter((comment) => own(comment) && comment.body?.startsWith(EVIDENCE_MARKER) === true).pop()
  const posted = new Map(readAdvisoryData(evidence?.body ?? '').map((finding) => [finding.id, finding]))

  const answeredComments = new Set<number>()
  const dismissed = new Map<string, DismissedFinding>()
  const promoted = new Map<string, number>()
  for (const comment of comments) {
    if (!own(comment) || comment.body?.startsWith(ADVISORY_REPLY_MARKER) !== true) continue
    const record = readRecord(comment.body)
    if (record === undefined) continue
    answeredComments.add(record.comment)
    for (const finding of record.dismissed ?? []) dismissed.set(finding.id, finding)
    for (const entry of record.promoted ?? []) promoted.set(entry.id, entry.issue)
  }

  let answered = 0
  for (const comment of comments) {
    if (answeredComments.has(comment.id)) continue
    // qare's own evidence comment and records quote the commands; they open
    // with a marker, so they parse as no reply at all.
    const reply = parseAdvisoryReply(comment.body)
    if (reply === undefined || !MAY_REPLY.has(comment.author_association ?? '')) continue
    const by = comment.user?.login ?? 'someone'
    const record: ReplyRecord = { comment: comment.id }
    const said: string[] = []
    for (const id of reply.ids) {
      const finding = posted.get(id)
      if (reply.command === 'dismiss') {
        if (dismissed.has(id)) {
          said.push(`Advisory finding ${codeSpan(id)} is already dismissed on this pull request.`)
          continue
        }
        if (finding === undefined) {
          said.push(missing(id))
          continue
        }
        const entry: DismissedFinding = {
          id,
          screen: finding.screen,
          category: finding.category,
          saw: finding.saw,
          ...(finding.element === undefined ? {} : { element: finding.element }),
        }
        dismissed.set(id, entry)
        record.dismissed = [...(record.dismissed ?? []), entry]
        said.push(`Dismissed advisory finding ${codeSpan(id)} (${codeSpan(finding.saw)}) at the request of @${by}. It will not be raised again on this pull request.`)
        continue
      }
      // Asked of GitHub only when no record on the pull request names an
      // issue: the search index lags a new issue by minutes, so the record is
      // the first word and the marker the fallback.
      const existing =
        promoted.get(id) ??
        (await client.searchOwnIssues(advisoryIssueMarker(pr, id)))[0]?.number
      if (existing !== undefined) {
        if (!promoted.has(id)) {
          promoted.set(id, existing)
          record.promoted = [...(record.promoted ?? []), { id, issue: existing }]
        }
        said.push(`Advisory finding ${codeSpan(id)} is already filed as #${existing}.`)
        continue
      }
      if (finding === undefined) {
        said.push(missing(id))
        continue
      }
      const issue = await client.createIssue(issueTitle(finding), advisoryIssueBody(finding, pr, by))
      promoted.set(id, issue.number)
      record.promoted = [...(record.promoted ?? []), { id, issue: issue.number }]
      said.push(`Filed advisory finding ${codeSpan(id)} as #${issue.number}, at the request of @${by}.`)
    }
    await client.postIssueComment(pr, [embed(ADVISORY_REPLY_MARKER, record), ...said].join('\n'))
    answered += 1
  }
  return {
    dismissed: [...dismissed.values()],
    promoted: [...promoted].map(([id, issue]) => ({ id, issue })),
    answered,
  }
}

function missing(id: string): string {
  return `No advisory finding ${codeSpan(id)} is in qare's comment on this pull request, so there is nothing to act on. A finding can be dismissed or promoted while the comment still lists it.`
}
