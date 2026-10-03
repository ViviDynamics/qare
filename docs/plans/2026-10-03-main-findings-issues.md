# Findings on main become GitHub issues: one per problem, updated, closed on recovery

Issue #154

## The gap

A run against `main` has no pull request to comment on. Today a failure there
lands nowhere a person reads. The stub-issue flow (#31) already files one
issue per problem, found again by a hidden marker; this applies the same
pattern to the criteria a run on `main` failed.

## Scope

In:
- `packages/core/src/main-findings.ts`, pure code, no network:
  - the classification of a judged result into findings, recoveries and
    nothing: a failed criterion is a finding, a proven one is a recovery, a
    run in which nothing booted is one environment finding for the whole run,
    and a quarantined (flaky) check files nothing;
  - the fingerprint: the criterion id plus a failure signature (the checks
    that produced evidence, and the outcome);
  - the kind, decided from the ledger and the executed comparison, never by a
    model: `qa-regression` when the ledger records a pass or the run's own
    base side proved it, `qa-failure` when nothing shows it ever passed,
    `qa-environment` when nothing booted;
  - blame: from the pull requests merged since the ledger's last pass, who to
    mention (the author, or for a bot's pull request the person who merged
    it, else one who approved it), which pull request the evidence points at
    most (the one that touched the most files the criterion's checks cover)
    and why, and the fallback with its reason when no change can be blamed;
  - the issue body, the update comment, the recovery comment and the reopen
    comment. Text from the run sits in code spans, so nothing in it renders
    or mentions; everything is redacted (#52); a file is linked only when it
    was uploaded (rule 4).
- The profile's `findings` section: `fallback` (a person or a team) and
  `bots` (logins to treat as bots, for an orchestrator that opens pull
  requests with a person's token).
- `packages/action/src/main-findings.ts` and the `qare-action main-findings`
  command: the judge-side step that holds the GitHub identity (#61). It reads
  the judged result, the ledger and the profile as data, asks GitHub for the
  commits and pull requests of the range, and files, updates, reopens and
  closes. `--dry-run` reads and writes nothing.
- The GitHub client calls it needs, and the fake's routes for them.
- SPEC, the pipeline guide, the orchestrator contract, the schemas.

Out:
- Wiring the command into qare's own workflows. The scheduled sweep (#49)
  classifies the ledger and runs no checks, so it has no judged result of a
  run on `main` to hand over, and a feature that opens issues and mentions
  people on a public repository is turned on by its owner, deliberately. The
  command ships; the guide shows the step a caller adds.
- A sweep that executes the ledger's checks against `main`. That is the run
  this command reads the result of, and it is its own piece of work.
- Chat notifications, and findings on a pull request (the issue's own
  exclusions).
- Fixing or merging anything: the `qa-regression` label is the hand-off.

## Assumptions

- The input is a judged result (`judged-result.json`), the same contract the
  pull request path posts from. Nothing about a run on `main` needs a second
  format.
- "Passed before" is the ledger's last `verify` record naming the criterion,
  or `regression: true` on the result (#147). A failed criterion with
  neither is not called a regression: it gets `qa-failure`, so the
  `qa-regression` hand-off label never names something that never worked.
- The ledger's verify record carries a run id and a timestamp, not a commit,
  so the blamed range is the commits on the checked revision since that
  timestamp.
- An issue is found by its marker and by its author, this identity, as the
  evidence comment is: anyone can write a marker.
- When qare closes an issue on recovery it retires the marker, so the same
  fingerprint failing again later opens a new issue with a new range and new
  mentions. An issue that still carries its marker and is closed was closed
  by a person, and is reopened.
- Mentions are written once, in the body of a new issue. Update, reopen and
  recovery comments name nobody.
- At most ten people are mentioned on one issue; the rest of the range is
  listed without a mention, and the issue says so.
- No fallback in the profile and nobody to blame: the issue mentions nobody
  and says how to name a fallback.
- An environment finding blames no change: it mentions the fallback.

## Tasks

- [x] 1. Profile `findings` section: a test that `fallback` and `bots` load
  and that an unknown field or a malformed login is refused by name.
- [x] 2. Classification and fingerprint: tests for failed, proven,
  quarantined, blocked, refused, and for a fingerprint that is stable across
  runs and moves with the failing checks.
- [x] 3. Blame: tests for one author, several authors with the one the
  evidence points at, a bot's pull request (merger, then approver), no
  record of a pass, an empty range, and the cap.
- [x] 4. Rendering: tests that the body carries the criterion's text, the
  outcome, the verdict, the range, the evidence with only uploaded links,
  redacted text, and mentions only where they belong.
- [x] 5. GitHub client and fake: labels and state on issues, commits since,
  pull requests of a commit, a pull request, its files and reviews.
- [x] 6. Filing: tests against the fake for each "Done when" item: open one,
  bot author, fallback, update without a duplicate or a new mention, close
  on recovery, reopen a hand-closed one, one environment issue.
- [x] 7. The `main-findings` command, with `--dry-run`.
- [x] 8. SPEC, pipeline guide, orchestrator contract, schemas.
