# The planner plans in batches, so one cut-off turn does not lose every criterion

Issue #259

## Scope
In: `planRun` plans the criteria in batches, one model turn a batch, and
merges the batches' plans into one. A batch that is cut off, errors or is
refused marks only its own criteria unplannable. The size is read from
`QARE_PLAN_BATCH_SIZE`, forwarded by the pipeline input `plan-batch-size`,
and documented. Usage is summed over every batch.

Out: running batches at the same time. The model this is designed for is one
self-hosted endpoint, and what several turns at once do to it is not known.
Ledger ingest, which is asked once by its own contract and stays one turn.

## Assumptions
- The default is 1. The evidence: five criteria in one turn overran 16384
  output tokens and fit in 48000, so one criterion costs that model at most
  9600 tokens and two can cost 19200. One a turn is inside the default budget
  of 16384; two may not be. Time is unchanged: one criterion takes two to
  three minutes, five took fifteen in one turn.
- The price of a small batch is input: each turn carries the diff again. A
  caller with a fast, input-billed model raises the size.
- The single correction round applies to each batch on its own.
- When no batch can be planned the step raises, as it did when the plan was
  one turn, so callers that treat a plan step failure as a failure still do.
- A runner that cannot read nare's outcome for one batch (`NareRunnerError`)
  costs that batch; when it is every batch, the runner's own error surfaces.
- Criteria that share an id are refused before any turn: batches are told
  apart by id, and the merged plan holds each exactly once.

## Tasks
- [x] 1. `planBatchSize` reads and validates the environment: core/test/plan-batches.test.ts
- [x] 2. Batches are planned a turn each and merged in the order asked: same file
- [x] 3. A cut-off, an error, an unreadable run and a refusal each cost one batch: same file
- [x] 4. Usage sums over every batch, lost ones included, and rides the error when all fail: same file
- [x] 5. `qare plan` reports each batch and keeps usage on the all-failed plan: cli/test/plan-batches-command.test.ts
- [x] 6. The pipeline input `plan-batch-size` reaches the plan container when set, with its docs row: cli/test/pipeline-caller.test.ts
- [x] 7. Release 2026.10.22 stamped
