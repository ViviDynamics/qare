# Plan batches can run at the same time, for a caller whose endpoint can take it

Issue #265

## Scope

In: a setting for how many plan batches are with the model at once
(`QARE_PLAN_CONCURRENCY` in the environment, `plan-concurrency` as a pipeline
input, `concurrency` on `planRun`), with a default of one; a merge that does
not depend on the order batches end in; the row in docs/pipeline.md and the
line in docs/SPEC.md.

Out: the verifier's batches (#275), which run one after another as before. The
issue asks for the planner only, and the verifier's turns are a quarter of the
planner's wall clock. Out too: any attempt by qare to find out what an endpoint
can take (probing it, or backing off when it refuses). That would teach qare
about providers and retries, which is nare's ground (CONSTITUTION.md, rule 1).

## Assumptions

- The default stays one batch at a time. Whether an endpoint serves several
  requests side by side is the caller's to know; the one real consumer runs a
  self-hosted model whose capacity for concurrent requests is unknown.
- The setting is a number of batches, not of criteria: `plan-batch-size` says
  how many batches there are, and this says how many of them wait at once.
- There is no upper bound in qare. A number above the number of batches runs
  them all at once and starts no more turns than there are batches.
- Each batch is reported through `onBatch` as it ends, under its own place
  among the batches, so the lines of `qare plan` can arrive out of order.
- The merged plan, its usage and the failure named when every batch is lost are
  computed from the batches in the order asked, so they are the same at any
  concurrency.
- An error that is not a planning gap (not a `PlanStepError` and not a
  `NareRunnerError`) still ends the step as itself, but only after the turns
  already with the model have ended, and no new batch is started behind it.
- The nare runner is safe to run side by side: every run has its own working
  directory and its own process. The exploration and MCP tool servers are HTTP
  servers that already answer more than one request.

## Tasks

- [x] 1. `planConcurrency()` reads `QARE_PLAN_CONCURRENCY`, defaults to one and
  refuses anything that is not a whole number above zero:
  `packages/core/test/plan-concurrency.test.ts`.
- [x] 2. `planRun` keeps up to that many batches in flight, merges by place,
  sums usage over every batch, and a failing batch costs only its own criteria:
  the gated runner tests in the same file.
- [x] 3. `qare plan` takes the setting from the environment through the real
  nare path: `packages/cli/test/plan-concurrency-command.test.ts`.
- [x] 4. The pipeline input reaches the plan container only when set, and
  docs/pipeline.md says when it helps and when it does not:
  `packages/cli/test/pipeline-caller.test.ts`.
- [x] 5. Stamp the release that carries it.
