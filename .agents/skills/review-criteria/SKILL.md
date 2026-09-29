---
name: review-criteria
description: Review existing criteria for vagueness, overlap and missing proof types, and report each finding with the rule it breaks and a proposed rewording.
user-invocable: true
allowed-tools: Bash(git *), Bash(gh *), Bash(node *)
effort: medium
---

# Review Criteria

Read criteria the way a run has to: as statements a proof can settle or not.
Findings name the rule broken, the reason it matters, and a proposed rewording.
A review that only says "looks good" is not a review.

## What to review against

- **Vagueness.** A criterion that names no observable behavior. Tells:
  quality adverbs (properly, correctly, appropriately, robustly, seamlessly),
  verbs with nothing a run could see (works, handles, supports, behaves),
  references with no referent (it, the page, the system, the user), and a
  conjunction joining two behaviors into one. Flag these explicitly: a vague
  criterion rides through a run unproven, and the run reports green for it.
- **Overlap.** Two criteria that a single behavior would prove. Propose the
  weaker superseded by the stronger, not two proofs of the same sentence.
- **Missing or impossible proof.** A criterion with no proof type at all; a
  `flow` criterion that never names a page or element a browser could drive; a
  `command` criterion that names no command to run. A criterion the plan step
  cannot turn into a check is a criterion nothing will ever verify.

## Steps

1. Collect the criteria. From a ledger: `node packages/cli/dist/index.js ledger
   list --ledger <dir>` (or `show` for the full entries). From a criteria file
   or an issue section: read it directly. Say which surface you reviewed.
2. Check every criterion against each rule above, in order. For each finding
   write: the criterion, the rule, the reason in one sentence, and a proposed
   rewording that a run could prove.
3. Verdict per criterion: `holds`, `flagged` (with the rule) or `supersede`
   (with the pairing). End with the counts, and never soften a flag: a vague
   criterion left standing is the failure the review exists to prevent.
4. A rewording is still a criterion in the house style: it names the observable
   behavior, the source stays, and the status stays `proposed` until a run
   proves it. Hand the rewordings back as proposals, not as edits.
