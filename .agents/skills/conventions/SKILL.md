---
name: conventions
description: Use when starting work in qare, when unsure which workflow skill applies, or when asked how qare ships code, watches CI, or merges.
license: Elastic-2.0
compatibility: Any agent that can run bash, gh, jq and git.
metadata:
  version: "1.0.0"
---

# How we work at Vivi Dynamics

Workflow skills are shared across repositories from the `ViviDynamics/skills`
repository. Repo-specific facts live in the consumer's `repo.env`; skills never contain
them. Scripts do the mechanical work and print JSON; you make the judgment calls the
skill names, and you cite the script output for every claim.

**Where the scripts are.** `S` is a skill's `scripts/` directory, next to its SKILL.md.
Set it once per session, for example `S=.agents/skills/<name>/scripts` (or
`.claude/skills/<name>/scripts` where that is the installed copy), then run every script
as `$S/<script>`.

## Which skill, when

| You want to | Use |
| --- | --- |
| Know the CI rules before touching a run | `ci-safety` (read first) |
| Wait for a PR's CI, retry safely, find out why it failed | `watch-ci` |
| Watch the default branch's CI and retry flakes | `watch-ci-main` |
| Merge a PR, or decide whether it can merge | `merge-pr` |
| Bring a branch up to date with the default branch | `rebase-main` |
| Run a GitHub Copilot review loop on a PR | `copilot-review` |
| Take an issue to a merged PR unattended | `ship-issue` |
| Work an issue to an open PR with a plan gate | `work-issue` (future) |

## Ground rules

1. Every `gh` call in a skill goes through the skill's scripts: a purpose-built script,
   or `$S/vgh` for one-off reads. The scripts read the token from the file named by
   `VIVI_GH_TOKEN_FILE` in `repo.env`, falling back to `GH_TOKEN` or `GITHUB_TOKEN` in
   the environment.
2. A claim needs a read-back. "Merged" means `merge-verified` printed `merged`.
   "Retried" means `verified-rerun` exited 0. "Assigned" means the assignee list read
   back non-empty.
3. State for a long chain lives in `.agents/state/<issue>.json` via `$S/state`.
   Read it before deciding, write it after acting. It is gitignored.
4. Never force-push except inside `rebase-main` on your own unmerged branch, and then
   only with a lease. Never push to the default branch.
5. Never disable, skip or delete a test to make CI green.
6. Prose we publish (PR bodies, comments, docs) uses no em dashes.

## Model tiers (guidance for whoever routes work)

| Stage | Tier |
| --- | --- |
| Resume detection, board and assignee updates, PR creation, CI watch, merge | cheapest available |
| Flake vs real classification with a signatures file | mid |
| Reading the issue, planning, implementing | mid or top |
| Root-causing a real CI failure; code review | top |

Skills do not select models. They are written so the cheapest tier can follow them.

## Adopting these skills in a repo

Copy `repo.env.example` to `repo.env` (it is gitignored, as is `.agents/state/`), then:

    cp repo.env.example repo.env
    .agents/skills/ci-safety/scripts/check-wiring

`check-wiring` prints `{"ok":true}` when everything is in place, or a `problems` list.
