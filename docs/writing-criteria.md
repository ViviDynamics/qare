# Writing criteria QARE can check

Criteria decide everything downstream. A criterion the ledger cannot check
either fails for the wrong reason or passes for no reason, and both cost more
than writing it well the first time. This guide is the house style for
acceptance criteria: what goes into an entry, how ingest reads an issue into
proposals, and what a wording must have before a check can carry it. The
ledger itself is described in
[the criteria ledger](https://github.com/ViviDynamics/qare/blob/main/docs/SPEC.md#the-criteria-ledger)
section of the SPEC.

## The three rules

Every criterion states three things, and the ledger entry keeps all three:
one behavior, a stated proof type, and an observable outcome.

1. **One behavior per criterion.** A criterion asserts one thing about how the
   product behaves. Two assertions in one sentence split into two criteria,
   because a check that proves both halves by accident proves neither, and a
   change that breaks the second half would leave the first half's green
   verdict lying about the pair.
2. **A stated proof type.** The criterion says which kind of check can carry
   it: `command`, `flow` or `visual`. Ingest proposes the proof from the plan
   it asks for, and a criterion whose proof type was never stated is the first
   thing to go vague.
3. **An observable outcome.** The wording names what should hold as a result,
   in terms the run can see: a page state, a command's output, a rendered
   difference. "Works correctly" observes nothing; "the payouts page shows the
   1099 notice for a host paid past the annual threshold" does.

## Proof types

The planner tags every check with a kind, and a criterion's proof follows from
the checks that would carry it. Three kinds cover most criteria:

| Proof | What it captures | State it when the criterion is about |
| --- | --- | --- |
| `command` | The exit code and output of one fixed command | Anything a script can assert with no browser: a test suite, a linter, a build, a migration |
| `flow` | A fixed action set a client driver performs, driven through a real browser | What a user does and sees: forms, navigation, sign-in, the result of an interaction |
| `visual` | A page captured at named widths and themes, compared pixel for pixel with the same page at the base | How a page looks: layout, spacing, state differences a flow would step over. Any difference from the base fails it, so state it for a page the change should leave looking the same |

A criterion is `command` when every check that carries it is a command, and
`flow` otherwise. Three further kinds exist in the plan schema: `mail` (a
message waited for and read), `tool` (a host tool invoked directly) and
`a11y` (the pages a flow visits, audited against accessibility rules, where
only violations the base did not already have fail it). A criterion that
needs one of those says so in its wording, and this guide's three kinds stay
the ones criteria are written for. An `a11y` check needs no criterion of its
own: the planner may add one beside the checks of any criterion about a user
interface, and a profile can audit every flow.

## Weak criteria, rewritten

Each of these was stated, and each came back either uncheckable or wrong. The
rewrite is what ingest proposed.

| As stated | Why it is weak | Rewritten |
| --- | --- | --- |
| "The article is pleasant to read" | No observable outcome: no check can show pleasant | "Searching for Ada Lovelace shows her article with the infobox" (`flow`) |
| "Sign-in works and the dashboard loads fast" | Two behaviors in one criterion | "Sign-in with a valid password lands on the dashboard" (`flow`), and separately, a second criterion for the load behavior |
| "The code is good quality" | Asserts nothing a run can see | "The linter passes with no warnings on changed files" (`command`) |
| "The report looks right" | "Right" is not a rendering claim | "The report renders the totals row within the table at 1280px" (`visual`) |
| "The summary is exactly what the model recommends" | Only a model session could judge it, and the run executes no model | Restate around what the run produces: "the summary section lists every open finding" (`flow`) |

The pattern in every rewrite: the behavior is narrowed to one assertion, the
proof type follows from what asserts it, and the outcome is something the run
can point at.

## How ingest maps issue text to entries

`qare ingest` reads the sources a manifest names and proposes entries; it
never writes the ledger. What it does with an issue body:

- It reads the criteria under an "Acceptance criteria" or "Done when" heading,
  one candidate per checkbox item. An issue with no such heading states
  nothing to check, and contributes no proposal.
- The words are the criterion. The entry's note carries the item's wording
 unchanged, and the wording (normalized) is hashed into the proposed entry's
 id, so the same words are always the same criterion and a reworded rule is a
 new one.
- The planner is asked once, with no diff under review, to map each stated
 criterion to checks. What the plan can carry becomes a `proposed` entry
 whose proof names the check kind; what the planner cannot map comes back
 uncheckable, with the reason, and is proposed nowhere.
- A criterion the ledger already carries under the same wording (or under a
 hand-minted id with the same note) is reported as already carried and is not
 proposed again. Active, retired and superseded rules were decided by a
 human, and a second entry under the same words would not be.
- Proposals leave as a payload the delivery turns into a pull request for a
 human to apply. Nothing lands in the ledger until a person applies the
 proposal.

What ingest cannot infer, no matter how the words are arranged:

- **It cannot split.** Two behaviors in one item arrive as one criterion, and
 the planner has to cover both or the criterion comes back unplannable. Split
 them in the issue.
- **It cannot make a wording observable.** A criterion with no outcome a
 check can see is uncheckable, and ingest asks for a rewrite in one comment
 on the source that stated it, linking this guide.
- **It cannot judge model-only claims.** A criterion whose evidence only a
 model could produce is unplannable, because the executing job runs no model.
- **It cannot match reworded duplicates.** "The payouts page shows the 1099
  notice" and "a host paid past the threshold sees the 1099 notice on the
  payouts page" hash differently, so a rewrite proposes a second entry unless
  the resolution step links the two.
- **It never rewrites your words.** The note is the wording as stated, not a
 tidied version, so a sloppy item becomes a sloppy entry.

## Before you restate

A criterion that is about to be proposed is worth one pass against the three
rules: can a run see the outcome, is one behavior asserted, does the proof
type have a check kind that can carry it. The
[criteria ledger](https://github.com/ViviDynamics/qare/blob/main/docs/SPEC.md#the-criteria-ledger)
keeps the lifecycle: `proposed` entries become `active` when a run proves
them, and are superseded or retired through a reviewed change, never by a
silent edit.
