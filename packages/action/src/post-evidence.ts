import { renderCheckRun, renderComment } from '@qare/core'
import type { CheckRunPayload, EvidencePoster, RunResult } from '@qare/core'
import { GitHubApiError, GitHubClientError, type GitHubClient } from './github.js'

/** Marks qare's evidence comment, so a later run updates it instead of adding another. */
export const EVIDENCE_MARKER = '<!-- qare:evidence -->'

/** The check run's name on the commit. */
export const CHECK_RUN_NAME = 'QARE verdict'

/**
 * Posts to one pull request at one head commit: a single sticky comment,
 * updated on every run, and a check run on that commit.
 */
export class GitHubEvidencePoster implements EvidencePoster {
  constructor(
    private readonly client: GitHubClient,
    private readonly pr: number,
    private readonly headSha: string,
  ) {
    if (!Number.isInteger(pr) || pr <= 0) throw new GitHubClientError(`a pull request number is a positive integer (got ${pr})`)
    if (!/^[0-9a-f]{40}$/.test(headSha))
      throw new GitHubClientError(`a head SHA is 40 lowercase hex characters (got ${JSON.stringify(headSha)})`)
  }

  async postComment(body: string): Promise<void> {
    const marked = `${EVIDENCE_MARKER}\n${body}`
    const existing = (await this.client.listIssueComments(this.pr))
      .filter((comment) => comment.body?.startsWith(EVIDENCE_MARKER))
      .pop()
    if (existing !== undefined) {
      try {
        await this.client.updateIssueComment(existing.id, marked)
        return
      } catch (error) {
        // Someone else's comment carrying the marker, or one deleted since it
        // was listed: this identity cannot update it, so it adds its own.
        if (!(error instanceof GitHubApiError && (error.status === 403 || error.status === 404))) throw error
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
 * links only to the run's uploaded evidence artifact, and says which commit
 * it describes, since it is updated in place as the pull request moves.
 */
export async function postEvidence(
  poster: EvidencePoster,
  result: RunResult,
  opts: { headSha: string; artifactUrl?: string | undefined },
): Promise<void> {
  const links = opts.artifactUrl === undefined ? { kind: 'artifact' as const } : { kind: 'artifact' as const, url: opts.artifactUrl }
  const body = `${renderComment(result, links)}\n\n<sub>qare checked ${opts.headSha}</sub>`
  await poster.postComment(body)
  await poster.createCheckRun(renderCheckRun(result))
}
