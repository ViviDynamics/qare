# Fleet report: every repository qare runs in, in one place

Issue #151

## Scope

In (a first slice, which leaves the issue open):
- `packages/core/src/fleet.ts`, pure: the strict config (repositories listed
  explicitly), a repository's state, what needs attention, the page, and the
  summary with the key of the attention set it was written for.
- `packages/action/src/fleet-report.ts` and `qare-action fleet-report`: read
  each listed repository through GitHub's API (ledger, run records on
  `qa-assets`, open issues with qare's labels) and publish in the repository
  it runs in (the page committed to a branch, one summary issue rewritten
  only when the attention set changes). `--dry-run` publishes nothing.
- `GitHubClient.listTreePaths`, and the fake's routes for it and for a
  search by label.
- The guide (docs/pipeline.md), with the workflow a team adds, and SPEC.

Out, each named on the issue as what remains:
- A workflow in this repository that runs it. It publishes an issue, and
  reads repositories only the owner can grant an identity for. The guide
  shows the workflow; the owner adds it where the team looks.
- Discovering repositories by where the App is installed. The App does not
  exist yet (#155).
- Why a run was blocked or refused. A run's record on `qa-assets` carries
  its verdict and counts, not its reasons; reading reasons means reading
  check runs or comments, which is its own piece.
- Advisory findings awaiting a look (#150).
- Showing it against real repositories. This run was told to touch no other
  repository, so everything is shown against the fake of GitHub's API.

## Assumptions

- A report that goes quiet when it cannot see is worse than none: every part
  of a repository is read on its own, and one that cannot be read is said to
  be unread, with the reason, and counts as needing attention.
- The report writes nothing to the repositories it reads. Text quoted from
  them, issue numbers included, is written as code: bare, `#7` would link to
  the wrong repository's issue, and `owner/name#7` would leave a reference
  on theirs.
- Stale is what the repository's own `sweep.json` says, or the built-in
  default: the same classification the sweep (#49) makes.
- Only a repository's latest run counts towards attention. An older failed
  run is history.
- Found in review, and now how it works: a repository the identity cannot
  see is asked for first, since GitHub's 404 for it is the 404 of a missing
  file; any unreadable record among the newest hides the latest run; a run
  is held to the metrics record's whole shape; quarantined and refused are
  not reported, since the last held result is not read; and the summary
  issue is found by its label in the issue listing, not by the search.
- The summary's key is the repositories, kinds and subjects of the attention
  set, not its wording or the time, so a daily run that finds the same
  things edits nothing and notifies nobody.
- The page is committed to `qa-assets` (ADR-0002's branch for what qare
  publishes), not to the default branch, so a schedule makes no commits
  there.

## Tasks

- [x] 1. Config, state, attention, page and summary:
  `packages/core/test/fleet.test.ts`.
- [x] 2. Reading repositories and publishing, against fakes of GitHub's API:
  `packages/action/test/fleet-report.test.ts`.
- [x] 3. The guide and SPEC.
