---
name: merge-pr
description: Use when a pull request looks ready to merge, when mergeStateStatus shows BLOCKED or BEHIND with green checks, or when deciding whether a stacked child PR can merge ahead of its parent.
license: Elastic-2.0
compatibility: Requires gh, jq, git and a committed repo.env.example in the consumer repo. Scripts are bash 3.2 compatible.
metadata:
  version: "1.4.0"
  owner: Vivi Dynamics
  requires: ci-safety
---

# Merge PR

Merge on the first genuinely green state. Waiting buys nothing: CI does not get greener.
Rules: ci-safety §1 and §2.

**Where the scripts are.** `S` is this skill's `scripts/` directory, next to this
SKILL.md. Set it once per session, for example `S=.agents/skills/merge-pr/scripts`
(or `.claude/skills/merge-pr/scripts` where that is the installed copy), then run every
script as `$S/<script>`.

## Inputs

- PR number. If not given: `$S/vgh pr view --json number --jq .number`.

## The freshness rule

A PR merges only when its green CI run tested the default branch as it is NOW. A
`pull_request` run tests the head merged into the base as it stood when the run was
created; green says nothing about a base that moved afterwards. A sweep that merges every
new default branch into every open PR keeps them fresh, but cancels their CI on every
merge (ViviDynamics/elm#3867). This check, at merge time, does the same job for one PR,
when it is ready.

`merge-verified` enforces it with exact SHAs, never timestamps. `VIVI_MERGE_FRESHNESS`
(repo.env.example) says how fresh is proven: `record` (default), `contains`, or `off`.

- **Fresh:** the head already contains the current default branch, or (`record`) the run
  recorded the merge it tested, in a CI step named `Record the tested merge <sha>`, and
  that merge's first parent, its base side, is the current head of the default branch
  (its second parent must be the PR head). A `pull_request` run of another workflow
  without the step counts only when the same event created it; one that started
  earlier may have tested an older base and makes the head stale. Merge.
- **Stale:** the tested base is an older default branch (`contains`: the head does not
  contain the default branch). Not merged. `merge-verified` calls `update-branch` once,
  pinned to the head it checked (`expected_head_sha`), and exits 5 with
  `state: updated` and the new `head_sha`. Watch CI on that head
  (`watch-ci --expect-head <head_sha>`), then run `merge-verified` again. With
  `--wait-min N` it watches that run itself and starts over when it is green, at most
  `VIVI_FRESH_ROUNDS` (default 3) times while the default branch keeps moving.
- **Unknown:** the tested base cannot be determined (no run recorded it, an unreadable
  commit, a merge that is not head-into-base). Refused with exit 4. Push or rebase onto
  the default branch to get a run that records it. Never merge around it.

## Preconditions (check all six, report any that fails)

1. Open: `$S/vgh pr view <pr> --json state --jq .state` is `OPEN`. If `MERGED`, run
   `$S/merge-verified <pr>` anyway; it is idempotent and prints the result.
2. Green for the current head: `$S/ci-runs <pr>` prints `state: green`, meaning every
   workflow run on the head concluded success or a documented skip, not only the main
   PR workflow. `pending` means wait (use the watch-ci skill). `failed` means stop; do
   not merge. `parked` means runs concluded `action_required` or executed zero jobs:
   CI never ran, so this is never green; release it per ci-safety §7.
   If `state` is `failed`, read `failed_jobs[].conclusion`. If `all_cancelled` is true
   it is a cancellation cascade (ci-safety §2), not a failure: wait for the run for the
   current head with the watch-ci skill instead of stopping.
   `none` means no CI ran for this head; stop and report unless the consumer's
   `repo.env.example` sets `VIVI_ALLOW_NO_CI=true` because the repo has no CI.
   `merge-verified` re-checks this itself and refuses anything but green.
3. Review gate satisfied, and it is the gate this repository asks for:

       $S/review-gate <pr>

   It reads the PR body's `### Code review gate` section and requires its
   `Gate: <tool>` line to equal the configured `VIVI_REVIEW_TOOL` (unset means `self`),
   so a repo that configures `independent` is never merged on a self-review.
   `Gate: unsatisfied` never passes; an `APPROVED` review decision from a person does.
   Exit 1: stop and report `preconditions_failed: review gate <reason>`; never merge
   silently past a missing or mismatched gate, and never edit the record to pass it.
   Exit 2: `VIVI_REVIEW_TOOL` is not a known gate (a configuration error): stop and
   report it. Exit 3: transient, run it again.
   A PR opened before this check may have a gate section with no `Gate:` line: add the
   line naming the gate that actually ran. If that is not the configured gate, run the
   configured one first and record it.
4. No quality gate weakened: `$S/quality-guard --pr <pr>` exits 0 (`clean`, or
   `justified` by a `### Quality gate changes` section in the PR body naming each
   file). Exit 1 means a lint, type, test, coverage or CI config changed, or a
   suppression marker was added, without a justification: stop and report
   `preconditions_failed: quality gate weakened` with the `hits`. Never add the
   justification yourself to get past this; it must come from the issue's scope.
5. Nothing private disclosed: `$S/disclosure-guard --pr <pr>` exits 0 (`clean`,
   `not_public`, or `justified` by a `### Disclosure review` section). Exit 1 means the
   PR would publish a private address, cluster name, home directory or private term:
   stop and report `preconditions_failed: disclosure blocked` with the `hits` (file,
   line and kind only). `private_terms: false` on a public repository is also a stop:
   `preconditions_failed: disclosure terms unavailable`.
6. Design gate, when the repository sets `VIVI_UI_PATHS`: `$S/design-gate pr <pr>`
   exits 0. A PR that touches UI paths needs a `### Design review gate` section with
   `Design gate: independent`, `Verdict: PASS` and a `UI fingerprint:` equal to the
   PR's current UI (a UI change after the review makes it `stale`). A PR outside UI
   paths needs none (`not_ui`). A PR, or an issue it closes, labelled
   `needs-owner-design-review` also needs the owner's (`VIVI_DESIGN_OWNER`) PR comment
   `Design approved: <the PR's UI fingerprint>` (`owner_hold` until then). Exit 1: stop and
   report `preconditions_failed: design gate <state>`; never edit the record to pass it,
   never apply or remove the hold label, and never post the approval phrase.
   `merge-verified` checks this itself, in both modes, and refuses with exit 4;
   `merge-verified --status` reports it as `verdict: design_gate_<state>`.

## BLOCKED and BEHIND are not red

`mergeStateStatus: BLOCKED` with green checks means a ruleset the author cannot satisfy
alone (for example, last-push approval on a solo PR). The consumer's `VIVI_MERGE_FLAGS`
already carry whatever bypass that repo needs. Judge CI by `ci-runs`, never by
`mergeStateStatus`.

`mergeStateStatus: BEHIND` with green checks and `mergeable: MERGEABLE` is not red
either: run `merge-verified`. Behind is not stale. If the green run tested the current
default branch it merges now; if the base moved after the run started it updates the
branch and you merge after that run (see "The freshness rule"). Do not rebase by hand
first. Check the actual `mergeable` field:

    $S/vgh pr view <pr> --json mergeable --jq .mergeable

- `MERGEABLE`: run `merge-verified` (it merges, or updates a stale branch first).
- `CONFLICTING`: rebase, push, and re-run CI instead.
- `UNKNOWN`: re-read (transient API state).

## Stacked PRs

`$S/repo-config VIVI_DEFAULT_BRANCH` prints the consumer's default branch as a bare
string, so it drops straight into these commands.

    git fetch origin "$($S/repo-config VIVI_DEFAULT_BRANCH)"
    git fetch origin "pull/<pr>/head"
    git log --oneline "origin/$($S/repo-config VIVI_DEFAULT_BRANCH)..FETCH_HEAD"

This never changes your checkout. If the log shows this PR contains another open PR's
commits and this PR is green, merge this one now. The parent then needs
`git rebase --onto origin/$($S/repo-config VIVI_DEFAULT_BRANCH) <old-child-head>` or
becomes empty; report that, but never wait on the parent.

## One merge at a time: lease or queue

Several workers merging into one default branch race: each merge makes every other green
PR stale, and two workers updating their branches at once both lose a CI cycle.
`VIVI_MERGE_MODE` picks how `merge-verified` serializes merges.

- **`lease` (default).** A merge lease in the git common dir
  (`git rev-parse --git-common-dir`), shared by every worktree of the clone on this
  machine. Only the holder updates a branch or merges. `merge-verified` takes it after
  the CI gate, keeps it across exit 5 and while that PR's own new run is pending, and
  gives it up when the PR merges or is refused for anything else. A lease is broken when
  its PR is merged or closed, or when nobody touched it for `VIVI_LEASE_TIMEOUT_MIN`
  (default 90) minutes. Separate clones do not share it.
- **`queue`.** GitHub's merge queue, once the default branch's ruleset enables it and the
  PR workflow runs on `merge_group`. Before enqueueing, `merge-verified` requires every
  workflow run on the head to be green (path-filtered `pull_request` workflows that are
  not part of the queue included), and runs `review-gate`, `quality-guard --pr` and
  `disclosure-guard --pr` itself, since nothing checks the PR again once it is queued.
  Then it enqueues it (`enqueuePullRequest`, pinned to the verified head) and waits. The
  queue tests each PR on top of the default branch it will land on, so there is no
  freshness check, no `update-branch` and no lease, and the ruleset's merge method
  applies instead of `VIVI_MERGE_FLAGS`. A default branch with no merge queue is found
  out first (`mergeQueue(branch:)`), and refused at once with exit 4: queue mode never
  waits on a queue that does not exist.
- **`auto`.** Queue mode when the default branch has a merge queue, lease mode when it
  does not. It lets a repository switch on the queue in its ruleset without a config
  change, and switch it off again.

**When the queue is switched on, every open PR needs one fresh run.** Runs from before
the queue (or before the workflow's `merge_group` support) lack the check the queue
requires, so GitHub refuses to enqueue them; `merge-verified` says so (exit 4, "push
once"). Push once, or update the branch, and enqueue after that run is green. In lease
mode the same holds after a workflow starts recording what the queue or the freshness
check needs: the first run with it is the one that counts.

Rules in lease mode:

- **Never update a branch whose green run is still fresh.** Read
  `$S/merge-verified <pr> --status`: its `freshness` field says `fresh`, `stale` or
  `unknown` for a green head (`not_checked` while CI is not green). Exit 0 means green
  and fresh, so mergeable now; exit 1 covers everything else, including pending CI.
  `--status` changes nothing.
- **Never update a branch from the default branch, and never merge, without the lease.**
  Do neither by hand: no `gh pr merge`, no `update-branch`, no merging the default branch
  in to "refresh" it. `merge-verified` does both, under the lease, and re-checks right
  before each that it still holds it. Rebasing to resolve a real conflict is a code
  change (rebase-main), not an update, and needs no lease.
- **Exit 6 means wait, not work.** Another PR holds the lease: leave your branch alone
  and run `merge-verified` again later, or pass `--wait-min N` to wait for it.
- **Give a lease back when you stop.** A worker that abandons a PR it holds the lease
  for runs `$S/merge-verified <pr> --release`. Never delete another PR's lease; it
  breaks itself when that PR merges, closes or times out.

Rules in queue mode:

- Enqueue only through `merge-verified`, which checks CI and the gates first and pins
  the entry to that head. Never `gh pr merge --auto` around it.
- A ruleset that still requires an approving review of the latest push can never be
  met by a solo author: GitHub refuses the enqueue and `merge-verified` says so
  (exit 4). The ruleset has to change; until then use `lease` (or `auto`, which uses
  the lease while there is no queue).
- Never update or rebase a queued PR to "help": the queue builds the merge itself, and a
  push removes the PR from the queue.
- A dequeue is a CI result like any other (see "Merge", exit 1).

## Merge

    $S/merge-verified <pr> [--wait-min N]

`--wait-min N` (default `VIVI_FRESH_WAIT_MIN`, else 0) lets one call wait for the lease,
for CI on an updated head, or for the merge queue. Each wait can take up to N minutes,
which is longer than many harnesses allow one foreground command: run it in the
background, or loop on exit 5 and 6 with short calls (see ci-safety §6).

- exit 0: merged. The JSON has `merge_commit`.
- exit 1: not merged. `state: blocked`: the JSON `reason` carries the merge command's
  output. Report it verbatim. Do not retry with different flags; flags are the
  consumer's decision. `state: dequeued` (queue mode): the merge queue removed the PR.
  `dequeue_reason` says why and `merge_group_run.failed_jobs` lists the merge group's
  red jobs. Classify them per ci-safety §3 (read each log with
  `$S/vgh run view --job <job_id> --log-failed`): infra or a first-time known flake is
  one verified retry, done by running `merge-verified` again to re-enqueue; a real
  failure is fixed on the branch like any other. A conflict means rebase-main.
- exit 4: preconditions failed. The JSON `reason` says why (for example the PR is
  CLOSED, CI on the head is `parked`, `pending`, `failing`, `failed` or `none`, with the
  run ids, the base the green run tested cannot be determined, or `design_gate` is
  `missing`, `stale`, `failed`, `wrong_gate` or `owner_hold`). For `owner_hold`, the PR
  waits for the owner; report it and stop. Report it; do not
  merge. `merge-verified` pins the merge to the head it checked with
  `--match-head-commit`, so a push after the check makes the merge fail rather than
  merge untested code.
- exit 5: not merged yet, nothing wrong. `state: updated` (lease mode): the base moved
  after the green run started, so the branch was updated with the default branch
  instead of merged, and this PR keeps the lease. `head_sha` is the new head. Watch its
  CI with `watch-ci --expect-head <head_sha>`, then run `merge-verified` again.
  `state: queued` (queue mode): still in the merge queue; run it again to keep waiting.
  This is the normal path when the default branch is busy, not a failure.
- exit 6: `state: waiting` (lease mode). Another PR holds the lease (`lease.holder_pr`).

## After the merge: clean up

A merged PR leaves nothing behind. From the main checkout (the first entry of
`git worktree list`), never from inside the PR's worktree:

    $S/cleanup <issue>      # a ship-issue run: its checkpoint names everything it started
    $S/cleanup --pr <pr>    # any other PR: finds the worktree by the PR's branch

It removes the worktree, the local branch, the remote branch (only while it still points
at the head that merged; `--delete-branch` sometimes removes only one side), recorded
helper worktrees, the test stack and scratch dir, and published UI evidence, then
fast-forwards the local default branch. It checks first and changes nothing when the
worktree holds uncommitted or untracked work, or the branch has commits the PR does not
(exit 1, `state: refused`, with `reasons`). When the next piece of work needs something
from the old worktree, create the new worktree first and pass
`--carry-to <new worktree>`: ship-issue's "Cleanup" section has the detail. Exit 1 with
`state: partial` lists what is still there in `left_behind`; report it.

## Report

Print the `MERGE_RESULT` JSON and validate it: `$S/validate merge_result <file>`.
Say `merged` only when the block says `merged`. A merge command's own success line is
not evidence; the read-back is.

## Red flags

- "BLOCKED, so CI must be failing": run `ci-runs`.
- "BEHIND, so I'll wait for the run to be fresh": run `merge-verified`; it decides from the SHA the run tested.
- "Green, so it is safe to merge with `gh pr merge` directly": green for which base? Only `merge-verified` checks that the run tested the current default branch.
- "Exit 5 means the merge failed": it means the branch was updated (or is queued); watch the new head and merge after it.
- "Someone holds the lease, so I'll update my branch meanwhile": that update is stale by the time the holder merges, and it costs a CI run. Leave the branch alone.
- "The lease looks stuck, I'll delete it": it breaks itself when its PR merges, closes or times out. `--status` shows who holds it and when it expires.
- "I'll wait for the parent PR first": if this PR is green and contains the parent's
  commits, that wait is pure loss.
- "The merge command printed success": the block says `merged` or it did not merge.
- "Merged, so I'm done": not until `cleanup` says `cleaned`, or its `left_behind` is
  reported.
- "The design gate is only a small CSS fix, so it does not need screenshots": a UI path
  changed, so the page changed. Take them.
- "The owner is me, so I can post the approval": the phrase is the owner's alone.
