# ADR-0009: what a run on the default branch proved is recorded beside the ledger, not in it

Date: 2026-10-09
Status: provisional, pending the owner's confirmation. Written by the agent
that shipped issue #295, unattended, on the instruction to design it under
CONSTITUTION.md. The code does what this says; the owner has not yet said
that this is where a pass should live.

## Context

Findings on main (#154) blame "the changes since the criterion last passed".
The code read that from one place, the ledger's `verify` history, and
nothing a repository can run writes a `verify` change: no command calls
`applyLedgerProposal`, the pull request lane touches no ledger, and the main
lane (#294) reads the ledger and never writes it. So every failure on main
was a `qa-failure` for the fallback, and the regression, the range and the
blame of #154 could not happen (#295).

A pass has to be recorded somewhere. What constrains where:

- **Rule 5.** Criteria change only through review. The ledger carries an
  integrity digest and a hash-chained history so that an unreviewed change
  is detectable.
- **Rule 7.** The job that executes repository code holds no secret, so it
  cannot be the writer.
- **Rule 3.** No model output may raise a verdict, so no model output may
  add a pass.
- **The consumer's default branch.** A push to it by a workflow starts the
  consumer's builds and releases, needs a bypass of branch protection, and
  is a write qare would be making to something it does not own.

## Options

| Option | What it gives | What it costs |
| --- | --- | --- |
| 1. A `verify` change in the ledger, pushed to the default branch by the lane | The ledger stays the one record. | A workflow that pushes to the default branch every night: the consumer's main build and release run on each one, branch protection has to be bypassed, and the ledger changes with no review, which is what its digest and chain exist to make visible. |
| 2. A `verify` change in the ledger, proposed as a pull request each run | Rule 5 to the letter. | A pull request a night that a person must merge before the next failure can be a regression. Unmerged, the record is stale and blame points at the wrong range. In practice it is merged without reading or not at all. |
| 3. A record beside the ledger, on the orphan `qa-assets` branch | No write to the default branch, no review queue, no new permission in the caller's ceiling. The ledger stays review-only. The branch already holds what runs produce (screenshots, metrics) and is already written by the judge side. | Two places to look for "when did this last pass". The record is as trustworthy as the branch: whoever can push to `qa-assets` can write a pass. |

## Decision (provisional)

Option 3. **That a criterion passed on a revision is a fact about a run, not
a change to a criterion. It is recorded beside the ledger, in
`passes/main.json` on the `qa-assets` branch, by the judge side of the main
lane, and never in the ledger.**

- **Who writes.** The filing step of `main_judge`, after everything is
  filed. It holds the GitHub identity and runs nothing from the repository.
  `main_execute` holds no token and cannot. The pull request lane never
  writes a pass, and the main lane does not run on a pull request, so pull
  request code reaches the record only after it has merged through review.
- **What decides a pass.** Code: the criteria the judged result carries as
  `proven` that the ledger carries as `active`. The verifier can only take a
  pass away. Nothing a model writes is read.
- **What a pass is of.** One wording. Each pass carries a digest of the
  ledger entry it proved (id, text, proof, checks). If a review changes any
  of those, the pass no longer stands until a run proves the entry again.
  So the record can never stretch a pass over a criterion that was reworded,
  and it cannot weaken, supersede or retire anything: the ledger is still
  the only place a criterion is stated.
- **What is kept.** For each criterion its last pass: the revision, when it
  was committed, the run, when it was recorded. A criterion that fails keeps
  the pass it had; that revision is where the changes are counted from, in
  the history (the commits the checked revision has that the passing one
  does not), not by date. Runs do not always finish in the order their
  revisions landed, and a late run reads its own revision's older ledger, so
  order is asked of the history on both sides: when it writes, a run leaves
  every recorded pass of a revision ahead of its own exactly as it is, and
  when a failure is classified, a pass counts as the last pass only if its
  revision is behind the checked one. A pass of a revision the branch no
  longer has is neither: it is no last pass, and the next run that proves
  the criterion replaces it. A pass of a criterion the ledger no longer
  carries is dropped by the next run that is not behind it. A repository
  with several profiles keeps one record for each profile, so one profile's
  run never drops another's passes. Each write is one commit carrying the whole record,
  so the branch's history is the record's history, and the record is read
  again where it is written: when another run's push lands first, this
  run's passes are applied to what that run wrote, never over it.
- **Off by default.** The caller passes `main-lane-record-passes: 'true'`.
  Anything else records nothing. A dry run records nothing and says what it
  would record.
- **Fail closed.** A record that cannot be read stops the filing step by
  name before anything is filed, and is not written over. A revision GitHub
  cannot date gets no pass.
- **Permissions.** `main_judge` declares `contents: write`, for the push to
  `qa-assets`. The documented caller already grants it for the pull request
  lane's judge, so the ceiling does not change.

## What this accepts, and what it does not

- **Accepted:** the record is not in the ledger, so it has no integrity
  digest of the ledger's kind and no hash chain. Its protection is the
  strict loader, the entry digest on each pass, the branch's own history,
  and whatever protection the consumer puts on the branch.
- **Accepted:** someone who can push to `qa-assets` can forge a pass. What a
  forged pass can do is bounded: a later failure reads as a regression and
  names the authors of the changes since. It cannot make a criterion pass,
  close an issue, or change a criterion.
- **Accepted:** the passes are recorded after the issues are filed, so an
  issue never names a pass its own run wrote. If the push then fails (an
  identity with no write access to contents), the issues stand and the step
  is red: the pass is missing, never wrong.
- **Not accepted, and still closed:** a write to the default branch, a
  ledger change without review, a pass decided by a model, and a pass
  written by the job that runs repository code.

## Consequences

- A repository gets regressions by turning one input on. Until a run has
  recorded a pass for a criterion, its failure is still a `qa-failure`.
- docs/SPEC.md's "Verify" step of the ledger lifecycle ("every run records
  its verdict against the criteria it covered") is not what the pipeline
  does: no pipeline job writes a `verify` change. `classifyMainRun` still
  reads `verify` history where a ledger carries it, and takes the later of
  the two.
- The fleet report and the sweep read the ledger's own history for "last
  verified" and do not read this record yet.

## Reversing this

To take option 1 or 2 instead: write the pass as a `verify` change through
`applyLedgerProposal`, deliver it the way `ingest-deliver` delivers a
proposal (or push it), drop `--record-passes` and
`packages/core/src/main-passes.ts`, and replace this ADR. `classifyMainRun`
already reads `verify` history, so the issue side needs no change.

## References

- Issues #295 (the gap), #294 (the main lane), #154 (findings on main).
- [docs/SPEC.md](../SPEC.md), "Findings on main"; [docs/pipeline.md](../pipeline.md), "Regressions".
- CONSTITUTION.md, rules 3, 5, 6 and 7.
