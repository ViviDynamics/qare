import { redactResult, renderCheckRun, renderComment } from '@qare/core'
import type { CheckRunPayload, EvidencePoster, RunResult } from '@qare/core'
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
  opts: { artifactUrl?: string | undefined; push?: ScreenshotPusher; evidenceDir?: string } = {},
): Promise<void> {
  const screenshots =
    opts.push === undefined || opts.evidenceDir === undefined ? undefined : await opts.push.push(result, opts.evidenceDir)
  await poster.postComment(
    renderComment(redactResult(result), { kind: 'artifact', url: opts.artifactUrl, screenshots }),
  )
  await poster.createCheckRun(renderCheckRun(result))
}
