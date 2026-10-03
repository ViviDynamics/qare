import { codeSpan, type CheckRunPayload } from './evidence.js'

/**
 * A pipeline that failed before it published a verdict (#203).
 *
 * When qare's own machinery or the runner it runs on fails (a tool that will
 * not install, an image that will not pull, a planner that will not answer),
 * no acceptance criterion is evaluated, and the pull request is left with a
 * red job and nothing saying why. That reads exactly like the project failing
 * its criteria. These functions name the job and step that failed and say
 * plainly which side it is on, so nobody has to dig through logs to tell.
 *
 * The caller decides that no verdict was published (the pipeline's judge did
 * not complete); this module only reads the run's jobs and words the report.
 */

/** One step of an Actions job, as the jobs API reports it. */
export interface PipelineStep {
  name: string
  conclusion: string | null
}

/** One job of an Actions run, as the jobs API reports it. */
export interface PipelineJob {
  name: string
  /** null while the job is still running, the report job itself included. */
  conclusion: string | null
  steps: PipelineStep[]
}

export interface PipelineFailure {
  /** The first job that failed. */
  job: string
  /** Its first failed step, or undefined when it failed before any step reported. */
  step: string | undefined
  /** Jobs that never ran, because of the failure. */
  skipped: string[]
}

// A cancelled job is not a fault: the concurrency group cancels a run that a
// newer push superseded, and reporting that as qare failing would be the same
// confusion this report exists to remove.
const FAILED_JOB = new Set(['failure', 'timed_out'])

/**
 * The first failed job and its first failed step, or undefined when no job
 * failed. Jobs are taken in the order given, which is the order the jobs API
 * lists them in: the order they started.
 */
export function classifyPipelineFailure(jobs: PipelineJob[]): PipelineFailure | undefined {
  const failed = jobs.find((job) => job.conclusion !== null && FAILED_JOB.has(job.conclusion))
  if (failed === undefined) return undefined
  const step = failed.steps.find((candidate) => candidate.conclusion === 'failure')
  return {
    job: failed.name,
    step: step?.name,
    skipped: jobs.filter((job) => job.conclusion === 'skipped').map((job) => job.name),
  }
}

/**
 * The sticky comment for a pipeline that reached no verdict. Every name in it
 * is workflow content, so each goes in a code span where nothing renders; the
 * run page is named in one too, because a comment links only to files that
 * were uploaded (CONSTITUTION rule 4).
 */
export function renderPipelineFailureComment(failure: PipelineFailure, opts: { runUrl?: string | undefined } = {}): string {
  const where =
    failure.step === undefined
      ? `The ${codeSpan(failure.job)} job failed before any of its steps reported.`
      : `The ${codeSpan(failure.job)} job failed at the step ${codeSpan(failure.step)}.`
  const lines = [
    '## QARE run: not evaluated (qare or its environment failed)',
    '',
    `No acceptance criterion was evaluated, so this is not a verdict on this pull request. ${where}`,
  ]
  if (failure.skipped.length > 0)
    lines.push('', `Jobs skipped because of it: ${failure.skipped.map(codeSpan).join(', ')}.`)
  lines.push(
    '',
    "The failure is on qare's side or the runner's (installing qare's tools, pulling its image, planning, or publishing), not in the project's code. Re-run once that is fixed; until then this pull request has no QA verdict.",
  )
  if (opts.runUrl !== undefined) lines.push('', `The run's logs: ${codeSpan(opts.runUrl)}.`)
  return lines.join('\n')
}

/**
 * The check run for a pipeline that reached no verdict. It fails closed
 * (CONSTITUTION rule 6): not reaching a verdict never passes, and the title
 * keeps it apart from a `failed` verdict at a glance.
 */
export function renderPipelineFailureCheckRun(failure: PipelineFailure): CheckRunPayload {
  const where = failure.step === undefined ? `${failure.job} failed` : `${failure.job} failed at ${failure.step}`
  return {
    title: 'QARE: not evaluated (qare or environment failure)',
    summary: `No acceptance criterion was evaluated: ${where}. This is not a verdict on the pull request.`,
    conclusion: 'failure',
  }
}
