---
name: rebase-main
description: Rebase the current feature branch onto the latest main, resolve conflicts, force-push with lease, and update the PR summary with a rebase log.
user-invocable: true
allowed-tools: Bash(git *) Bash(gh *) Bash(go *) Bash(npm *) Read Edit Write Grep Glob
effort: high
---

# Rebase Main Workflow

You are rebasing the current feature branch onto the latest `main`, resolving any conflicts, and updating the PR.

## Current State

```!
git branch --show-current
```

## Step 1: Validate State

Confirm you are on a feature branch (not `main`). If on `main`, stop and tell the user.

Check for uncommitted changes:
```
git status --porcelain
```

If there are uncommitted changes, stop and tell the user to commit or stash first.

Store the current branch name for later.

## Step 2: Update Main (worktree-safe — never checkout main)

```
git fetch origin main
```

Do **not** `git checkout main`: it fails inside a linked worktree (main is checked out
elsewhere), and this repo's checkouts are frequently worktrees under `.worktrees/`.
`origin/main` after a fetch is all you need.

## Step 3: Rebase

Plain case — the branch was cut from main:

```
git rebase origin/main
```

**Stacked case — the branch was cut from a parent PR's branch that has since been
squash-merged.** `main` enforces squash-only merges, so the parent's commits are NOT
ancestors of `origin/main` — a plain rebase replays the parent's commits and conflicts
on every one. Detect it: `git log --oneline origin/main..HEAD` lists commits that are
the parent's, not yours. Then rebase only your own commits:

```
git rebase --onto origin/main <old-parent-head>
```

where `<old-parent-head>` is the last commit belonging to the parent (the commit your
first own commit sits on). After this, re-verify the diff — your commits now sit on
different code than they were written against.

If the rebase completes cleanly, skip to Step 5.

## Step 4: Resolve Conflicts

If the rebase produces conflicts:

1. Run `git status` to see which files are conflicted
2. For each conflicted file:
   - Read the file to see the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
   - Resolve the conflict by choosing the correct content. General rules:
     - For code files: prefer the feature branch changes but incorporate any necessary main changes
     - For test files: merge both sets of changes where possible
        - For generated files, prefer main's version and then **re-run the generator** rather than
          hand-merging: `pnpm install` for `pnpm-lock.yaml` after a dependency change, `pnpm build`
          for anything under `dist/` (generated output is never committed, but stale dist is the
          usual reason a local pass contradicts CI)
     - For SQL migrations, never renumber main's migrations — renumber **yours** to sit after the
       highest number now on main, and update any test that pins the migration count
   - Use the Edit tool to remove conflict markers and write the resolved content
3. Stage the resolved file: `git add <file>`
4. Continue the rebase: `git rebase --continue`
5. If more conflicts appear, repeat from step 1

If conflicts are too complex to resolve automatically, abort the rebase (`git rebase --abort`) and tell the user.

## Step 5: Re-verify the Affected Modules

A clean rebase is not a passing build — main may have moved under you. Re-run the checks for whatever
your branch touches (see the table in `/work-issue` Step 6 and `.github/workflows/ci.yml`), at minimum:

```
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

`pnpm build` first: workspace types resolve to `dist/`, so typecheck and tests need it
after a fresh checkout or a rebase. If main introduced a break in your branch's area, fix
it in a normal follow-up commit before pushing.

## Step 6: Force Push

```
git push --force-with-lease
```

This is safe because `--force-with-lease` only overwrites if no one else has pushed to the remote branch
since your last fetch.

> **This is the one place in this skill set where force-pushing is sanctioned** — `/work-issue` otherwise
> says never force-push or amend. The exception is narrow: your **own** unmerged feature branch, after a
> rebase, with `--force-with-lease`. Never `--force`, and never on `main` or anyone else's branch.

If the push is rejected because the remote moved (someone else pushed to your branch, or a bot amended
it), stop and tell the user — do not escalate to `--force`.

## Step 7: Update the PR Summary

Prefix every `gh` command with the token (each Bash invocation is a fresh shell; use
`$HOME`-anchored paths — relative `../.gh_token` breaks inside worktrees):

```
TOKEN_FILE="$HOME/Workspaces/.gh_token"; [ -f "$TOKEN_FILE" ] || TOKEN_FILE="$HOME/Workspace/ViviDynamics/.gh_token"
GH_TOKEN=$(cat "$TOKEN_FILE") gh ...
```

Detect the PR number:
```
gh pr view --json number --jq '.number'
```

If a PR exists, fetch its current body and update it to reflect the rebase:
```
gh pr view --json body --jq '.body'
```

Append or update a "Rebase log" section at the bottom of the PR body (before the Claude Code footer if present):

```
### Rebase log
- Rebased onto main (YYYY-MM-DD) at <main_sha>; conflicts in <files> or "no conflicts"
```

If a "Rebase log" section already exists, append a new bullet rather than duplicating the section.

Use:
```
gh pr edit <PR_NUMBER> --body "<updated body>"
```

Pass the body via a HEREDOC for correct formatting.

If a rebase commit was needed to fix a break introduced by main, name the issue in its
message — plain descriptive sentence with the issue number, matching this repo's history:

```
git commit -m "Fix <what> after rebase onto main (#<issue>)"

Co-Authored-By: Claude <noreply@anthropic.com>"
```

## Important Guidelines

- Never rebase if on `main` — that would rewrite shared history.
- Always use `--force-with-lease`, never `--force`.
- If conflict resolution is ambiguous or risky, abort and ask the user.
- Re-run the affected module's tests after the rebase — a clean rebase can still produce a broken build.
- Re-run generators instead of hand-merging generated files (`sqlc`, OpenAPI clients, lockfiles).
