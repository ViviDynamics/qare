# Pipeline defaults for real repositories: flake retries, quarantine, diff exclusion, blocked gating

Issue #380

## Scope
In:
- `flake-attempts` and `quarantine` (default `.qa`, the ledger directory `qare ledger status` reads) pipeline inputs, passed to `qare run` in execute and main_execute, on by default with one retry (`flake-attempts: '2'`).
- A default planner diff exclusion for lockfiles and common generated paths (`planner-diff-default-exclude`), on top of the caller's own `planner-diff-exclude`, with the excluded patterns and paths listed in the evidence comment.
- A `blocked-check` input: `neutral` (the default) or `failure`, which makes a blocked verdict's QARE verdict check run fail.
- `docs/pipeline.md`: each new default and how to turn it off.

Out:
- `--cache` and `--workers` in the pipeline: not in the acceptance criteria.
- The main lane gets no planner diff (it plans from the ledger) and posts no check run, so the diff exclusion and `blocked-check` are pull request lane settings.

## Assumptions
- A retry never turns a failure into a pass. `settleCheck` (packages/core/src/run.ts) folds a check that failed and then passed into `unstable`: its criterion reports unverified with a `quarantined (...)` reason, the comment explains the quarantine, and each attempt keeps its own evidence directory (`<index>-attempt2`). A check that fails every attempt is still a failure. So the evidence shows a retried pass as retried (quarantined, unverified), never as proven.
- The quarantine store a pull request run reads is the base revision's copy of the store, never the pull request's: a pull request cannot quarantine its own failing check. The run writes into a copy in the runner's temp directory, and the updated store is uploaded with the evidence (`evidence/quarantine.json`) for a person to commit. The main lane reads the default branch's own copy, which is reviewed.
- New flags reach `qare-action post-evidence` only. qare-action ignores flags it does not know, so an older image ignores them: for `blocked-check: failure`, publish checks the image knows the flag before posting, and stops by name otherwise (fail closed).
- No secret moves: the new inputs are plain strings, and publish reads the exclusion list from the `qa-inputs` artifact collect already uploads.

## Tasks
- [x] 1. core: `renderCheckRun` takes a blocked conclusion; test that blocked is neutral by default and failure on opt-in, and that no other verdict moves.
- [x] 2. action: `post-evidence --blocked-conclusion` and `--planner-diff-excluded`; tests for the check run, the rejected value, and the comment section.
- [x] 3. pipeline: inputs, collect default exclusion and its record, execute and main_execute flake and quarantine, publish flags; workflow tests.
- [x] 4. docs/pipeline.md: inputs table and a section on the defaults; doc test.
