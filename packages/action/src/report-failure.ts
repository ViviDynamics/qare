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
 * verdict would go, so the pull request says "not evaluated, qare's side"
 * instead of showing a red job nobody can read. Returns the failure it
 * reported, or undefined when no job failed and nothing was posted.
 */
export async function reportPipelineFailure(
  client: GitHubClient,
  poster: EvidencePoster,
  run: { id: number; attempt: number; url?: string | undefined },
): Promise<PipelineFailure | undefined> {
  const jobs = await client.listRunJobs(run.id, run.attempt)
  const failure = classifyPipelineFailure(
    jobs.map((job) => ({ name: job.name, conclusion: job.conclusion, steps: job.steps ?? [] })),
  )
  if (failure === undefined) return undefined
  await poster.postComment(renderPipelineFailureComment(failure, { runUrl: run.url }))
  await poster.createCheckRun(renderPipelineFailureCheckRun(failure))
  return failure
}
