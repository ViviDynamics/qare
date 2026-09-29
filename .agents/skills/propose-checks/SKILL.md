---
name: propose-checks
description: Propose the proof type and the check reference for each criterion, without writing the checks themselves, which stays with the plan step.
user-invocable: true
allowed-tools: Bash(git *), Bash(gh *), Bash(node *)
effort: low
---

# Propose Checks

For each criterion, say how it could be proved and where the proof would live.
This skill stops at the reference: generating the checks themselves is the plan
step's job, and a check written by the wrong step is a check nobody planned.

## What a proposal contains

- **Proof type.** `command` when an exit-code command can prove the behavior;
  `flow` when proving it takes a browser through named elements on a page. Pick
  the cheapest proof that would actually catch the behavior failing, and say
  why in one sentence.
- **Check reference.** A repo path, with a fragment where the file is long
  (`docs/SPEC.md#where-the-ledger-lives`, `packages/core/src/ledger.ts`), or
  `suite:<name>` for a named suite in the target profile's `suites`
  (`.qa/config.yml`). The reference names where the proof lives or exactly
  where it will be added; a reference that names nothing is refused.
- The criterion's own text must support the proof: a `command` criterion names
  the command it runs, a `flow` criterion names the page and the elements. If
  the text cannot support the proof, say so and propose the reworded text
  rather than the check.

## Steps

1. Collect the criteria, from a ledger (`node packages/cli/dist/index.js ledger
   list --ledger <dir>`) or from a draft JSON. Check the profile's suites in
   `.qa/config.yml` before referencing one; never invent a suite name.
2. For each criterion, propose: proof type, check reference, and the one
   sentence of why. If the criterion text cannot carry the proof, flag it for
   `/review-criteria` instead of proposing a check against vague wording.
3. Output the proposals as a table or list the requester can diff against the
   criteria, and stop before any check is written. If the criteria are drafts
   being assembled, fold the accepted proposals into the entries and revalidate
   with `/draft-criteria`'s validate script, so the loader sees the final form.
