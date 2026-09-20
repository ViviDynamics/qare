# ADR-0001: Plan approval — review with the pull request, plan locked before implementation

Date: 2026-09-20
Status: accepted

## Context

An open question from the spec draft (issue #33, "Open questions" 1): does a
human approve `plan.json` before implementation starts, or only review it with
the pull request? Earlier approval catches wrong plans sooner; review-with-PR
is faster.

The rest of the design already answers half of it:

- The pipeline is three unattended jobs — plan, execute, judge — triggered by
  CI completing green, a `/qa` comment, or a label (SPEC, "Pipeline",
  "Triggers"). A human gate between plan and execute would put a click in
  every run and break the trigger model.
- The tamper defense is already specified and does not involve approval:
  principle 3 ("checks are locked before the code") and milestone M3 fix the
  plan as "plan commit first, guard on edits to locked checks". Approval and
  the lock are different answers to different threats; the threat a plan
  approval would address — a plan too wrong to be worth executing — is a
  quality concern, not a tampering concern.
- Humans already hold the two approvals that matter: criteria change only
  through reviewed proposals (CONSTITUTION rule 5), and the verdict feeds a
  human sign-off before merge (principle 6, "QARE never merges").
- In the "job handed in" mode there is no human in the loop at all; the
  caller supplies the criteria and gets `result.json` back.

## Decision

Review-only with the pull request. There is no separate human approval step
between planning and implementation.

The plan is still locked before implementation — committed before the run's
checks execute, with a guard on edits to locked checks (M3) — so a reviewer
sees the plan exactly as it was when the run started, and the run cannot edit
its way to green. A wrong plan surfaces at pull request review as `unverified`
criteria and verifier notes; it never reads as a pass.

## Consequences

- Runs stay unattended end to end; no approval UI, no new trigger state.
- A wrong plan costs one run cycle, not a merged regression. The judge's
  verifier names criteria the evidence does not actually show, so
  under-coverage is caught at review rather than silently absorbed.
- A team that wants earlier signal can review the plan commit itself:
  `plan.json` is an artifact (SPEC, "Output") and lands before
  implementation, so the plan is reviewable at any point without a gate.
- The plan lock carries the entire tamper defense. Plan approval is not part
  of it and cannot be cited as one.

## References

- [Issue #33](https://github.com/ViviDynamics/qare/issues/33) — decision 1 of 3.
- [docs/SPEC.md](../SPEC.md) — "Open questions" 1, "Principles" 3 and 6, "Pipeline", "Triggers", milestone M3.
- [CONSTITUTION.md](../../CONSTITUTION.md) — rules 3, 5, 6.
