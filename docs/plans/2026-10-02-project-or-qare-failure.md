# Qare failure: project bug or qare bug?

Issue #203

## The failure

Every failed `QARE` run in dettmore-platform on 2026-10-02 failed in the
`plan` job, at the step `Install nare at the pinned release`, with
`Package 'nare' requires a different Python: 3.11.16 not in '>=3.12'`.
`execute` and `judge` were skipped, so no criterion was evaluated. The pull
request showed only a red `plan` job, and nothing on it said whether the
project or qare had failed. The install itself is #204.

qare's own pipeline has a second gap. A run that reaches a `failed` or a
red `blocked` verdict exits non-zero, `execute` goes red, and `judge`,
gated on `execute` succeeding, is skipped. So a genuine project failure
posts nothing either (qare run 37022667370: `verdict failed` in `execute`,
`judge` skipped). On the pull request the two cases look the same.

## Scope

In:
- A pure classifier in `@qare/core` that reads a run's jobs and steps and
  names the first job and step that failed and the jobs it left skipped,
  plus a comment and check-run rendering that say plainly that no verdict
  was reached. The rendering says this is qare's side or its environment,
  not a verdict on the pull request.
- A `report-failure` command in `@qare/action` that reads the run's jobs
  from the Actions API and posts that comment (the same sticky comment the
  evidence uses) and a `QARE verdict` check run with conclusion `failure`.
  Rule 6: not reaching a verdict never passes.
- A `report` job in `.github/workflows/qare.yml`, holding the GitHub token
  only and running qare from the base commit. It runs when a pull request's
  pipeline failed and `judge` did not complete.
- `judge` runs whenever `execute` recorded a verdict, so a `failed` or
  `blocked` verdict is posted with its criteria while `execute` stays red.
- SPEC: the pipeline table and the outcomes table describe the new report.

Out:
- The nare/Python install (#204).
- dettmore-platform's own workflow copy. It adopts the reference workflow
  on its side.

## Assumptions

- A job that fails before `execute` records a `result.json` evaluated no
  criterion, so the failure is qare's or the runner's, never the project's.
  A boot failure of the project's app is not in this class: it is a named
  `blocked` verdict in `result.json`, which `judge` now posts.
- `cancelled` jobs are not reported as failures: a superseded run is not a
  fault. `timed_out` is.
- The run URL appears in a code span, not as a link (rule 4).

## Tasks

- [x] 1. Classifier and rendering in core: tests in `packages/core/test/pipeline-failure.test.ts`.
- [ ] 2. `listRunJobs` on the GitHub client and the `report-failure` command: tests in `packages/action/test/report-failure.test.ts`.
- [ ] 3. Workflow `report` job and `judge` gating: tests in `packages/cli/test/workflow.test.ts`.
- [ ] 4. SPEC updates.
