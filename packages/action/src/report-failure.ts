import {
  classifyPipelineFailure,
  renderPipelineFailureCheckRun,
  renderPipelineFailureComment,
  type EvidencePoster,
  type PipelineFailure,
} from '@qare/core'
import type { GitHubClient } from './github.js'

/**
 * Report a pipeline that failed without publishing a verdict (#203): read the
 * run's jobs, name the job and step that failed, and post that where a
 * verdict would go, so the pull request says which side failed instead of
 * showing a red job nobody can read. When execute recorded a verdict first,
 * the report says the criteria were checked and the verdict went unpublished;
 * otherwise it says nothing was evaluated. Returns the failure it reported,
 * or undefined when no job failed and nothing was posted.
 */
export async function reportPipelineFailure(
  client: GitHubClient,
  poster: EvidencePoster,
  run: { id: number; attempt: number; url?: string | undefined; recordedVerdict?: string | undefined },
): Promise<PipelineFailure | undefined> {
  const jobs = await client.listRunJobs(run.id, run.attempt)
  const recordedVerdict = run.recordedVerdict === '' ? undefined : run.recordedVerdict
  const failure = classifyPipelineFailure(
    jobs.map((job) => ({ name: job.name, conclusion: job.conclusion, steps: job.steps ?? [] })),
    { verdictRecorded: recordedVerdict !== undefined },
  )
  if (failure === undefined) return undefined
  const report = { runUrl: run.url, recordedVerdict }
  await poster.postComment(renderPipelineFailureComment(failure, report))
  await poster.createCheckRun(renderPipelineFailureCheckRun(failure, report))
  return failure
}
