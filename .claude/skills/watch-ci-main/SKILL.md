---
name: watch-ci-main
description: Watch the latest GitHub Actions run on the main branch, automatically retry jobs that failed due to flakes, and report real failures so they can be investigated.
user-invocable: true
argument-hint: [branch-name]
allowed-tools: Bash(gh *) Bash(git *) Read Edit Write Grep Glob Agent
effort: medium
---

# Watch CI on Main Workflow

You are watching the latest CI run on the main branch (or another long-lived branch), automatically retrying flaky failures and surfacing real failures for follow-up.

**REQUIRED BACKGROUND:** `.claude/skills/ci-safety/SKILL.md` — token resolution (§1),
cancelled ≠ failure (§3), the verified-retry protocol (§4), classification with the
second-occurrence rule (§5), and watcher resilience (§7) all bind here. On `main` the
"is this run superseded?" question (§2) still applies: only retry the run for the
branch's **current** tip — rerunning an older run steals the concurrency slot and
cancels the current one.

## Inputs

- `$ARGUMENTS` — Optional branch name. Defaults to `main`.

## Step 1: Identify the Branch

If `$ARGUMENTS` is provided, use that as the branch name. Otherwise default to `main`.

Tell the user which branch you're watching.

## Step 2: Identify the Latest Workflow Run

Get the most recent workflow run for the branch:

```
gh run list --branch <branch> --limit 1 --json databaseId,status,conclusion,workflowName,headSha,headBranch,event,createdAt
```

Capture the `databaseId` (run ID), `headSha`, and `workflowName`. Tell the user which run you're watching, including the SHA and when it started.

If no runs exist for the branch, stop and tell the user.

**If `gh run list` or `gh pr checks` returns 403** (the token lacks the checks scope this repo's
ruleset expects), fall back to the Actions REST API, which works with the standard `../.gh_token`:

```
gh api "repos/<owner>/<repo>/actions/runs?head_sha=<sha>" \
  --jq '.workflow_runs[] | {id, name, status, conclusion}'
gh api "repos/<owner>/<repo>/actions/runs/<run_id>/jobs" \
  --jq '.jobs[] | {name, status, conclusion}'
```

Treat the Actions API as the authoritative source for "is CI green" in this repo.

## Step 3: Poll Until Run Completes

If the run is still `in_progress` or `queued`, poll every 60–120 seconds using `run_in_background: true` until `status` becomes `completed`. Use:

```
gh run view <run_id> --json status,conclusion,jobs
```

A transient `gh` failure is not a result — retry the poll up to 5 times with increasing
waits; never exit declaring "unknown" (ci-safety §7). If a newer run appears on the
branch while watching, switch to it — the old run is superseded.

Cap the wait at 60 minutes; on cap, report "watching timed out; last known state X at
HH:MM". Periodically tell the user how many jobs are in progress vs done.

If the run completes with `conclusion: "success"`, tell the user CI on `<branch>` is green and stop.

If the run completes with any other conclusion (`failure`, `cancelled`, `timed_out`), proceed.

## Step 4: Identify Failed Jobs

```
gh run view <run_id> --json jobs --jq '[.jobs[] | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != null) | {databaseId: .databaseId, name: .name, conclusion: .conclusion, url: .url}]'
```

For each failed job, capture: `databaseId` (job ID), `name`, `conclusion`, `url`.

If no failed jobs, stop — the run failed for some other reason (e.g., setup error). Tell the user and stop.

## Step 5: Classify Each Failure as Flake or Real

For each failed job, fetch its logs (filtered to failures):

```
gh run view --job <job_id> --log-failed
```

A job is **likely a flake** if any apply:

- Network errors: `ECONNRESET`, `ETIMEDOUT`, `Connection refused`, `Could not resolve host`, DNS failures, "504 Gateway Timeout"
- Infrastructure errors: "The runner has been lost", "The operation was canceled", "Lost communication with server", Docker/image pull failures, "no space left on device"
- Compose-stack startup races in the docker e2e lanes (`console-e2e`, `*-e2e` integration jobs): a
  container not healthy yet, `dial tcp … connection refused` against Postgres/Keycloak/gateway,
  `psql: error: … exit code 127` from a missing client in the runner image
- Log-observation lag: an assertion that greps `docker logs` output failing because the writer
  hasn't flushed yet (a known cause of Agent-Update-E2E flakes)
- Go test timing: `context deadline exceeded` or `-timeout` panics in a test that passes locally,
  `deadlock detected`, goroutine-leak detectors firing under load
- Self-hosted runner issues: a job that never started, a stale workspace, or a toolchain missing
  from the runner image (e.g. the release runner has no Go unless `setup-go` runs)

A job is **NOT a flake** (treat as real failure) if any apply:

- Test assertion failures with clear expected/actual mismatches
- TypeScript compile errors (typecheck), eslint findings, or failing `node --test` suites
- Formatting or lockfile drift, or a missing `pnpm build` leaving `dist/` stale against the sources
- `npm run lint` / `npm run build` errors in `console/`, or failing `node --test` cases
- RSpec failures or RuboCop offenses in `backend-admin-rails/`, or Python `unittest` assertion errors
- Missing or out-of-order SQL migrations, schema/`sqlc` mismatches
- Contract-drift failures (OpenAPI vs. generated client, design-token guards)
- Deterministic failures present across multiple runs

If unsure, lean toward "real failure" — main branch breakages are higher-stakes than feature branch flakes.

## Step 6: Take Action Per Job

### Flake → Verified retry (ci-safety §4)

Preconditions: the run's `status` is `completed` (`gh run rerun` silently no-ops on an
in-progress run) and its `head_sha` is still the branch's current tip. Then:

1. Capture `run_attempt` from `gh api repos/<owner>/<repo>/actions/runs/<run_id>`.
2. `gh run rerun <run_id> --failed`
3. Poll until `run_attempt` increments — only then report "retried (attempt N)". If it
   doesn't increment, the retry did not happen; say so and diagnose, never claim it.

Tell the user which job(s) you retried and why (cite the matching heuristic). Then loop back to Step 3 to watch the rerun.

Cap **verified** retries at 2 per job; a flake signature that recurs is a real failure —
report it (this skill never pushes fixes to main).

### Real Failure → Report, Don't Fix

**Do not push fixes to main from this skill.** Main is shared infrastructure — fixes belong on a feature branch with a PR.

For each real failure:

1. Identify the failing test/file/line from the logs
2. Find the commit that likely introduced the breakage:
   ```
   gh run view <run_id> --json headSha
   git log --oneline -10 <sha>
   ```
3. Suggest who/what to investigate (e.g., commit author, PR number if mergeable)
4. Summarize the failure clearly: file path, error message, suspected cause

Tell the user explicitly that this is a real failure on main and recommend creating a fix branch.

## Step 7: After Retries, Loop Back

After a retry, return to Step 2 to identify the new latest run state and watch it.

Stop the loop when:
- Run completes successfully
- Per-job retry cap reached (2 attempts)
- A real failure was detected and reported
- 3 total iterations have happened

Always end with a clear summary: branch name, run ID, which jobs flaked vs failed for real, and the final CI state.

## Important Guidelines

- **Never push to main.** This skill only retries jobs and reports — it never commits or pushes to main.
- **Be conservative on retries.** A "flake" that fails twice the same way is a real failure — escalate to the user.
- **Be explicit about classification.** When you call something a flake, name the matching heuristic. When you call it a real failure, name the file/line and the suspected commit.
- **Don't retry the same job more than 2 times.**
- **Surface the blast radius.** If main is broken, every downstream feature branch is affected — emphasize urgency in your report.
- **Don't open PRs or branches automatically.** Just report and let the user decide who fixes it.
