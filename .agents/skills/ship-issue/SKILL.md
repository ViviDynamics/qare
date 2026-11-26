---
name: ship-issue
description: Use when a GitHub issue should go all the way to a merged PR without a human in the loop, including when invoked by an unattended session or orchestrator.
license: Elastic-2.0
compatibility: Requires gh, jq, git and a committed repo.env.example (the conventions skill says how). Scripts are bash 3.2 compatible.
metadata:
  version: "2.2.0"
  owner: Vivi Dynamics
  requires: ci-safety watch-ci merge-pr rebase-main copilot-review
---

# Ship Issue

Issue number in, merged PR out.

Unattended chain: resume detection (idempotent) → claim the issue → plan (M+ scope) →
implement with TDD in a worktree → review gate on the local diff → design gate on the
rendered screens (UI changes only) → push, open the PR
with `Closes #N`, CI via watch-ci → merge via merge-pr → cleanup (worktrees, branches,
stack) → closure and project board → final SHIP_RESULT. This skill never waits for a human; a question you would ask becomes
a stop condition in the final summary.

Every repo-specific fact (repo, default branch, merge flags, test commands, review tool,
project) comes from the consumer's committed `repo.env.example` via the scripts; an
optional, gitignored `repo.env` adds only the per-person keys (`VIVI_ASSIGNEE`,
`VIVI_GH_TOKEN_FILE`). A fresh worktree needs no setup.

**Where the scripts are.** `S` is this skill's `scripts/` directory, next to this
SKILL.md. Set it once per session, for example `S=.agents/skills/ship-issue/scripts`
(or `.claude/skills/ship-issue/scripts` where that is the installed copy), then run every
script as `$S/<script>` and every one-off `gh` call as `$S/vgh`. Let
`R=$($S/repo-config VIVI_REPO)`.

## Inputs

- Issue number. Required.
- Optional: whether to skip the plan document (S-sized fixes may skip; M+ scope always
  writes a plan first).
- Optional: whether another issue follows in this session (an orchestrator shipping a
  queue). Then Stage 4 may leave this run's worktree for the next run to carry from and
  clean up (see "Cleanup").

## Budgets (global, fixed)

| Resource | Budget | On exhaustion |
| --- | --- | --- |
| Verified retries per CI job | 2 | classify and report in SHIP_RESULT |
| Rebases with real conflict resolution | 2 | keep going; report the churn in SHIP_RESULT |
| Review rounds | 2 | review only new changes; see "Review rounds" |
| Design review rounds | 2 | review only what the fixes changed; Critical and Important always fixed |
| Copilot review requests | 1 per PR | never re-request; verify fixes with the local reviewer |
| Watch wall-clock per CI cycle | 60 min | report timeout state |

**What counts as a rebase.** Only a rebase that needed real, non-mechanical conflict
resolution: you wrote code that combines both sides' intent. These never count:
a rebase with no conflicts; one whose conflicts were mechanical (one side taken
verbatim, both sides kept unchanged, as for two PRs each editing an adjacent line of a
list, or a generated file or lockfile regenerated); `update-branch`; a merge from the
default branch, including the one `merge-verified` makes. Record a counted rebase with
`$S/checkpoint write <issue> ci --rebase "<files and why>"`, which also increments the
`rebases` budget. **Never stop a green PR because of this budget.** Past it, keep going
and report the churn (`rebases` over `rebases_limit`, with the files) in SHIP_RESULT.

**Review rounds.** A round is one review of a head plus the one fix push (or local fix
commit) that answers it. Record each round once, after its fixes are committed:
`$S/checkpoint write <issue> review --review-findings "<findings>" --review-fixes "<fixes>" --reviewed-head <sha>`,
which increments `review_rounds`. In every round:

- **Always fixed, at any round count:** every Critical finding, and every Important
  finding that is a regression this PR caused.
- Within the budget: fix every Important finding too; Minor ones at your judgment.
- **Past the budget:** review only the changes made since the last reviewed head, not
  the whole PR again. Fix what the first rule requires.
- Any finding you do not fix goes in SHIP_RESULT `unresolved` and in the PR body under
  `### Code review gate`, with why. Never file a new issue for a review finding.

## Before every push: `$S/prepush <issue>`

Every push (the first one, review fixes, CI fixes, rebases) goes through one gate:

1. Commit. Then `$S/preflight <issue>`: it runs the `VIVI_TEST_COMMANDS_FILE` rows
   whose paths the diff touches, cheapest first, and records the result against
   `HEAD`. `--jobs N` runs up to N rows at once when the table's rows are independent.
   A failure is fixed locally with TDD and preflighted again; it never goes to CI to
   find out. Count each run in `preflight_runs`.
   If the repository's test commands describe a per-worker environment (in
   ViviDynamics/elm, `eval "$(bash scripts/ci/worker_env.sh <slot>)"`), set it up in
   the shell that runs `$S/preflight`; never edit the committed `.env.test`. Preflight
   passes every variable except the `VIVI_*` settings through to the rows, so the slot's
   `ELM_ENV_FILE` and `COMPOSE_PROJECT_NAME` reach them. Record the slot in the
   checkpoint (`$S/checkpoint context <issue> --set worker_slot=<slot> --set env_file=... --set compose_project=...`)
   so a resumed run re-runs the same setup and takes the same stack.
2. `$S/prepush <issue> --body-file <draft PR body>` (or `--pr <pr>` once the PR
   exists). It refuses (exit 1, with `reasons`) unless the preflight passed for this
   `HEAD`, the tree is clean, `disclosure-guard` passed and `quality-guard` passed, both
   on the local diff that the push would publish, and, when the diff touches UI paths
   (`VIVI_UI_PATHS`), a passed design review is recorded for this `HEAD`'s UI
   (`design-gate check`, Stage 2b).
3. Push only on exit 0. Never push around it.

On a refusal:

- **Preflight**: run it for this `HEAD`, or fix what failed.
- **Design gate**: `missing` or `stale` means new after screenshots of this head and a
  design review round (Stage 2b); `failed` means its Critical and Important findings are
  not fixed yet. A commit that touches no UI file keeps a passed review.
- **Disclosure guard** (public repositories): nothing private reaches a public
  repository, ever. A `private_term` hit is removed, never justified; a missing private
  term list is a stop (`unresolved: disclosure terms unavailable`). Detail, including
  what may be justified under `### Disclosure review`: `references/disclosure.md`.
- **Quality guard**: the fastest way to turn CI green is to weaken what CI checks, and
  that is never the fix. A hit you introduced to get past a failure: revert it and fix
  the code. A hit the issue genuinely asks for: name the file and the reason under
  `### Quality gate changes` in the PR body, which makes it `justified`. Anything else:
  stop with `unresolved: quality gate weakened`. Record the final state in
  `quality_guard`; merge-pr checks it again before merging.

When CI later fails for a real reason, ask whether a preflight row should have caught
it. If yes, count it in `ci_failures_preflight_would_catch` and name the missing row in
`unresolved`, so the test commands table improves from evidence.

## Lessons (when `VIVI_LESSONS=on`)

Each run records verified retries, real failures and costly repo facts, and proposes
them in a separate small PR after Stage 6. How: `references/lessons.md`. Copy the run's
observations into SHIP_RESULT `observations`.

## Checkpoints: resume, never redo

A run can outlive its context window, its session or its worktree. The checkpoint is its
memory. It lives in the git common dir (`git rev-parse --git-common-dir`), keyed by
issue, so any worktree of the clone, including a brand-new one, finds it.

- **Write one at the end of every stage** and after every push:
  `$S/checkpoint write <issue> <stage> [--pr N] [--plan PATH] [--decision "what and why"] [--unresolved "..."] [--set key=value]...`.
  Stages: `plan implement pr-open ci review merge closure done stopped`. Record a
  `--decision` for every call a later reader would otherwise have to re-derive (plan
  skipped because S-sized, a finding rejected and why, a retry and its evidence).
- **Record the working context with `--set`** as soon as you have it, so a cold resume
  can rebuild it: `worktree=<path>`, `env_file=<path>`, `compose_project=<name>`,
  `ports=<list>`, `scratch_dir=<path>`, `extra_worktrees=<path>,<path>` (every helper
  worktree you add: reviewers, the design gate's "before" checkout), and anything else a
  successor would need. An empty value removes a key. This is also the list `cleanup`
  takes down after the merge, so anything you start and do not record is left behind.
- **Every CI run is checkpointed when it starts**: watch with `ci-watch --issue <issue>`,
  which records `ci_head` and `ci_run_ids` in the context on its first poll of the run
  (`checkpoint context`, which changes nothing else in the checkpoint).
- **Review rounds and counted rebases** are recorded with `--review-findings` /
  `--review-fixes` and `--rebase` (see Budgets); those are the only places their
  counters go up.
- **Read it first** in Stage 0: `$S/checkpoint read <issue>`. Resume at the recorded
  stage; keep the plan, decisions, context and unresolved items. When `fresh` is false
  the branch moved since the checkpoint: re-run preflight and re-read CI before
  trusting the recorded results. When `worktree_exists` is false, add a worktree for
  the recorded branch and carry on there. Budgets always carry over; a restart never
  resets them.
- **After compaction**, read the checkpoint before doing anything else, even when the
  summary seems complete.
- Report `resumed_from: <stage>` in SHIP_RESULT when a run picked up a checkpoint.

## Cleanup: leave nothing behind

A merged run leaves no worktree, no branch (local or remote), no helper worktree, no
test stack, no scratch dir and no published screenshots. One script does it, from the
main checkout (the first entry of `git worktree list`) or the next run's worktree, never
from inside the worktree it removes:

    cd "$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
    $S/cleanup <issue>

It reads the checkpoint (PR, branch, worktree, context) and checks everything before it
removes anything. It refuses (exit 1, `state: refused`, nothing changed) while the PR is
open, when the branch has commits the merged PR does not hold, and when the worktree
has uncommitted changes or untracked files. Read `reasons` and decide: work that belongs
to the next issue is carried (below); work you judge worthless is dropped with
`--discard`; commits no PR holds go in a PR or are cherry-picked into the next branch,
never thrown away. Ignored files (node_modules, build output) go with the worktree.

Then it takes down, in order: the stack (`VIVI_TEARDOWN_CMD`, else the checkpoint's
`compose_project` with `docker compose down --volumes`), the `scratch_dir`, the detached
`extra_worktrees`, the run's worktree, the local branch, the remote branch (only when it
still points at the head that merged), `refs/vivi-evidence/<issue>` and the local
screenshots. Last it prunes stale worktree records and remote-tracking branches and
fast-forwards the local default branch. A stack or scratch dir that another active run
also records is kept. Exit 0 is `cleaned`; exit 1 with `state: partial` lists what is
still there in `left_behind`: copy it into SHIP_RESULT `unresolved`. `--dry-run` prints
the plan and changes nothing. The result is recorded under `cleanup` in the issue's
state.

**Shipping another issue next.** The next run may need things from this worktree that
git does not hold: the per-person `repo.env`, the worker's env file, the running stack,
uncommitted local work that belongs to the next issue. Carry them across before the old
worktree goes, never after:

1. Create the next run's worktree first (Stage 1 step 2 of that run).
2. From it (or the main checkout):
   `$S/cleanup <previous issue> --carry-to <new worktree> [--keep-stack] [--carry PATH]... [--carry-changes]`
   - Every `VIVI_WORKTREE_CARRY` path (default `repo.env`) and the checkpoint's
     `env_file`, when it lives in the old worktree, are copied. A file the new worktree
     already has is never overwritten (it is in `warnings`).
   - `--carry PATH` adds a path, relative to the worktree root.
   - `--carry-changes` moves the uncommitted diff (with `git apply`) and the untracked
     files. If the diff does not apply to the new worktree, nothing is removed.
   - `--keep-stack` leaves the stack up for a next run that takes the same worker slot;
     record it in the new run's checkpoint (`--set compose_project=... --set env_file=...`)
     so it is taken down after that run.
3. Check `carried` against what the next run needs before starting it.

Things that already outlive any worktree, so need no carrying: the checkpoint, budgets,
lessons observations and SHIP_RESULT (all in the git common dir), and everything
committed.

**Sweep on start.** Every run, after creating its worktree, runs `$S/cleanup pending`.
It lists runs that merged (stage `merge`, `closure` or `done`) but left a worktree, a
branch or a helper worktree behind: a crashed session, a deferred cleanup. Clean each
one with `--carry-to <this worktree>`, so a leftover is never older than the next run.

**Runs that stop.** A run that stops with `merge_state: open` or `blocked` keeps its
worktree and branch: the resume needs them. A `no-pr` stop with nothing worth keeping
(the issue was held by someone else, or its premise was contradicted) is cleaned with
`$S/cleanup <issue> --abandon`, which still refuses to drop commits or uncommitted
work. A run whose PR was closed unmerged is cleaned the same way; its remote branch is
kept. Report what you kept in SHIP_RESULT `cleanup`.

**Background processes.** `cleanup` cannot see a dev server, a `ui-evidence --serve`
stack or a background `ci-watch` you started. Stop each before cleanup, or name it in
`VIVI_TEARDOWN_CMD`'s repository script.

## Long waits

`ci-watch` (up to 60 minutes) and `merge-verified --wait-min N` can outlast a harness's
limit on one foreground command (often about 10 minutes). Run them in the background and
wait for the exit, or loop bounded calls (`ci-watch --timeout-min 9` until it stops
exiting 4; `merge-verified` without `--wait-min` until it stops exiting 5 or 6). Never
end the turn to wait. ci-safety §6 has the detail.

## Stage 0: Resume detection (idempotent)

Read the checkpoint first (above). Then detect what exists on GitHub; reads do not
change state.

```bash
$S/vgh issue view <issue> --repo "$R" \
  --json state,title,body
$S/vgh pr list --repo "$R" \
  --search "closes #<issue>" --state all \
  --json number,state,url,headRefName,baseRefName
```

Branch pattern from `VIVI_BRANCH_PATTERN`. Substitute `{issue}` and `{slug}` (derived
from issue title), and look for the branch with
`git ls-remote --heads origin '<pattern with {slug} as *>'`. Then:

- Merged PR exists: run Stage 5 (closure and board, idempotent), then Stage 6.
- Otherwise claim the issue first (below), then:
  - Issue is OPEN, open PR exists: verify its worktree is in sync, enter Stage 3 (CI).
    If the checkpoint shows no review round for the current head, run Stage 2 on it
    alongside the CI watch.
  - Branch exists, no PR yet: verify the worktree, then Stage 2 (review), then push and
    open the PR in Stage 3.
  - Nothing exists: Stage 1 (implement).

### Claim before any work

An unassigned issue looks free on the board, so it is claimed before the first file
write, not when the PR opens. Another agent may be minutes into the same issue.

    $S/claim <issue>

It assigns the issue to `VIVI_ASSIGNEE` (see the conventions skill), or to the token's own login
when that is unset, and reads the assignment back. It also adds every label in
`VIVI_CLAIM_LABELS` and, when `VIVI_PROJECT_OWNER` and `VIVI_PROJECT_NUMBER` are set,
the project board item, so the issue shows up where the team looks. A label or board
write that failed is in `warnings`; it does not fail the claim, but copy it into
`unresolved`.

- Exit 0, `claimed` or `already-mine`: continue. Record
  `--decision "claimed as <login>"` in the checkpoint.
- Exit 1, `held`: someone else is assigned, or has an open PR that closes the issue.
  `lost-race`: another claim landed first, and the script already removed yours.
  `closed` or `not-assigned`: nothing to claim, or the assignment did not stick.
  Stop with `merge_state: no-pr` (or `open` for a PR that is not yours) and
  `unresolved: claimed by <holders>: <evidence>`. Never unassign someone else, and
  never adopt their branch or PR.

Before any file write, verify location: `git branch --show-current` and
`git rev-parse --show-toplevel` must match the expected worktree path.

## Stage 1: Implement

Strict test-driven development. For M+ scope, write a plan first. The repo's house
rules (`VIVI_HOUSE_RULES_FILE`, for example AGENTS.md or CLAUDE.md) bind at every
stage; read them before writing anything.

1. Read the issue, any referenced docs, and the lessons file when lessons are on. Read
   the "Already delivered / Remaining scope" block if it exists; implement only the
   remaining scope.

2. Worktree: `git worktree add` from a fresh `VIVI_DEFAULT_BRANCH`, on a branch
   matching `VIVI_BRANCH_PATTERN` with `{issue}` and `{slug}` substituted. Checkpoint
   `--set worktree=<path>` (and the env file, compose project, ports and scratch dir as
   soon as you choose them). Then sweep: `$S/cleanup pending`, and clean each listed
   run with `--carry-to <this worktree>` ("Cleanup").

3. Plan document (M+ scope only): create `docs/plans/YYYY-MM-DD-<slug>.md` (or the
   plans directory the house rules name) and commit it with the work. S-sized fixes
   may skip the plan document but never skip TDD. Format:

   ```
   # <issue title>

   Issue #<N>

   ## Scope
   In: <what ships>
   Out: <what does not, and why>

   ## Assumptions
   - <each decision the plan makes>

   ## Tasks
   - [ ] 1. <task>: <the failing test that proves it done>
   - [ ] 2. ...
   ```

   Tick each checkbox as the task lands.

4. Strict TDD, per task:
   1. Red: write a test that captures "done" and watch it fail for the right reason.
   2. Green: write the minimal code that passes it.
   3. Refactor with the suite green, then run the area's full suite for regressions.
   4. Commit, one commit per task.
   Test commands per area come from `VIVI_TEST_COMMANDS_FILE`. Never write
   implementation code before its failing test.

5. House rules sweep: re-read `VIVI_HOUSE_RULES_FILE` against the diff, then preflight.
   Do not push yet: the review gate comes first.

Stop conditions at this stage:
- The issue is held by someone else (the claim exited 1).
- Issue premise is contradicted (closed, already shipped).
- Scope requires a decision only a human can make (pricing, legal, secrets, external
  accounts).
- Local test suite fails and cannot be fixed in scope.

On any stop, go to Stage 6 and report `merge_state: no-pr` with the unresolved item.

## Stage 2: Review gate, before the first push

Review the local diff before CI ever sees it. A finding fixed now costs a local commit;
the same finding fixed after green costs a whole CI cycle. Two ways to run it:

- **Before the first push** (the default): review, fix, then push once.
- **Alongside the first CI run**, when the review is slow and the diff is already
  preflighted: push (Stage 3), and run the review while CI runs. A fix push then
  starts a new run, which is the run that must go green.

Either way **CI must pass on the final head**: a push after the review (review fixes,
CI fixes, a rebase) needs its own green run before merge-pr merges it. Code pushed after
a round was reviewed (a CI fix, a conflict resolution) gets a review of just those
commits before it is pushed; that is a round too.

Choose the gate from `VIVI_REVIEW_TOOL`. Never emit silence. The review always starts
local. Copilot reviews are billed per request and re-review the whole PR each time, so
Copilot is at most one final second opinion.

- `independent`: a separate reviewer agent, not you. Start it in its own detached
  worktree at the head under review (`git worktree add --detach <path> <head>`), and
  give it only the issue (number and text) and the diff,
  `git diff origin/<default branch>...HEAD`, plus how to run the tests. Never give it
  your plan, your conclusions or your summary of the change: a reviewer handed the
  author's reasoning tends to return it confirmed. Ask for findings with severity
  (Critical, Important, Minor), file and line, a concrete failure scenario, and a
  suggested fix. Use the harness's own subagent (Claude Code: an Agent subagent on a
  strong model; Codex: a separate session). Record its worktree in `extra_worktrees`
  when you add it, and remove it once the review is in
  (`git worktree remove --force <path>`); `cleanup` removes any you missed. If this
  harness cannot start a separate agent, the gate is `unsatisfied`; never fall back to
  reviewing it yourself under this name.
- `harness`: use the harness's own code reviewer against the diff (for example Claude
  Code's `code-review` skill at high effort, or Codex `/review`). If this harness has
  none, the gate is `unsatisfied` (record `Gate: unsatisfied` and why); never record a
  weaker review under the configured name.
- `copilot`: run the `harness` gate first, until its Critical and Important findings are
  fixed. Then run the copilot-review skill once, for one round, on the pushed head.
  Check the fixes to its comments with the local reviewer, never by requesting Copilot
  again. If Copilot never submits a review, the harness review stands: record
  `Gate: copilot` with "Copilot: no review delivered" and the harness findings.
- `self`: review the diff against the issue scope and the house rules yourself.
- Unset: `self`. Unrecognized (a typo): stop with
  `unresolved: VIVI_REVIEW_TOOL=<value> is not a review gate`; merge-pr's `review-gate`
  refuses it too (exit 2).

Request Copilot only through the `copilot` gate or when the developer explicitly asks.

Fix findings per "Review rounds" (Budgets), each with a failing test first where the
finding is a behaviour, and record the round in the checkpoint. Record the gate in the
PR body under `### Code review gate`, starting with a line naming the gate that ran,
exactly as merge-pr's `review-gate` check reads it:

    ### Code review gate
    Gate: independent
    - Critical, fixed: <finding> (<test that now covers it>)
    - Minor, not fixed: <finding>, because <why> (also in SHIP_RESULT unresolved)

`Gate:` names the gate that actually ran. It must be the configured
`VIVI_REVIEW_TOOL`, or merge-pr refuses to merge; `Gate: unsatisfied` (the configured
gate could not run) always stops the merge, and goes in `unresolved`. "No findings" is a
valid record.

## Stage 2b: Design gate, for UI changes, before the first push

When `$S/design-gate touches` exits 0 (the diff touches `VIVI_UI_PATHS`: UI sources,
styles, design specs, visual baselines), the rendered screens get their own independent
review, next to the code review. A code reviewer reads the diff and never the page; this
gate exists because UI work that passed CI and code review still shipped scattered,
clipped and contradictory. Full procedure, the reviewer prompt and the checklist:
`references/design-review.md`. In short:

1. **Evidence.** For every route and overlay the change touches: screenshots at 1280 and
   375, light and dark, of the change (`$S/ui-evidence <issue> --label after --serve "$PWD"`) and of the
   same views on the default branch (`--label before`, served from a detached worktree of
   `origin/<default>`), with the empty, loading, error and populated states the page has.
   Real pages on your own seeded stack; fixture data only when a feature gate makes the
   real page impossible, and then say so. Shots of sibling pages that use the same
   components. Look at them yourself first.
2. **Done-when evidence table**: each "Done when" item of the issue mapped to the
   screenshot that shows it, or marked not visual with the test that proves it.
3. **Independent design reviewer**: a separate agent in its own detached worktree, given
   only the issue, the design specs and mockups (from `VIVI_DESIGN_INDEX`), the before,
   after and sibling screenshots, and the evidence table. It must open the images. It
   returns PASS or FAIL with Critical, Important and Minor findings, each tied to a
   screenshot. No separate agent, or one that cannot read images: the gate is
   unsatisfied, and you stop.
4. **Fix loop**: Critical and Important findings are always fixed; commit, take fresh
   after screenshots of the new head, and run a new review round. Same round budget as
   the code review; anything left goes into the PR body as unresolved, never silently.
5. **Record**: `$S/design-gate record <issue> --verdict PASS --rounds <n>` (it refuses
   screenshots of another UI), then `$S/design-gate section <issue>` for the PR body's
   `### Design review gate` section, followed by the findings with their fixes and the
   evidence table. In a private repository, `$S/ui-evidence publish <issue>` gives a
   before and after table to link.

A spec-only change gets the gate too, judged as a spec (`--kind spec`, no screenshots;
only for files in `VIVI_UI_SPEC_PATHS`).
`prepush` refuses a UI-touching head without a passed record for its UI, and
`merge-verified` refuses a UI-touching PR whose body lacks a passed design gate for its
current UI. A later commit that touches no UI file keeps the review; any UI change
makes it stale.

**Owner hold (opt-in).** A PR, or the issue it closes, labelled
`needs-owner-design-review` is not merged until the owner (`VIVI_DESIGN_OWNER`) comments
`Design approved: <UI fingerprint>`. Never apply that label, and never post that
phrase. Put the screenshot links and the exact phrase in the PR body for the owner, and
when merge-verified reports `owner_hold`, stop with `merge_state: open` and
`unresolved: waiting for the owner's design sign-off`.

## Stage 3: Push, open the PR, CI

1. `$S/prepush <issue> --body-file <draft PR body>` must exit 0. Push.
2. Open the PR: body `Closes #<issue>`, what shipped, test counts, the
   `### Code review gate` record (or "in progress, alongside CI"), the
   `### Design review gate` record for a UI change (Stage 2b), and any
   `### Quality gate changes` or `### Disclosure review` section. Assign it to the login
   that claimed the issue: `$S/claim <issue> --pr <pr>`. It reads the assignment back and
   reports `claimed`; `not-assigned` goes in `unresolved`. `assigned` in SHIP_RESULT
   reports both read-backs.
3. Use the watch-ci skill, with `ci-watch --issue <issue> --expect-head <sha>`, for the
   current head. On failure:
   - Infra or runner failure: verified retry within budget.
   - Real failure: fix on the branch with TDD, preflight, prepush, push, re-enter
     Stage 3. On `failing` (a job failed while the rest still runs) start the fix at
     once; the push cancels the doomed run (watch-ci step 5).
   - Before any retry, check base freshness: if `VIVI_DEFAULT_BRANCH` moved and touches
     the failing area, rebase first (Stage 3b).

On green, with the review gate recorded for this head: go to Stage 4.
On parked (ci-watch exit 5): runs on the head never executed. Release them per
ci-safety §7, then re-enter Stage 3 on the new head. Parked is never green.
On timed out (60 min): re-check once, then stop and report `merge_state: open` with
the last known state and elapsed time.

### Stage 3b: Rebase when conflicting or stale under a failing lane

Use the rebase-main skill, then re-enter Stage 3. Rebase only for a conflict or a stale
base under a failing lane. A green PR that is merely behind the default branch is not
stale: merge-pr handles it, and nobody updates the branch by hand. Count the rebase only
when rebase-main reports a manual (non-mechanical) resolution (Budgets), and give the
resolved commits their review before pushing them.

## Stage 4: Merge

Use the merge-pr skill. Verify the PR is actually mergeable, including
`$S/review-gate <pr>`, then run `merge-verified`, which merges with the consumer's
`VIVI_MERGE_FLAGS` (lease mode) or enqueues the PR (queue mode, `VIVI_MERGE_MODE=queue`,
or `auto` when the default branch has a merge queue). After a queue is switched on, a PR
whose last run predates it needs one fresh run first (merge-pr, "One merge at a time").
Never `gh pr merge` directly, and never update the branch from the default branch
yourself: only the merge lease holder may, and `merge-verified` is how you hold it
(merge-pr, "One merge at a time"). If the merge succeeds, read the merge commit SHA.

- Exit 5, `state: updated` (lease mode): the default branch moved after the green run
  started, so it updated the branch instead of merging, and this PR keeps the lease
  (merge-pr, "The freshness rule"). That is not a failure and not a rebase: re-enter
  Stage 3 with `--expect-head <head_sha>` from its JSON, then merge again. Each such
  round counts against the watch budget, never the rebase budget.
- Exit 5, `state: queued` (queue mode): still in the merge queue. Run `merge-verified`
  again, which waits without enqueueing twice.
- Exit 6, `state: waiting`: another PR holds the lease. Leave the branch alone; run
  again later or with `--wait-min`. Checkpoint `--decision "waiting on the merge lease
  held by #<holder_pr>"` if you stop here.
- Exit 1, `state: dequeued`: classify the merge group's failed jobs per ci-safety §3
  (merge-pr, "Merge"). A verified retry is re-running `merge-verified`; it counts
  against the retry budget. A real failure goes back to Stage 3 with a fix.
- Any other failure: report the reason in SHIP_RESULT with `merge_state: blocked`. If
  this PR still holds the lease, release it: `$S/merge-verified <pr> --release`.

After a successful merge, checkpoint `merge`, then clean up ("Cleanup"): `cd` to the
main checkout and run `$S/cleanup <issue>`. When another issue follows in this session
and this worktree holds something it needs, leave the cleanup to that run instead
(checkpoint `--decision "cleanup deferred to the next run"`); its sweep carries what it
needs and removes the rest. Never leave it for a human: a run with no successor cleans
up now. Stages 5 and 6 run from the main checkout.

## Stage 5: Issue closure and project board

`Closes #<issue>` in the PR body normally closes the issue on merge. Verify, never
assume:

    $S/vgh issue view <issue> --repo "$R" --json state,stateReason

Anything but `CLOSED`/`COMPLETED`: `$S/vgh issue close <issue> --repo "$R" --reason completed`,
then read it back.

Board, only when `VIVI_PROJECT_OWNER` and `VIVI_PROJECT_NUMBER` are both set (else
`board: skipped`). Board writes need the `project` scope, which a repo-scoped token file
may lack; if a board call is refused, retry it as plain `gh` so it uses the signed-in
account. Read the issue's own board entries instead of listing the whole board (a
board-wide `item-list` is heavy GraphQL and hits rate limits):

    $S/vgh issue view <issue> --repo "$R" --json projectItems \
      --jq '.projectItems[] | {title, status: .status.name}'
    gh project view <number> --owner <owner> --format json --jq '{id, title}'

- The board's entry (matched by the project `title`) already has status `Done`:
  `board: done`.
- Otherwise get the item id with `gh project item-add <number> --owner <owner> --url
  <issue url> --format json --jq .id` (it returns the existing item when there is one,
  and adds it when there is none), the Status field and its `Done` option with
  `gh project field-list <number> --owner <owner> --format json --jq '.fields[] | select(.name=="Status") | {id, options}'`,
  then `gh project item-edit --id <item> --project-id <project> --field-id <field> --single-select-option-id <Done option>`,
  and read it back with the same `issue view --json projectItems`: `board: moved` (or
  `board: added` when the issue had no entry before).
- A board with no `Status` field or no `Done` option, or a write that fails twice:
  `board: failed`, with the reason in `unresolved`.

## Stage 6: Final summary (always emit)

Write the result as JSON to the shared state dir, which outlives the worktree Stage 4
removed. From the main checkout (Stage 4 says to `cd` there; never from a removed
directory, where `git rev-parse` fails):
`d=$(git rev-parse --git-common-dir) && f="$(cd "$d" && pwd)/vivi-state/results/<issue>-ship.json"`,
`mkdir -p` its directory, validate it with `$S/validate ship_result "$f"`, and print
it:

```json
{
  "schema": "SHIP_RESULT",
  "issue": 123,
  "pr": 456,
  "merge_state": "merged | open | blocked | no-pr",
  "ci": "green | failed:<job>:<infra|flake|real> (<evidence>) | parked (<run ids>) | timed_out (<seconds>s)",
  "review_gate": "independent | harness | copilot | self | unsatisfied",
  "design_gate": "independent | not_ui | off | unsatisfied",
  "issue_closure": "closed | reopened-and-closed | open | not-applicable",
  "board": "done | moved | added | skipped | failed",
  "assigned": { "issue": "<login or empty>", "pr": "<login or empty>" },
  "budget": { "retries_verified": 0, "retries_limit": 2, "rebases": 0, "rebases_limit": 2,
              "review_rounds": 0, "review_rounds_limit": 2 },
  "resumed_from": "<stage, only when resumed>",
  "observations": [{ "type": "real_failure", "area": "<area>", "evidence": "<run url>" }],
  "preflight_runs": 0,
  "quality_guard": "clean | justified | blocked",
  "cleanup": "cleaned | partial | refused | deferred | kept",
  "ci_failures_preflight_would_catch": 0,
  "unresolved": "what a human must decide, review findings not fixed, rebase churn, with the evidence",
  "deferred": "issues filed instead of fixed, each with why"
}
```

`cleanup` is the `state` `$S/cleanup` printed; `deferred` when the next run will clean
up (Stage 4); `kept` when a stopped run keeps its worktree for a resume. Anything in
`left_behind` or `reasons` goes in `unresolved`.

Every value came from a script or a read-back. Never assume; always verify.

## Stop conditions, deferred work, and deferral policies

A question a human would ask is a stop condition (unresolved in SHIP_RESULT). A gap
that can be closed in this PR should be closed. File an issue only when:
- The work is owned by another active ticket (reference it in deferred).
- The work needs a decision or action only a human can take (document in unresolved).

A review finding is never either of those: it is fixed in this PR, or, when "Review
rounds" allows leaving it, listed in `unresolved` and the PR body with why. It never
becomes a new issue.
