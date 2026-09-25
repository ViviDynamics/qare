---
name: ship-issue
description: Use when a GitHub issue should go all the way to a merged PR without a human in the loop — including when invoked by a subagent or an unattended session.
user-invocable: true
argument-hint: <issue-number>
allowed-tools: Bash(gh *) Bash(git *) Bash(pnpm *) Bash(node *) Bash(npx *) Bash(docker *) Bash(python3 *) Bash(find *) Bash(grep *) Bash(set *) Read Edit Write Grep Glob Agent Skill ScheduleWakeup
effort: high
---

# Ship Issue — issue number in, merged PR out

Composed entry point chaining the repo's workflow skills end-to-end:

```
work-issue (--auto) → watch-ci → [rebase-main when stale] → review gate → merge-pr
```

**REQUIRED BACKGROUND:** `.claude/skills/ci-safety/SKILL.md` — every CI interaction in
this chain follows it.

**This skill never waits for a human.** It runs `work-issue` in `--auto` mode (no plan
approval pause), makes every decision from stated rules, and ends with a machine-readable
summary. If you want the interactive plan-approval flow, run `/work-issue` directly
instead. There are no interactive prompts anywhere in this chain — a question you want to
ask the user is a **stop condition** (below), reported in the final summary, not asked.

## Inputs

- `$ARGUMENTS` — Required issue number. Everything else is derived.

## Retry budget (global, fixed)

| Resource | Budget | On exhaustion |
| --- | --- | --- |
| Verified retries per CI job (ci-safety §4) | 2 | stop: classify and report |
| Same flake signature on this PR (ci-safety §5) | 1 retry, then root-cause | fix or stop with classification |
| Rebases onto main | 2 | stop: report churn — main is moving under the PR |
| Review-fix rounds | 2 | proceed with unresolved items listed in PR body |
| Watch wall-clock per CI cycle | 60 min | re-check once, then stop: `watching-timed-out` |

Spent budget is never restored by "it looks different this time". Track it explicitly.

## Stage 0: Resume detection (idempotency)

Safe to invoke twice — first discover what already exists, then enter the chain at the
right stage. In order:

```bash
TOKEN_FILE="$HOME/Workspaces/.gh_token"; [ -f "$TOKEN_FILE" ] || TOKEN_FILE="$HOME/Workspace/ViviDynamics/.gh_token"
GH_TOKEN=$(cat "$TOKEN_FILE") gh issue view $ARGUMENTS --json state,title
GH_TOKEN=$(cat "$TOKEN_FILE") gh pr list --search "closes #$ARGUMENTS" --state all --json number,state,url,headRefName
git branch -a --list "*qare-$ARGUMENTS*"
git branch -a --list "*tkt-$ARGUMENTS*"
```

- PR exists and `MERGED` → report done (Stage 5 output), exit success.
- PR exists and `OPEN` → verify its branch/worktree, enter Stage 2 (watch CI).
- Branch exists, no PR → push it, create the PR (work-issue Steps 7–8), enter Stage 2.
- Nothing exists → Stage 1.

Before writing any file at any stage, verify you are in the branch and worktree you
think you are: `git branch --show-current` and `git rev-parse --show-toplevel`. Work was
once written into a merged branch's worktree; two commands prevent that.

## Stage 1: Implement — `work-issue` in auto mode

Follow `.claude/skills/work-issue/SKILL.md` with `--auto`: no plan-approval pause; the
plan goes into the PR body instead. All of work-issue's gates remain **non-skippable** in
auto mode — especially Step 4.5 (board → In Progress, GraphQL lookup, verified) — and the
"build before typecheck/test" rule whenever package sources changed (workspace types
resolve to `dist/`, so a fresh checkout cannot typecheck or test until `pnpm build`).

Output of this stage: an open PR URL. If work-issue stops (issue unreadable, scope
requires a decision listed in its own stop conditions), stop here and report.

**Both the ISSUE and the PR must end up assigned.** Step 4.5 covers the issue; work-issue
Step 8 covers the PR. They are separate objects and assigning one does not assign the other
— audited 2026-08-28 in this org, a session left eight issues correctly assigned and all
four of its PRs unowned. Verify each with a read-back (`gh pr view --json assignees`),
because `gh pr edit` exits 0 on a no-op, and treat an empty array as the step not having
happened.

## Stage 2: CI — `watch-ci` under ci-safety rules

Follow `.claude/skills/watch-ci/SKILL.md`. Decisions specific to this chain:

- Green (Actions API, current head SHA) → Stage 3.
- Failure classified **infra/resource** → verified retry within budget.
- Failure classified **known flake, first occurrence** → check base freshness FIRST
  (ci-safety §6): if `main` touches the failing lane, go to Stage 2b instead of retrying
  — a retry on a stale base can never pass. Otherwise verified retry.
- Failure classified **known flake, second occurrence / real** → investigate and fix on
  the branch (watch-ci Step 6), then re-enter Stage 2. If the fix requires decisions
  outside the issue's scope → stop condition.

### Stage 2b: Rebase when stale — `rebase-main`

Trigger: base freshness check shows `origin/main` ahead with commits touching the failing
lane, OR the PR has conflicts. Follow `.claude/skills/rebase-main/SKILL.md` (worktree-safe
fetch; `--onto` if stacked on a squash-merged parent). Then re-enter Stage 2 for the
fresh run. Budget: 2 rebases total.

## Stage 3: Review gate — never pass silently

The gate is satisfied by exactly one of, in preference order:

1. `Skill("review")` — **check availability first.** If the session's skill list has no
   `review`, it is unavailable; do not pretend to have run it.
2. `/copilot-review` — but only a review object that actually arrived counts: the trigger
   appearing to succeed with zero threads afterwards is NOT a pass (see that skill's
   reality check). Zero threads after a delivered review object is a clean pass.
3. **Recorded substitution** — if neither produced a real review, append to the PR body:

   ```
   ### Code review gate
   /review unavailable in this session; Copilot review requested at <ts> but never
   delivered. Substituted: self-review against the issue's Done-When list —
   <findings or "no findings">.
   ```

Silence is the only forbidden outcome. A missing gate that isn't recorded in the PR body
is a failure of this skill, even if the code is perfect. Apply review fixes per
work-issue Step 9 (budget: 2 rounds), pushing and re-entering Stage 2 after each push.

## Stage 4: Merge — `merge-pr`

Follow `.claude/skills/merge-pr/SKILL.md`: BLOCKED ≠ red, squash with the consumer's
`VIVI_MERGE_FLAGS`, merge on the **first** genuine green, stacked-child rule (a green
child containing the parent's commits merges now), and verify `state == MERGED` before
claiming it.

## Scope: shipping means closing, not cataloguing

`work-issue` Step 3.5 is binding here and is the rule most often broken in this chain:
**a follow-up ticket is a deferral wearing a suit.** If a gap is one you could close in
this PR, close it — filing it instead converts finishable work into backlog and burns a
session to produce a document.

File only when the work is genuinely owned by another active ticket, or needs a decision
or action only the user can take (a secret, a runner, a pricing/legal call, a sign-off).
In that second case, assign it to them and set the board to **Blocked** so it is visible
rather than buried in a comment.

If you do defer, the Stage 5 `deferred:` line must say what you filed and why closing it
was not possible. "It felt out of scope" is not a reason.

## Stop conditions (report, don't loop)

Stop immediately and emit the Stage 5 summary when:

- A failure is classified **real**, or the same flake signature hits twice and
  root-causing needs decisions beyond the issue's scope.
- Any budget row is exhausted.
- The review gate can neither be satisfied nor recorded (e.g. PR body edit fails).
- `merge-pr` preconditions fail for a reason no stage above can fix.
- The issue or board state contradicts the premise (issue closed, PR by someone else).

## Stage 5: Final summary (always emit, whatever the outcome)

```
SHIP_RESULT
issue: #<n> <title>
pr: <url or none>
merge_state: merged | open | blocked:<reason> | no-pr
ci: green | failed:<job>:<infra|known-flake|real> — <one-line evidence>
review_gate: review-skill | copilot-received | substitution-recorded | UNSATISFIED
assigned: issue=<login|NONE> pr=<login|NONE>   (read back, not assumed)
budget: retries=<x>/2 rebases=<y>/2 review_rounds=<z>/2
unresolved: <none | what a human must decide, with the evidence>
deferred: <none | issues filed instead of fixed, each with why it could not be closed here>
```

Every claim in this block must have been verified per the underlying skill's
postcondition — `merged` means you saw `state == MERGED`, `retries=1` means you saw
`run_attempt` increment. Numbers you did not verify do not go in the block.
