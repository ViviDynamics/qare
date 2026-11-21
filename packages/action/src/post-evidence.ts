import { codeSpan, redactResult, renderCheckRun, renderComment, renderQuestion } from '@qare/core'
import type { BlockedConclusion, CheckRunPayload, DismissedFinding, EvidencePoster, ResolutionQuestion, RunResult } from '@qare/core'
import { advisoryData } from './advisory-replies.js'
import { GitHubApiError, GitHubClientError, type GitHubClient } from './github.js'
import type { ScreenshotPusher } from './qa-assets.js'

/** Marks qare's evidence comment, so a later run updates it instead of adding another. */
export const EVIDENCE_MARKER = '<!-- qare:evidence -->'

/** The check run's name on the commit. */
export const CHECK_RUN_NAME = 'QARE verdict'

/** The login the pipeline's GITHUB_TOKEN comments as. */
export const DEFAULT_AUTHOR = 'github-actions[bot]'

/**
 * Posts to one pull request at one head commit: a single sticky comment,
 * updated on every run, and a check run on that commit.
 *
 * The comment to update is found by the marker and by its author, this
 * identity. The marker alone is not enough: anyone can write it, and a token
 * that can edit their comment would put qare's verdict where they can change it.
 */
export class GitHubEvidencePoster implements EvidencePoster {
  constructor(
    private readonly client: GitHubClient,
    private readonly pr: number,
    private readonly headSha: string,
    private readonly author: string = DEFAULT_AUTHOR,
  ) {
    if (!Number.isInteger(pr) || pr <= 0) throw new GitHubClientError(`a pull request number is a positive integer (got ${pr})`)
    if (!/^[0-9a-f]{40}$/.test(headSha))
      throw new GitHubClientError(`a head SHA is 40 lowercase hex characters (got ${JSON.stringify(headSha)})`)
    if (author.trim() === '') throw new GitHubClientError('the comment author is a GitHub login')
  }

  async postComment(body: string): Promise<void> {
    // The comment is updated in place as the pull request moves, so it says
    // which commit it describes.
    const marked = `${EVIDENCE_MARKER}\n${body}\n\n<sub>qare checked ${this.headSha}</sub>`
    const existing = (await this.client.listIssueComments(this.pr))
      .filter((comment) => comment.user?.login === this.author && comment.body?.startsWith(EVIDENCE_MARKER))
      .pop()
    if (existing !== undefined) {
      try {
        await this.client.updateIssueComment(existing.id, marked)
        return
      } catch (error) {
        // Deleted since it was listed: post a fresh one. Anything else, a
        // rate limit or a permission problem, fails rather than leaving a
        // stale verdict beside a new one.
        if (!(error instanceof GitHubApiError && error.status === 404)) throw error
      }
    }
    await this.client.postIssueComment(this.pr, marked)
  }

  async createCheckRun(payload: CheckRunPayload): Promise<void> {
    await this.client.createCheckRun({
      name: CHECK_RUN_NAME,
      head_sha: this.headSha,
      status: 'completed',
      conclusion: payload.conclusion,
      output: { title: payload.title, summary: payload.summary },
    })
  }
}

/**
 * Post a judged result where reviewers look. The comment names evidence and
 * links only to the run's uploaded evidence artifact, while each screenshot the
 * caller pushed to the `qa-assets` branch links there, so it keeps resolving
 * after the artifact expires (ADR-0002). Reasons are redacted here with the
 * built-in rules as a last pass: judge has already applied the profile's, and
 * this is the point where they are published.
 */
export async function postEvidence(
  poster: EvidencePoster,
  result: RunResult,
  opts: {
    artifactUrl?: string | undefined
    push?: ScreenshotPusher
    evidenceDir?: string
    questions?: ResolutionQuestion[]
    dismissed?: DismissedFinding[]
    blockedConclusion?: BlockedConclusion
    plannerDiffExcluded?: PlannerDiffExcluded
  } = {},
): Promise<void> {
  const screenshots =
    opts.push === undefined || opts.evidenceDir === undefined ? undefined : await opts.push.push(result, opts.evidenceDir)
  const dismissed = new Set(opts.dismissed?.map((finding) => finding.id) ?? [])
  const advisory = result.advisory
  const presentation = advisory === undefined ? result : {
    ...result,
    advisory: {
      ...advisory,
      findings: advisory.findings.filter((finding) => !dismissed.has(finding.id)),
      dismissed: [...new Set([...(advisory.dismissed ?? []), ...advisory.findings.filter((finding) => dismissed.has(finding.id)).map((finding) => finding.id)])],
    },
  }
  const redacted = redactResult(presentation)
  const comment =
    renderComment(redacted, { kind: 'artifact', url: opts.artifactUrl, screenshots }) +
    renderPlannerDiffSection(opts.plannerDiffExcluded) +
    renderQuestionSection(opts.questions ?? []) +
    // The advisory findings again, as data (#150): a reply names one by id,
    // and qare reads it back from this comment to dismiss or promote it.
    advisoryData(redacted, screenshots)
  await poster.postComment(comment)
  await poster.createCheckRun(renderCheckRun(result, opts.blockedConclusion === undefined ? {} : { blocked: opts.blockedConclusion }))
}

/**
 * What collect left out of the planner's copy of the diff (#380): the
 * pathspecs it applied, the pipeline's defaults and the caller's own, and the
 * paths of the change they matched. The planner never saw those paths, so
 * the comment says so; execute and judge read the whole diff either way.
 */
export interface PlannerDiffExcluded {
  patterns: string[]
  paths: string[]
}

/** The most left-out paths the comment names before it counts the rest. */
const EXCLUDED_PATHS_SHOWN = 50

/** Read the record collect wrote; anything else is a record nobody can trust. */
export function loadPlannerDiffExcluded(text: string): PlannerDiffExcluded {
  const data: unknown = JSON.parse(text)
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  if (typeof data !== 'object' || data === null || !strings((data as Record<string, unknown>).patterns) || !strings((data as Record<string, unknown>).paths))
    throw new GitHubClientError('the planner diff exclusion record is not {"patterns": [...], "paths": [...]}')
  const record = data as { patterns: string[]; paths: string[] }
  return { patterns: record.patterns, paths: record.paths }
}

function renderPlannerDiffSection(excluded: PlannerDiffExcluded | undefined): string {
  if (excluded === undefined || excluded.patterns.length === 0) return ''
  const shown = excluded.paths.slice(0, EXCLUDED_PATHS_SHOWN)
  const rest = excluded.paths.length - shown.length
  const count = `${excluded.paths.length} path${excluded.paths.length === 1 ? '' : 's'}`
  const lines = [
    '',
    '',
    '## Planner diff',
    '',
    `The planner's copy of the diff left out these pathspecs: ${excluded.patterns.map(codeSpan).join(' ')}. They matched ${count} of this change, which the planner did not see; execute and judge read the whole diff.`,
  ]
  if (shown.length > 0) lines.push('', shown.map(codeSpan).join(', ') + (rest > 0 ? `, and ${rest} more.` : ''))
  return lines.join('\n')
}

/**
 * The questions a pull request's evidence comment carries: each question in
 * its own self-contained body, marker and all, so "asked once" is found the
 * same way a question on an issue is. Absent when there are none, so a
 * settled conflict leaves the comment as it was.
 */
function renderQuestionSection(questions: ResolutionQuestion[]): string {
  if (questions.length === 0) return ''
  return ['', '---', '', questions.map(renderQuestion).join('\n\n---\n\n')].join('\n')
}
