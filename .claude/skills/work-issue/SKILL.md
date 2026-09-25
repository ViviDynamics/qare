---
name: work-issue
description: Work a single GitHub issue end-to-end — read the issue, research the codebase, present a plan, implement on a feature branch, open a PR, run code review rounds until clean, then update the PR summary.
user-invocable: true
argument-hint: <issue-number> [--auto]
allowed-tools: Bash(gh *) Bash(git *) Bash(pnpm *) Bash(node *) Bash(npx *) Bash(docker *) Read Edit Write Grep Glob Agent Skill ScheduleWakeup
effort: high
---

# Work Issue Workflow

You are working a single GitHub issue end-to-end following the project's established development process.

## Inputs

- `$ARGUMENTS` — Required. The GitHub issue number to work (e.g. `42`).
- Optional `--auto` flag: run without the plan-approval pause (Step 4). Used by
  `/ship-issue` and by subagents — in auto mode the plan is recorded in the PR body
  instead of shown for approval, and every other gate stays non-skippable.

## GitHub authentication

Every Bash call is a fresh shell, so prefix **every** `gh` command with the token.
Resolve the token file with `$HOME`-anchored paths — relative `../.gh_token` breaks
inside `.worktrees/*` (it resolves to the parent of the worktree, which doesn't have it):

```
TOKEN_FILE="$HOME/Workspaces/.gh_token"; [ -f "$TOKEN_FILE" ] || TOKEN_FILE="$HOME/Workspace/ViviDynamics/.gh_token"
GH_TOKEN=$(cat "$TOKEN_FILE") gh ...
```

Both files carry the `repo`, `project` and `workflow` scopes this repo's gates need. Try
a trivial `gh` call first to confirm auth works. If neither file works, stop and report;
do not proceed unauthenticated. (The scripts in the other skills resolve the token
themselves from `repo.env`'s `VIVI_GH_TOKEN_FILE`; bare `gh` commands appear here only
for reads the scripts don't cover.)

## Step 1: Baseline — fetch main (worktree-safe)

```
git fetch origin main
git rev-parse --show-toplevel && git branch --show-current
```

Do **not** run `git checkout main && git pull`: this checkout is often a linked worktree
under `.worktrees/` (or `main` is checked out by another session), and `git checkout main`
fails there. Branch from `origin/main` instead (Step 5). Note which worktree and branch
you are in now — you will re-verify before writing any file.

## Step 2: Read the issue and its comments

```
gh issue view $ARGUMENTS --repo <owner>/<repo> --comments
```

Infer the repo from `git remote get-url origin`.

**Read the full issue body verbatim** — do not skim or extract only named sections. Every sentence in the description is a potential requirement. Parse out, but do not limit yourself to:
- Issue title and number
- Objective, Scope, Out of scope, Done when, Depends on

**Read every comment in full.** Treat the comment thread as an evolving specification. In particular:
- **Audit comments** — from a maintainer or a review bot — that list incomplete items or flag requirements that were skipped in a prior implementation attempt. These describe gaps that *must* be closed — treat each bullet as a required deliverable, even if a prior PR claimed to address the issue.
- Any clarifications, scope changes, or corrections added by the team after the original issue was written.
- Re-open reasons: if the issue was previously closed and re-opened, look for a comment explaining why. That reason defines what the prior attempt got wrong and must not be repeated.

**If the issue was re-opened**, also fetch any PRs that were previously linked to it:
```
gh pr list --repo <owner>/<repo> --search "closes #$ARGUMENTS" --state all
```
Read the body of each prior PR to understand what was implemented. Then compare against the re-open reason and audit comments to identify exactly what was missing or incorrect. Do not repeat the same approach without addressing the stated gap.

**Priority order when sources conflict:**
1. Audit comment incomplete items (most authoritative — represent a verified gap)
2. Re-open reason / post-close comments
3. In-thread clarifications and scope changes
4. Original issue description
5. Prior PR descriptions (lowest — describe intent, not verified outcomes)

If an audit comment says "Incomplete items: …", that list overrides any prior PR's claimed scope and must be fully satisfied before the issue can close.

## Step 3: Research the codebase

Based on the areas the issue names, read the relevant files. Understand:
- What already exists (files, tests, CI jobs, configs)
- What is missing relative to the issue's Done When checklist **and any audit comment incomplete items**
- Any patterns established in adjacent code (e.g. how sibling checks, drivers or profile fields are structured)

For each item in the audit comments and re-open reason, **search the codebase for direct evidence** — don't assume a gap exists or is closed based on a PR description alone. Read the actual files and tests to verify current state.

The issue often names the spec section it implements (a link into `docs/SPEC.md`); read
that section plus its neighbours, and check `CONSTITUTION.md` for rules the change must
keep — the pipeline's job/secret boundaries in `.github/workflows/qare.yml` are decided
by the constitution and the SPEC, not by taste.

Do not implement anything yet.

## Step 3.5: Scope discipline — CLOSE the gap, don't file it

**Filing a follow-up ticket is still deferring. It only looks diligent.** A backlog of
well-written tickets nobody is working is indistinguishable from the gap being open, and
it costs a session's tokens to produce. The work converges when gaps get *closed*.

So, for every requirement implied by the issue that you are tempted to mark "out of scope",
work this order and stop at the first that applies:

1. **Can I close it now?** If yes — do it, in this PR. This is the default and it is what
   "no orphan deferrals" actually means. A gap you *can* close and instead describe in a new
   issue is a gap you chose not to fix.
2. **Does another ticket genuinely own it?** Search the open issues and the board, and
   check `docs/SPEC.md` for where the work is described. "Genuinely owns" means the work
   sits in another active ticket's scope, not merely that a plausible ticket could exist.
   Cite the ticket number in the out-of-scope note.
3. **Does it need a decision only the user can make**, or an action only they can take
   (an org secret, a runner change, a product/pricing/legal call, a sign-off)? Then it is
   genuinely blocked: file it, assign it to them, and set the board to Blocked.
4. **Only if none of the above** — file a new atomic ticket, and say plainly in your
   report that you filed rather than fixed, and why.

Red flags that you are about to file when you should be fixing:

| Thought | Reality |
| --- | --- |
| "This is adjacent to the ticket's scope" | Adjacent and small means do it. Scope is a budget, not a fence. |
| "It deserves its own ticket" | Tickets are for work that needs scheduling, not for work you could finish now. |
| "I'll note it as a follow-up so it isn't silent" | The issue tracker is where good intentions go to be tidy. |
| "The ticket only asked for X" | If Y is broken and one edit away, the user wants Y fixed. |
| "A guard found a real problem — I'll record it" | Recording a finding in an escape hatch defeats the guard that found it. |

When a change touches parallel sites (call sites, sibling packages, both ends of a
protocol), finishing means all of them — see the sibling-site rule in the review step.

## Step 4: Present an implementation plan

Write a concise plan as a markdown table or numbered list covering:
- Each file to create or modify
- What change will be made and why
- Which requirement it satisfies (description / audit comment / re-open reason)

If the issue was re-opened, open the plan with a one-paragraph "Prior attempt gap" section that names what was previously implemented, what was found missing, and how this plan closes that gap. This makes the plan's scope explicit and lets the user catch any misread of the re-open reason before any code is written.

End with: "Shall I proceed?"

**Wait for user approval before writing any code** — unless `--auto` was passed. In auto
mode do not ask anything; write the plan down (it becomes the PR body's Plan section) and
proceed. Auto mode skips only this pause — Steps 4.5 and 9's review gate remain
non-skippable.

## Step 4.5: Move the issue to In Progress and assign it — NON-SKIPPABLE

Once the plan is approved (or immediately, in auto mode), reflect that work has started
on the project board **before** creating the branch. This step is mandatory in every
mode: an untracked/unassigned issue is invisible to the board's status views and a
skipped board move has repeatedly gone unnoticed until then.

The board is the org project **"QARE"** (`PROJECT_OWNER=ViviDynamics`, `PROJECT_NUMBER=15`).
The assignee is whoever is authenticated — always derive it with `gh api user -q .login`
rather than hardcoding a username.

1. **Assign the issue to the user:**
   ```
   gh issue edit <issue-number> --repo <owner>/<repo> --add-assignee "$(gh api user -q .login)"
   ```
2. **Set the board Status to "In Progress".** Resolve the issue's item id through
   GraphQL, asking the *issue* which project items it belongs to:
   ```
   PROJ_ID=$(gh project view 15 --owner ViviDynamics --format json | jq -r .id)
   ITEM_ID=$(gh api graphql -f query='
     { repository(owner: "<owner>", name: "<repo>") {
         issue(number: <issue-number>) {
           projectItems(first: 20) { nodes { id project { number } } } } } }' \
     --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number==15) | .id' | head -n1)
   read SF OPT < <(gh project field-list 15 --owner ViviDynamics --format json \
     | jq -r '.fields[] | select(.name=="Status") as $f | $f.options[] | select(.name=="In Progress") | "\($f.id) \(.id)"')
   gh project item-edit --id "$ITEM_ID" --project-id "$PROJ_ID" --field-id "$SF" --single-select-option-id "$OPT"
   ```
   If `ITEM_ID` comes back empty the issue genuinely is not on the board — add it with
   `gh project item-add 15 --owner ViviDynamics --url <issue-url>`, then re-run the
   GraphQL lookup above.

   **Do not use `gh project item-list` for this lookup.** It silently caps at 1000 items
   no matter what `--limit` you pass, so the lookup returns nothing for any issue above
   roughly #1999, `ITEM_ID` is empty, and `item-edit` fails with `Could not resolve to a
   node with the global id of ''`. The GraphQL query above is not paginated over the
   board at all, so it is unaffected.

The Status field options are: `Backlog, Todo, Blocked, In Progress, In Review, Done`. (`gh project` commands need a token with `project` scope — both token files carry it.)

**Verify the postcondition before proceeding** — a succeeded-looking command is not
evidence. Re-query and confirm:

```
gh api graphql -f query='
  { repository(owner: "<owner>", name: "<repo>") {
      issue(number: <issue-number>) {
        assignees(first: 5) { nodes { login } }
        projectItems(first: 20) { nodes {
          project { number }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }' \
  --jq '.data.repository.issue | {assignees: [.assignees.nodes[].login],
        status: (.projectItems.nodes[] | select(.project.number==15) | .fieldValueByName.name)}'
```

Only when this returns the assignee and `"In Progress"` may you continue. If it doesn't,
fix it now — this step cannot be deferred or silently skipped, in any mode.

## Step 5: Create a feature branch

Derive the branch name from the issue number and a short slug of the title, branching
from `origin/main` (works in any worktree; `git checkout main` does not). This repo's
recent branches are short `qare-<slug>` names (`qare-single-use`, `qare-mail-check`) or
descriptive slugs (`compose-subcommand`, `verifier-verdict`); prefer `qare-<slug>`:

```
git checkout -b qare-<short-slug> origin/main
```

Example: issue #42 "Point a run at a URL qare did not boot" → `qare-run-url`.

## Step 6: Implement

**Before writing the first file, verify where you are:**

```
git branch --show-current && git rev-parse --show-toplevel
```

The branch must be the one created in Step 5 and the toplevel the worktree you expect.
Multiple sessions share this checkout and stale worktrees linger under `.worktrees/` —
work was once written into a **merged** branch's worktree and lost. Two commands prevent
that; run them again after any long gap between tool calls.

Execute the approved plan. Follow all project conventions:
- TypeScript ESM modules in a pnpm workspace (`packages/core`, `packages/cli`, `packages/action`, `packages/mcp`, plus `plugin/` and `examples/`)
- Verdicts decided in code, never by a model; models only propose (the planner) or verify (the verifier)
- Profiles are declarative; anything user-authored that enters a command or flow is validated or substituted at plan time
- Tests are plain `node --test` (`.test.mjs`); no test framework magic
- README.md and docs/SPEC.md are part of the contract — a behaviour change without a matching doc change is incomplete

Run the relevant suite(s) locally and confirm they pass before moving on. These mirror the `pr-ci.yml` `verify` job, so a local pass predicts CI:

| Area | Commands |
| --- | --- |
| Whole repo (fresh checkout) | `pnpm install && pnpm build` — workspace types resolve to `dist/`, so typecheck and tests need a build first |
| Everything | `pnpm typecheck && pnpm lint && pnpm test` |
| One package | `pnpm --filter @qare/<pkg> test` (plus typecheck/lint the same way) |
| Plugin, examples | covered by `pnpm test` (it includes `plugin/claude-code/test` and `examples/test`) |

`pnpm test` runs the workspace tests plus `node --test` over `plugin/claude-code/test/**` and `examples/test/*`. Docker must be running for the end-to-end examples that boot compose.

### Generated artifacts

There is no schema-artifact regeneration step in this repo. If you change a
Zod/JSON-schema contract that other packages read, run `pnpm build` before `pnpm
typecheck`/`pnpm test` — stale `dist/` output is the usual reason a passing local run
contradicts CI.

## Step 7: Commit

Stage only the files changed for this issue. Write a commit message that matches this
repo's history — a plain descriptive sentence, no conventional prefixes:

```
git commit -m "<What the change does, in one sentence> (#<issue-number>)

<Optional body: ## What bullets, ## Notes>

Closes #<issue-number>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

## Step 8: Push and open a PR

```
git push -u origin <branch>
gh pr create --title "<what it delivers>" --body "..." --repo <owner>/<repo>
```

**ASSIGN THE PR, NOT ONLY THE ISSUE — NON-SKIPPABLE.** Step 4.5 assigns the *issue*, and
that is not the same thing: a PR with no assignee shows as unowned in every PR list and in
the review queue, which is exactly where a human looks for what needs attention.

Derive the login rather than hardcoding it, as Step 4.5 does:

```
gh pr edit <N> --repo <owner>/<repo> --add-assignee "$(gh api user -q .login)"
```

Then VERIFY, because `gh pr edit` exits 0 on a no-op:

```
gh pr view <N> --repo <owner>/<repo> --json assignees --jq '[.assignees[].login]'
```

An empty array means it did not take. Do not report the PR as opened until it is non-empty.

PR body must include:
- **Summary**: bullet list of what changed and why
- **Test plan**: checked list of what was verified locally
- `Closes #<issue-number>`

## Step 9: Code review loop — a missing gate must never pass silently

Run up to **2 rounds** of code review using the built-in `review` skill.

**First, check that `review` is actually available in this session** (it is not always).
If it is unavailable, you may NOT skip ahead as if the gate passed. Do exactly one of:

- Stop and report that the review gate cannot run, or
- Substitute (e.g. `/copilot-review` — a trigger alone is not a substitute; only a review
  object that actually arrived counts — or a recorded self-review against the issue's
  Done-When list) **and record the substitution in the PR body** under a
  `### Code review gate` heading: what was unavailable, what ran instead, and its findings.

The failure mode this prevents: the gate silently evaporates and the PR body still reads
as if it was reviewed. Silence is the only unacceptable outcome.

### Round 1

Invoke the review skill, then fetch the PR's review comments:

```
gh api repos/<owner>/<repo>/issues/<PR_NUMBER>/comments --paginate
```

Evaluate each issue raised:

**Category A — Irrelevant or false positive**: style nitpicks conflicting with project patterns, suggestions to add unnecessary abstractions, feedback outside PR scope, suggestions that would break existing behavior or tests. → Note dismissal reason; no code change needed.

**Category B — Valuable**: real bug, missing validation, security concern, clear improvement aligned with PR intent. → Fix the code (minimal change).

### If Category B fixes were made

Stage and commit the changes:

```
git add <changed files>
git commit -m "<what the review fix addresses> (#<issue-number>)"
git push
```

Then run a second review pass and repeat the evaluation. Do not run more than 2 rounds.

### If no Category B issues

The review is clean. Proceed to Step 10.

## Step 10: Update the PR summary

Update the PR body to include a **Code review** section summarizing:
- How many rounds ran
- What was flagged and fixed (or dismissed as false positive)
- Whether the final round was clean

```
gh pr edit <PR_NUMBER> --body "..." --repo <owner>/<repo>
```

## Step 11: Report done

Tell the user:
- PR URL
- Summary of what was implemented
- Code review outcome
- That it is ready to squash-merge (or hand off to `/watch-ci` → `/merge-pr`;
  `/ship-issue` does the whole tail automatically)

End with a machine-readable block so a calling agent can parse the outcome:

```
WORK_RESULT
issue: #<n>
pr: <url>
board_status: In Progress (verified)
review_gate: review-skill:<clean|fixed> | substitution-recorded:<what> | UNSATISFIED
tests_local: <suites run and their results>
```

Every value must reflect a verified state, not an intention — `board_status` only says
"verified" because Step 4.5's re-query returned In Progress.

## Important guidelines

- Never implement before the user approves the plan (Step 4) — except in `--auto` mode,
  where the plan is recorded in the PR body instead. Auto mode relaxes nothing else.
- Never force-push or amend commits on this workflow's feature branch. (The one sanctioned
  exception in this skill set is `/rebase-main`, which force-pushes *your own* branch after
  a rebase — see that skill.)
- Never commit local agent state or secrets: `.claude/settings.local.json`,
  `.claude/worktrees/**`, `.agents/`, `.env`, or the `.gh_token` file. `.gitignore` covers
  these. `.claude/skills/` is the exception — it is tracked deliberately so the whole team
  shares these workflows.
- Cap review fix rounds at 2; escalate to the user if issues persist.
- Match branch naming to the pattern used in recent history: `qare-<short-slug>`.
