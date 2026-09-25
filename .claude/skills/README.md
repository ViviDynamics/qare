# Shared workflow skills

These are the team's workflow skills for this repo. They are **project skills** — agents
load every `SKILL.md` under `.claude/skills/` automatically when you open a session in
this repo, so there is nothing to install. Invoke one by typing its slash name (e.g.
`/ship-issue 118`).

Everything else under `.claude/` is local agent state and stays ignored (see the
`.claude/*` + `!.claude/skills/` pair in [`.gitignore`](../../.gitignore)). Never commit
`.claude/settings.local.json`, `.claude/worktrees/**`, `.agents/**`, or any `.env` file.

## Which skill, when

| You want to… | Use | Notes |
| --- | --- | --- |
| Take an issue all the way to a **merged** PR, unattended (incl. from a subagent) | `/ship-issue <n>` | Composes everything below; no interactive pauses; explicit stop conditions and retry budget; safe to invoke twice (resumes). |
| Work an issue with a human approving the plan | `/work-issue <n>` | Interactive plan gate; add `--auto` to skip it (that is what ship-issue does). Ends at an open PR. |
| Watch `main`'s CI, retry flakes, report breaks | `/watch-ci-main [branch]` | Report-only — never pushes to main. |
| Bring a stale branch up to date with main | `/rebase-main` | Worktree-safe (never checks out main); handles squash-merged parents via `--onto`. |
| Run the Copilot review loop | `/copilot-review [pr]` | Only a review object that actually arrived counts — non-arrival is reported as `review_received: false`, never as a pass. |
| Update local `main` | `/pull-main` | Worktree-aware: fetches instead of checking out when main lives elsewhere. |

`ci-safety`, `watch-ci` and `merge-pr` are installed from ViviDynamics/skills (2026.09.2,
per that repo's ADOPTING.md). Do not edit the installed copies of the scripts; change them
upstream. The SKILL.md files here are adapted to this repo's conventions.

The composed chain, for orientation:

```
ship-issue <n>
  └─ work-issue --auto   → open PR (board verified In Progress)
  └─ watch-ci            → green | classified failure     (ci-safety rules throughout)
       └─ rebase-main    ← when origin/main already fixes the failing lane, or conflicts
  └─ review gate         → review skill, else copilot-review, else substitution recorded in PR body
  └─ merge-pr            → squash, verified MERGED
```

## Conventions the skills rely on

- **GitHub auth.** Each `Bash` call is a fresh shell, so every `gh` command carries its token inline.
  Resolve the token file with `$HOME`-anchored paths:
  ```
  TOKEN_FILE="$HOME/Workspaces/.gh_token"; [ -f "$TOKEN_FILE" ] || TOKEN_FILE="$HOME/Workspace/ViviDynamics/.gh_token"
  GH_TOKEN=$(cat "$TOKEN_FILE") gh ...
  ```
  Both carry the `repo`, `project` and `workflow` scopes the gates need. The skill scripts
  resolve the token themselves from `repo.env`'s `VIVI_GH_TOKEN_FILE`.
- **CI status comes from the Actions API**, filtered by the PR's **current head SHA** —
  `gh api repos/{owner}/{repo}/actions/runs?head_sha=<sha>`. `gh pr checks` 403s on some
  tokens and mislabels CANCELLED as `fail`; `gh run list --commit` returns empty even when
  runs exist. See `ci-safety/SKILL.md` for the full set of traps and the verified-retry
  protocol.
- **CI workflows.** `CI` (build → typecheck → lint → test on every PR) and `QARE` (the
  plan → execute → judge pipeline, with its own secret-hygiene map in
  [`.github/workflows/qare.yml`](../../.github/workflows/qare.yml)). Job conclusions are
  read through `ci-runs`/`ci-watch`, never by eye.
- **Merging is squash-only** (`VIVI_MERGE_FLAGS` in [repo.env](../../repo.env)):
  `--squash --delete-branch`. If main's ruleset still shows `BLOCKED` with green checks,
  that is a ruleset the author cannot satisfy alone, not a CI failure — see `merge-pr`.
- **Checkouts are often linked worktrees under `.worktrees/`.** `git checkout main` fails
  there; skills fetch and use `origin/main`. Always verify branch + worktree
  (`git branch --show-current`, `git rev-parse --show-toplevel`) before writing files.
- **pnpm workspace, build before test.** Workspace types resolve to `dist/`, so a fresh
  checkout cannot typecheck or test until `pnpm build` has run. The command table lives
  in `/work-issue` Step 6 and mirrors [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
- **Branch naming** follows recent history: `qare-<short-slug>`.
- **Commit style** matches recent history: a plain descriptive sentence with the issue
  number (`(#42)`), `Closes #<n>` in the body, no conventional prefixes.
- **Force-pushing is sanctioned in exactly one place:** `/rebase-main`, on your own
  unmerged feature branch, with `--force-with-lease`. Never `--force`, never `main`,
  never someone else's branch.
- **macOS runs bash 3.2** — no `mapfile`; guard empty arrays under `set -u` with
  `${arr[@]+"${arr[@]}"}`. CI's bash will not catch these for you.

## Editing these skills

They are ordinary tracked files — change them in a PR like any other code. Things to keep in mind:

- A skill's `allowed-tools` is a real permission boundary. If you add a step that shells out to a new
  tool, add it to the frontmatter or the step will be blocked at runtime.
- Keep repo-specific facts (job names, flake signatures, package paths) accurate. A stale heuristic in
  `/watch-ci` costs someone a retry loop on a real failure.
- These skills encode incident residue from the repos they came from. When you hit a new trap, write
  the *reason* into the relevant skill, not just the rule — the reason is what stops the next agent
  from rationalizing around it.
- Skills meant to be callable by subagents must stay non-interactive (inputs as arguments,
  machine-readable result block, idempotent, postconditions verified before claiming success).
