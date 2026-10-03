# Execute the base side, so regressions are found against the merge base

Issue #147

## The gap

The judge has always known what a regression is (`detectRegressions`: proven
at the base, failed at the head), and it has never been handed a base. `runJob`
executes the head only, and `qare run`, `qare judge` and the pipeline all call
`judgeRun({ base: [] , ... })`. A criterion that fails at the head is `failed`
whether or not it worked before the change.

## Scope

In:
- `runJob` takes a base side request (`opts.base`). For a profile that boots
  an app it runs the same locked plan twice: against a checkout of `baseRef`
  first, then against the head, each under an isolation of its own (#53). The
  base app is stopped before the head boots. Base evidence is written under
  `base/`, head evidence under `head/`, and the top-level `result.json` is the
  comparison of the two.
- Where the base tree comes from: a checkout the caller already has
  (`qare run --base-repo <dir>`, or `QARE_BASE_REPO`), else a detached git
  worktree of `baseRef` the run makes and removes itself. No checkout means
  no base side, with the reason named.
- `result.json` records the comparison: a run-level `base` (the ref, whether
  it executed, why not) and, per criterion, what the base showed (`proven`,
  `failed`, or `not-compared` with the reason) plus `regression` on a
  criterion the executed checks decided at both sides.
- Regressions are computed by `judgeRun` from both sides, in `runJob` and in
  `judgeExecuted` (so in `qare judge`, `qare check`'s judge step, replay and
  the pipeline's judge job, which reads the base from `result.json`).
- The profile's `base` section states the cost: `criteria: ledger` runs only
  the criteria the ledger at the base already carries, `budget: 10m` bounds
  the base side's wall clock. What did not run is `not-compared`.
- The comment and the check run name regressions, and a regression's base
  evidence is listed beside its head evidence.
- `qare run` and the MCP run tools ask for the base side. The pipeline's
  execute step hands `qare run` a worktree of the base commit.
- SPEC, schemas and orchestrator docs.

Out:
- Choosing which ledger criteria to run (#45). The plan that is handed in
  runs on both sides.
- Visual diffs between the two sides (#143). It builds on `base/` and
  `head/`.
- `qare check`: a sentence checked against the app as it runs has no second
  side, and it keeps saying so (`baseRef: none`).
- Adding git to the published images. The pipeline hands the base checkout
  in, so the image needs none.

## Assumptions

- The base side never changes the verdict. A regression is a failure at the
  head already, so the verdict is the head's. The base side only says which
  failures are regressions. Nothing a base run does can turn a criterion
  green, and "not compared" is never "passed".
- Regression is decided only from executed outcomes at both sides (rule 3).
  A criterion the verifier fails after its head check passed is `failed`
  with the verifier's reason and carries no regression flag: no model output
  creates a regression.
- The existing judge rule stands: a waived criterion that regressed still
  fails the run. The result carries the flag on that criterion so the
  comment can say why a waived run is red.
- The base side boots from the base tree's own recipe: the profile is read
  from the same path inside the base checkout, and its compose file resolves
  inside the base checkout. A base with no profile, or one that names a
  target, executes nothing, and every criterion is `not-compared`. The cost
  limits (`base.criteria`, `base.budget`) come from the head profile, the one
  the run was configured with.
- "Already in the ledger" means the ledger in the base checkout carries the
  criterion id. A ledger that is missing carries none.
- The base side keeps no quarantine store and gets a cache of its own
  (`<cache>/base`), so a base result is never served as a head result.
- The base side runs first and is torn down before the head boots, so the
  two never contend for the machine and the head leaves its app up for the
  caller exactly as it does now.
- A run that is not asked for a base side (`runJob` without `opts.base`), a
  target profile (#122) and a missing profile are untouched: one side, the
  evidence layout as it is today.
- The pipeline runs the base revision's published image, which has no git
  and, until the next release, no base side. So the workflow passes the base
  checkout through an environment variable, which an older image ignores,
  instead of a flag it would reject. The step stays secretless.
- A several-profile job (#55) gets the same treatment through the same
  wrapper: each app's base boots from the base tree.

## Tasks

- [ ] 1. Result schema: `base` on the run and on each criterion, `regression`: `packages/core/test/result.test.ts`.
- [ ] 2. Profile `base` section (`criteria`, `budget`): `packages/core/test/profile.test.ts`.
- [ ] 3. Base checkout (given directory, or a git worktree): `packages/core/test/base-checkout.test.ts`.
- [ ] 4. `runJob` runs both sides and compares them: `packages/core/test/base-side.test.ts`.
- [ ] 5. `judgeExecuted` reads the base from the result and keeps the comparison: `packages/core/test/judge.test.ts`.
- [ ] 6. Comment and check run name regressions: `packages/core/test/evidence.test.ts`.
- [ ] 7. `qare run --base-repo` / `QARE_BASE_REPO`, MCP run tools: `packages/cli/test/base-side.test.ts`, `packages/mcp/test/mcp.test.ts`.
- [ ] 8. Pipeline execute step hands in the base worktree: `packages/cli/test/workflow.test.ts`.
- [ ] 9. SPEC, schemas, orchestrator docs.
