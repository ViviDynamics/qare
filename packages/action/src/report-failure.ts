import {
  classifyPipelineFailure,
  renderPipelineFailureCheckRun,
  renderPipelineFailureComment,
  type EvidencePoster,
  type PipelineFailure,
} from '@qare/core'
import type { GitHubClient } from './github.js'
import { DEFAULT_AUTHOR, EVIDENCE_MARKER } from './post-evidence.js'

export type PipelineFailureOutcome =
  | { kind: 'nothing-failed' }
  | { kind: 'verdict-kept' }
  | { kind: 'reported'; failure: PipelineFailure }

// The headings of the reports this module writes: a sticky comment that
// carries one of them is a report, never a verdict, and may be refreshed.
const REPORT_HEADINGS = ['## QARE run: not evaluated', '## QARE run: verdict not published']

/**
 * Whether qare's sticky comment already carries a verdict for this head.
 * judge posts the comment before its check run, so a check run that failed
 * leaves the verdict on the pull request while the pipeline still reads as
 * unpublished; a report must never replace it. The comment is found the way
 * the evidence poster finds it: by the marker and by its author.
 */
async function verdictPostedFor(client: GitHubClient, pr: number, headSha: string, author: string): Promise<boolean> {
  const sticky = (await client.listIssueComments(pr))
    .filter((comment) => comment.user?.login === author && comment.body?.startsWith(EVIDENCE_MARKER))
    .pop()
  const body = sticky?.body
  if (body === undefined || !body.includes(`qare checked ${headSha}`)) return false
  const heading = body.slice(EVIDENCE_MARKER.length + 1).split('\n')[0] ?? ''
  return heading.startsWith('## QARE run: ') && !REPORT_HEADINGS.some((report) => heading.startsWith(report))
}

/**
 * Report a pipeline that failed without publishing a verdict (#203): read the
 * run's jobs, name the job and step that failed, and post that where a
 * verdict would go, so the pull request says which side failed instead of
 * showing a red job nobody can read. When execute recorded a verdict first,
 * the report says the criteria were checked and the verdict went unpublished;
 * otherwise it says nothing was evaluated. A verdict already posted for this
 * head is left in place.
 */
export async function reportPipelineFailure(
  client: GitHubClient,
  poster: EvidencePoster,
  run: {
    id: number
    attempt: number
    pr: number
    headSha: string
    author?: string | undefined
    url?: string | undefined
    recordedVerdict?: string | undefined
    pipeline?: string[] | undefined
  },
): Promise<PipelineFailureOutcome> {
  const jobs = await client.listRunJobs(run.id, run.attempt)
  const recordedVerdict = run.recordedVerdict === '' ? undefined : run.recordedVerdict
  const failure = classifyPipelineFailure(
    jobs.map((job) => ({ name: job.name, conclusion: job.conclusion, steps: job.steps ?? [] })),
    { verdictRecorded: recordedVerdict !== undefined, ...(run.pipeline === undefined ? {} : { pipeline: run.pipeline }) },
  )
  if (failure === undefined) return { kind: 'nothing-failed' }
  if (await verdictPostedFor(client, run.pr, run.headSha, run.author ?? DEFAULT_AUTHOR)) return { kind: 'verdict-kept' }
  const report = { runUrl: run.url, recordedVerdict }
  await poster.postComment(renderPipelineFailureComment(failure, report))
  await poster.createCheckRun(renderPipelineFailureCheckRun(failure, report))
  return { kind: 'reported', failure }
}
