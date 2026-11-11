# The standing report reads the record of passes on main

Issue #361

## Scope

In: `classifySweep` takes the record of passes and counts a standing pass as a verification; `sweepLedger` reads `passes/main.json` beside the ledger, and an unreadable record is a finding; the scheduled sweep job places the record from `qa-assets` beside the ledger before it classifies; SPEC and ADR-0009 say so.

Out: the fleet report, which also reads only the ledger's history (named in ADR-0009, left for its own issue).

## Assumptions

- A pass counts while `standingMainPasses` says it stands: the same id, text, proof and checks as the entry has now. So, unlike a ledger `verify`, a pass needs no "edited since" check.
- `recordedAt` is the time of the verification, held against the area's threshold.
- With a ledger `verify` and a pass, the later counts; a time that does not parse counts as none.
- A `proposed` entry stays unverified whatever is recorded.

## Tasks

- [x] 1. classifySweep counts a standing pass: proven within the threshold, stale past it, no pass when the wording or checks changed, proposed stays unverified, the later of a verify and a pass counts.
- [x] 2. sweepLedger reads the record beside the ledger; an unreadable one is the finding `sweep:passes-unreadable`.
- [x] 3. sweep.yml places the record before it classifies, and says why when there is none (tested by running the step against a scratch repository).
