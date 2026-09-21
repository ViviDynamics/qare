# ADR-0004: Ledger authority — the ledger decides what the criteria are; conflicts hold only the affected criteria

Date: 2026-09-20
Status: accepted

## Context

Issue #57 asked three questions before the ledger is built:

1. Does the ledger live in the repo or in a QARE-side store?
2. Can QARE open pull requests that change criteria, or only comment proposals?
3. When a conflict cannot be settled by evidence, does the run hold only the
   affected criteria or block entirely?

The spec already answers all three — storage under "Where the ledger lives"
and "Decisions made", proposals-as-pull-requests under "Lifecycle", conflict
handling under "Lifecycle" and "Decisions made". What was missing is one
decision record that states what the ledger is authoritative over and what it
is not, so the ledger work (M6) is built against a single statement.

## Decision

**What the ledger is authoritative over.** The ledger is the authority on a
repo's acceptance criteria: which criteria exist, their text, their status
(`proposed`, `active`, `superseded`, `retired`), their provenance (who wrote
them, when, against which issue or pull request), and their verification
history (when last proven, and by which run and sha). If a statement about how
the product behaves is not in the ledger, it is not a criterion; if the ledger
says a criterion was superseded, it is superseded.

**What it is not authoritative over.** Verdicts. A verdict is computed by
qare's code from executed results (CONSTITUTION rule 3); the ledger records
what was verified, when, and by what run. It never turns a result into a pass,
and no ledger entry can raise one.

**How criteria change.** Criteria change only through review: QARE opens
criteria changes as pull request proposals, never as silent edits
(CONSTITUTION rule 5), and every run's evidence names any ledger change that
landed with it. Editing the requirement stays the path that is closed.

**Where it lives.** Storage is a backend detail, not an authority question.
Both backends hold identical entries, are read by the same commands, and move
between each other via `qare ledger migrate` without losing history; `branch`
is the default and `qare ledger export` keeps the exit open. Nothing about
what a criterion means, or what a verdict means, depends on the backend.

**Conflict handling.** A change can put a new criterion at odds with an old
one, or make an old one fail on purpose, and QARE separates the two: an
intended replacement is proposed as `superseded` with the replacement linked;
an unintended failure is a regression. When evidence cannot settle whether a
conflict is intended, only the affected criteria are held as `unverified`,
with one question asked in one place and QARE's own recommendation attached.
The rest of the run reports normally, and an unanswered question never blocks
a whole pull request.

**The deliberate exception.** A job handed in bypasses the ledger entirely:
nothing is read from it and nothing is written to it, and job criterion ids
are namespaced so they can never be confused with ledger ids or inherit
another criterion's verification history (SPEC, "A job handed in").

## Consequences

- One unanswered conflict question blocks one criterion, not a run —
  consistency with "ask, rarely" is enforced by construction, because holding
  anything broader would contradict the outcome the lifecycle promises.
- Because the ledger is the sole authority on criteria, weakening a
  requirement cannot become the cheapest way to go green: every criteria edit
  travels through a reviewed proposal, and every run names the ledger changes
  that landed with it.
- A migration or backend switch changes where the entries sit, never what they
  say or how a verdict is computed.
- The ledger's authority is on criteria, not evidence: screenshots and traces
  keep their own long-term home (ADR-0002), and the ledger points at them via
  verification records.

## References

- [Issue #57](https://github.com/ViviDynamics/qare/issues/57).
- [docs/SPEC.md](../SPEC.md) — "The criteria ledger" (including "Where the ledger lives" and "A job handed in"), "Decisions made".
- [CONSTITUTION.md](../../CONSTITUTION.md) — rules 3 and 5.
- [ADR-0002](adr-0002-screenshot-storage.md) — evidence storage, which the ledger's verification records point at.
