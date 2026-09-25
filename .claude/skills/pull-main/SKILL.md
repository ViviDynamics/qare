---
name: pull-main
description: Switch to the main branch and pull the latest changes, then show the resulting HEAD commit.
user-invocable: true
allowed-tools: Bash(git *)
effort: low
---

# Pull Main

Switch to main and pull the latest changes.

## Steps

1. Check where you are: `git rev-parse --git-common-dir` — if it is not `.git`, this is a
   **linked worktree** and `git checkout main` will fail (main is checked out in the
   primary checkout). In that case run `git fetch origin main`, show
   `git log --oneline -1 origin/main`, and tell the user updated main is available as
   `origin/main` in this worktree.
2. Otherwise: `git checkout main`, then `git pull origin main`.
3. Show the latest commit with `git log --oneline -1`.

If `git checkout main` fails because of uncommitted changes, stop and tell the user which files are
dirty — do not stash or discard their work. Multiple sessions share this checkout: if
`git branch --show-current` shows someone else's feature branch, fetch instead of
switching branches out from under them.
