import { expect, test } from 'vitest'
import {
  classifyPipelineFailure,
  renderPipelineFailureCheckRun,
  renderPipelineFailureComment,
  type PipelineJob,
} from '../src/pipeline-failure.js'

// The shape of dettmore-platform run 37086848535 (#203): nare would not
// install on the runner's Python, so plan failed and nothing was evaluated.
const nareInstallFailed: PipelineJob[] = [
  { name: 'collect (GitHub token only)', conclusion: 'success', steps: [{ name: 'Read the linked issue and the diff', conclusion: 'success' }] },
  {
    name: 'plan (model key + GitHub token only)',
    conclusion: 'failure',
    steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Build qare', conclusion: 'success' },
      { name: 'Install nare at the pinned release', conclusion: 'failure' },
      { name: 'Plan the QA run', conclusion: 'skipped' },
    ],
  },
  { name: 'execute (no secrets)', conclusion: 'skipped', steps: [] },
  { name: 'judge (GitHub token only)', conclusion: 'skipped', steps: [] },
]

const RUN_URL = ['https:', '//github.com/octocat/app/actions/runs/37086848535'].join('')

test('a failed setup step is named with its job and the jobs it left skipped', () => {
  expect(classifyPipelineFailure(nareInstallFailed)).toEqual({
    job: 'plan (model key + GitHub token only)',
    step: 'Install nare at the pinned release',
    skipped: ['execute (no secrets)', 'judge (GitHub token only)'],
  })
})

// requeue runs only on push, so it is skipped on every pull request whatever
// happened; it, and the report job itself, are not part of the pipeline the
// report describes.
test('a pipeline scope keeps jobs outside it out of the failure and the skipped list', () => {
  const jobs: PipelineJob[] = [
    { name: 'requeue (GitHub token only)', conclusion: 'skipped', steps: [] },
    ...nareInstallFailed,
    { name: 'report (GitHub token only)', conclusion: 'failure', steps: [] },
  ]
  expect(classifyPipelineFailure(jobs, { pipeline: ['collect', 'plan', 'execute', 'judge'] })).toEqual({
    job: 'plan (model key + GitHub token only)',
    step: 'Install nare at the pinned release',
    skipped: ['execute (no secrets)', 'judge (GitHub token only)'],
  })
  // A name matches its job id exactly, or as the id followed by its label.
  expect(classifyPipelineFailure([{ name: 'planner', conclusion: 'failure', steps: [] }], { pipeline: ['plan'] })).toBeUndefined()
  expect(classifyPipelineFailure([{ name: 'plan', conclusion: 'failure', steps: [] }], { pipeline: ['plan'] })?.job).toBe('plan')
})

test('the check run summary keeps job and step names inert', () => {
  const summary = renderPipelineFailureCheckRun({ job: 'plan [x](javascript:alert(1))', step: '<b>step</b>', skipped: [] }).summary
  expect(summary).toContain('`plan [x](javascript:alert(1))`')
  expect(summary).toContain('`<b>step</b>`')
})

test('a run with no failed job has nothing to report', () => {
  const green: PipelineJob[] = [
    { name: 'plan', conclusion: 'success', steps: [] },
    { name: 'execute', conclusion: 'success', steps: [] },
  ]
  expect(classifyPipelineFailure(green)).toBeUndefined()
})

// A superseded run is cancelled by the concurrency group: that is not a fault,
// and saying qare failed would be the same confusion #203 is about.
test('a cancelled job is not a failure', () => {
  expect(classifyPipelineFailure([{ name: 'plan', conclusion: 'cancelled', steps: [] }])).toBeUndefined()
})

test('a timed out job is a failure', () => {
  const timedOut: PipelineJob[] = [
    { name: 'execute', conclusion: 'timed_out', steps: [{ name: 'Run the plan', conclusion: 'cancelled' }] },
  ]
  expect(classifyPipelineFailure(timedOut)).toEqual({ job: 'execute', step: undefined, skipped: [] })
})

// The job that reports is itself in the run and still in progress.
test('a job still running is neither a failure nor skipped', () => {
  const jobs: PipelineJob[] = [...nareInstallFailed, { name: 'report (GitHub token only)', conclusion: null, steps: [] }]
  expect(classifyPipelineFailure(jobs)?.skipped).toEqual(['execute (no secrets)', 'judge (GitHub token only)'])
})

test('a job that failed before any step ran names no step', () => {
  expect(classifyPipelineFailure([{ name: 'plan', conclusion: 'failure', steps: [] }])).toEqual({
    job: 'plan',
    step: undefined,
    skipped: [],
  })
})

test('the comment says no criterion was evaluated and which side failed', () => {
  const failure = classifyPipelineFailure(nareInstallFailed)
  if (failure === undefined) throw new Error('expected a failure')
  const comment = renderPipelineFailureComment(failure, { runUrl: RUN_URL })
  expect(comment.split('\n')[0]).toBe('## QARE run: not evaluated (qare or its environment failed)')
  expect(comment).toContain('No acceptance criterion was evaluated')
  expect(comment).toContain('not a verdict on this pull request')
  expect(comment).toContain('`plan (model key + GitHub token only)`')
  expect(comment).toContain('`Install nare at the pinned release`')
  expect(comment).toContain('`execute (no secrets)`, `judge (GitHub token only)`')
  // Rule 4: the run page is not an uploaded file, so it is named, not linked.
  expect(comment).toContain(`\`${RUN_URL}\``)
  expect(comment).not.toContain(`](${RUN_URL}`)
  expect(comment).not.toContain(`](<${RUN_URL}`)
})

test('a job name carrying markdown cannot reshape the comment', () => {
  const comment = renderPipelineFailureComment({ job: 'plan [x](javascript:alert(1)) @team', step: 'a `step`', skipped: [] })
  expect(comment).toContain('`plan [x](javascript:alert(1)) @team`')
  expect(comment).toContain('`` a `step` ``')
  expect(comment).not.toContain('Jobs skipped')
})

test('a failure with no step says so', () => {
  const comment = renderPipelineFailureComment({ job: 'plan', step: undefined, skipped: [] })
  expect(comment).toContain('The `plan` job failed before any of its steps reported')
})

// Rule 6: not reaching a verdict never passes, and the title tells it apart
// from a verdict at a glance.
test('the check run fails closed and names the failed job and step', () => {
  const failure = classifyPipelineFailure(nareInstallFailed)
  if (failure === undefined) throw new Error('expected a failure')
  expect(renderPipelineFailureCheckRun(failure)).toEqual({
    title: 'QARE: not evaluated (qare or environment failure)',
    summary:
      'No acceptance criterion was evaluated: `plan (model key + GitHub token only)` failed at `Install nare at the pinned release`. This is not a verdict on the pull request.',
    conclusion: 'failure',
  })
})

// Judge can fail after execute checked the criteria (the verifier did not
// answer, the post was refused). Saying nothing was evaluated would then be
// false: the criteria were checked, and the verdict was not published. A
// failed verdict leaves execute red too, but that red is the verdict, not the
// fault, so the failure named is the later one.
const judgeFailed: PipelineJob[] = [
  { name: 'execute (no secrets)', conclusion: 'failure', steps: [{ name: 'Run the plan', conclusion: 'failure' }] },
  { name: 'judge (model key + GitHub token only)', conclusion: 'failure', steps: [{ name: 'Judge the result', conclusion: 'failure' }] },
]

test('with a recorded verdict, the failure named is the last one, after the verdict', () => {
  expect(classifyPipelineFailure(judgeFailed, { verdictRecorded: true })).toEqual({
    job: 'judge (model key + GitHub token only)',
    step: 'Judge the result',
    skipped: [],
  })
  expect(classifyPipelineFailure(judgeFailed)?.job).toBe('execute (no secrets)')
})

test('a verdict execute recorded but nobody published is reported as unpublished, not unevaluated', () => {
  const failure = classifyPipelineFailure(judgeFailed, { verdictRecorded: true })
  if (failure === undefined) throw new Error('expected a failure')
  const comment = renderPipelineFailureComment(failure, { recordedVerdict: 'failed' })
  expect(comment.split('\n')[0]).toBe('## QARE run: verdict not published (qare failed after checking)')
  expect(comment).toContain('qare checked the acceptance criteria and recorded the verdict `failed`')
  expect(comment).toContain("in the run's evidence artifact")
  expect(comment).toContain('`judge (model key + GitHub token only)`')
  expect(comment).not.toContain('No acceptance criterion was evaluated')
  expect(renderPipelineFailureCheckRun(failure, { recordedVerdict: 'failed' })).toEqual({
    title: 'QARE: verdict not published (qare failure)',
    summary:
      "qare recorded the verdict `failed` but did not publish it: `judge (model key + GitHub token only)` failed at `Judge the result`. The verdict is in the run's evidence artifact.",
    conclusion: 'failure',
  })
})
