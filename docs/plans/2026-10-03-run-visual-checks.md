# Run visual checks in qare run

Issue #143

## The gap

The planner can plan a `visual` check, `runVisualCheck` (#11) captures and
diffs, and the Playwright backend masks at capture (#119). `qare run` calls
none of it: `jobFromPlan` drops the check with a note, so a criterion such as
"the dashboard renders on a phone" is planned and then reported `unverified`.

## Scope

In:
- A job carries a visual check. `jobFromPlan` keeps it (the screenshot name,
  the page, and the widths and themes the plan chose), and the job loader
  validates it. The runner's note and the `unrunnable` and `skipped` reasons
  no longer name visual as a kind that does not run.
- `runJob` executes it through `runVisualCheck` with the Playwright
  screenshot backend and the profile's masks.
- Base and head come from the two sides #147 already runs. The base side
  captures the base screenshots into `base/`; the head side captures its own,
  reads the base's from `base/`, and diffs. There is no second mechanism: the
  base screenshots exist exactly when the base side booted and ran the
  criterion.
- A run with one side (a target profile, #122, or a run nobody asked a base
  of) captures the head only and the evidence says there was nothing to
  compare with.
- Evidence: every screenshot and diff image, and a `visual.json` record
  naming the page, each capture with the masks in force, each diff, and the
  outcome. Text in the record goes through the run's redaction rules; images
  are masked at capture, and the #52 sweep accepts them as images.
- The outcome is decided in code from what was captured and diffed.
- A diff backend: there is none in the repository today, so `runVisualCheck`
  has never produced a diff image outside a test. A small PNG reader, writer
  and pixel differ on `node:zlib`, no new dependency.
- The plan's visual check gains an optional `url`, the page to capture.
  Without it a named screenshot names no page, and "the Wikipedia article on
  Ada Lovelace" cannot be captured at all.
- `qare check` says, in its notes, when a visual check had no base comparison.
- SPEC, schemas, writing-criteria.

Out:
- Which differences a change intended (#40). Until then any difference
  between base and head fails the criterion.
- Baselines kept between runs. The base is the merge base, captured in the
  same run.
- Full-page capture and a tolerance threshold. The backend captures the
  viewport as #11 built it, and pixels are compared exactly.
- Workflow files. Nothing in the pipeline changes: the execute step already
  hands in the base checkout.

## Assumptions

- Outcome rules, all in code (rule 3). A screenshot that cannot be taken, a
  backend that will not start, or a diff that cannot be computed is
  `unverified`, naming why. A difference at any width and theme is `failed`,
  with the diff image as evidence. Every capture taken and every pair
  identical is `proven`. On the base side there is nothing to diff, so
  captured is passed and the comparison reads it as `proven` at the base.
- A two-sided run whose base screenshots are not there (the base did not
  boot, the profile's limits left the criterion out, the capture failed
  there) leaves the visual check `unverified`, never `failed` and never
  proven: a comparison was asked for and could not be made. That outcome is
  not cached, because the next run's base may boot. This includes a profile
  that sets `base.criteria: none` or `ledger`: the issue names only the base
  that will not boot, and the limits are read the same way because the
  alternative, proving a visual criterion on a booted profile without ever
  comparing it, is the quieter failure. A profile owner who wants visual
  criteria proven keeps them in the base side.
- A one-sided run is different: nothing was asked to be compared. Head
  captures alone prove the criterion and `visual.json` records
  `comparison: none` with the reason.
- Masks are the same at both sides or nothing is compared. The base side
  captures with its own profile's masks plus the head profile's, the head
  side with the head profile's. When the two sets differ the check is
  `unverified`, naming the masks: a region masked on one side only would
  show as a difference the change did not make.
- Widths and themes: the check's own, else the profile's `visual` section.
  No width anywhere is `unverified`. No theme anywhere captures `light`,
  the browser's default colour scheme.
- The page: `url` is a path on the app, or a URL that may carry run values.
  A path resolves below the target URL on a target, and against the origin
  the run proved healthy on a booted app, so the base and the head each
  capture their own app. No `url` captures the app's root.
- A target run records what the screenshot browser reached in
  `outbound.json` and refuses an undeclared host, exactly as a flow does
  (#122). A backend that cannot report it is not trusted there.
- A difference found against the base is a regression by the judge's own
  rule (proven at base, failed at head). Nothing new is decided for it.
- Each capture has the check's timeout (60 s by default).

## Tasks

- [x] 1. PNG reader, writer and pixel differ: `packages/core/test/png.test.ts`.
- [x] 2. `runVisualCheck` takes a differ that can answer "identical": `packages/core/test/visual.test.ts`.
- [x] 3. The screenshot backend reports what its browser reached: `packages/core/test/visual-playwright.test.ts`.
- [x] 4. The plan's visual check carries `url`: `packages/core/test/plan.test.ts`, `plan-lock.test.ts`, `plan-step.test.ts`.
- [x] 5. The job carries a visual check, and the notes stop naming it: `packages/core/test/job-from-plan.test.ts`, `run.test.ts`.
- [x] 6. `runJob` runs it on a one-sided run: `packages/core/test/visual-run.test.ts`.
- [x] 7. Both sides: base captures, head diffs, masks agree: `packages/core/test/visual-run.test.ts`.
- [x] 8. `qare check` names the missing comparison: `packages/cli/test/check-command.test.ts`.
- [x] 9. SPEC, schemas, writing-criteria.
