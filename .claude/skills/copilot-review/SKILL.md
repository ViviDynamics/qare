---
name: copilot-review
description: Trigger a GitHub Copilot code review on the current PR, poll for comments, evaluate and respond to each, fix valid issues, resolve irrelevant ones, push changes, and loop until no new actionable comments remain.
user-invocable: true
argument-hint: [pr-number]
allowed-tools: Bash(gh *) Bash(git *) Bash(set *) Bash(go *) Bash(npm *) Bash(node *) Bash(python3 *) Read Edit Write Grep Glob Agent ScheduleWakeup
effort: high
---

# Copilot Code Review Workflow

You are running an automated Copilot review loop on a pull request. You will keep looping — request review, wait, process comments, fix or dismiss, push, repeat — until Copilot comes back with no new actionable comments or all remaining comments are dismissed. Cap at **8 rounds** to prevent runaway.

> **Reality check for ViviDynamics/qare: Copilot review arrival is unproven here.**
> The trigger appears to succeed in sibling repos, yet no review ever arrived there, and
> a watcher that counts threads "passes" trivially with zero threads. Therefore this
> skill's outcome is a pass **only** when a review object actually arrived (`submitted_at`
> after the trigger timestamp). "Requested, nothing arrived" is a distinct outcome —
> report it as `review_received: false`, and any caller using this as a review gate must
> treat that as the gate UNSATISFIED, not as a clean review. Zero comments only counts as
> clean when a review demonstrably arrived and contained none.

## Inputs

- `$ARGUMENTS` — Optional PR number. If omitted, detect from the current branch.

## GitHub authentication

Before running any `gh` command, try a trivial `gh` call first (e.g. `gh pr view --json number`). If it fails with 401/Bad credentials, check for `../.gh_token`. If it exists, prefix every `gh` command with `GH_TOKEN=$(cat ../.gh_token)` (each Bash invocation is a fresh shell). If `gh auth` works natively, skip this.

---

## Step 1: Identify the PR

```
gh pr view --json number,url,headRefName 2>/dev/null || echo "NO_PR"
```

If `$ARGUMENTS` is provided, use that PR number instead. If no PR is found, stop and tell the user.

Store: PR number, repo owner/name (`owner/repo`), head branch, and the **current HEAD SHA** at the start of this round.

---

## Step 2: Request Copilot Review (reliably)

**`gh pr edit --add-reviewer @copilot` silently no-ops when Copilot is already in `requested_reviewers`.** Always DELETE first to clear the slot, then re-add. Use the REST API as the primary method; fall back to `gh pr edit` if the REST POST doesn't register.

1. Remove Copilot from requested reviewers first (ignore errors):
   ```
   gh api -X DELETE repos/{owner}/{repo}/pulls/{pr_number}/requested_reviewers \
     -f 'reviewers[]=copilot-pull-request-reviewer[bot]' 2>/dev/null || true
   ```

2. Re-add via the REST API:
   ```
   gh api -X POST repos/{owner}/{repo}/pulls/{pr_number}/requested_reviewers \
     -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
   ```

3. **Verify the request landed** — check the response from the POST. The returned JSON should include `"requested_reviewers"` with an entry where `login` is `"Copilot"`.

4. **If verification fails** (empty `requested_reviewers` in the response), fall back to the gh CLI (this works reliably after the DELETE cleared the slot):
   ```
   gh pr edit {pr_number} --add-reviewer @copilot
   ```
   Then re-check `gh api repos/{owner}/{repo}/pulls/{pr_number} --jq '.requested_reviewers[].login'` to confirm `Copilot` appears. If still absent, stop and tell the user the trigger failed (likely Copilot is not enabled on this repo).

Record the **trigger timestamp** (UTC ISO-8601) immediately after the successful POST.

Tell the user that the Copilot review has been requested for round N and you will begin polling.

---

## Step 3: Poll for a New Copilot Review

Poll every 2 minutes (up to 20 minutes / 10 attempts) using `ScheduleWakeup` with `delaySeconds: 120` —
a foreground `sleep` is blocked, so do not shell out to one:

```
gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews
```

Look for a review where:
- `user.login` contains `copilot`
- `submitted_at` is **after** the trigger timestamp recorded in Step 2

The `state` for a Copilot comment review is `"COMMENTED"`.

**Important:** The reviews API can lag. If no qualifying review appears within the time limit, fall back to checking the comments API — look for any Copilot-authored comment with `created_at` after the trigger timestamp:

```
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments --paginate
```

While waiting, tell the user which attempt you're on and how long you've waited. Once a qualifying review appears (or qualifying comments appear), move on.

If after 20 minutes nothing has arrived, stop and report `review_received: false` — the
expected outcome in this repo (see the reality check above). Do **not** phrase this as
the PR having passed review; nothing reviewed it. If a review gate depends on this skill,
the caller must record a substitution (see `work-issue` Step 9) instead of counting this
as a pass.

---

## Step 4: Fetch All New Copilot Comments

Fetch all PR review comments:
```
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments --paginate
```

Filter to comments where:
- `user.login` contains `copilot`
- `created_at` is **after** the trigger timestamp (so you only process this round's comments, not old ones)

For each comment, capture:
- `id` — for replying
- `pull_request_review_id` — to group by review
- `body` — the comment text
- `path` — file path
- `line` or `original_line` — line number
- `diff_hunk` — surrounding code context
- `created_at` — for filtering

If there are **zero new comments**, the review came back clean. Tell the user and stop — the PR is ready to merge.

---

## Step 5: Evaluate Each Comment

For each new Copilot comment, read the referenced file and surrounding code. Then categorize:

### Category A: Irrelevant or Harmful
The comment is a false positive, out of scope, or implementing it would change or break the PR's intent. Examples:
- Style nitpicks that conflict with project conventions
- Suggestions to add unnecessary error handling or abstractions
- Feedback about code outside the scope of this PR
- Suggestions that would break existing tests or behavior
- Repeat of a comment already addressed in a prior round

For these: **reply** explaining concisely why the suggestion doesn't apply, then **resolve** the thread.

### Category B: Valuable Feedback
The comment identifies a real issue — a bug, missing validation, security concern, or clear improvement that aligns with the PR's intent.

For these: **fix the code**, then **reply** acknowledging the fix, then **resolve** the thread.

---

## Step 6: Apply Fixes and Respond

### To reply to a comment:
```
gh api -X POST repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies \
  -f body="<your response>"
```

### To resolve a thread (GraphQL):

First fetch all unresolved Copilot threads:
```
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes { databaseId body author { login } }
            }
          }
        }
      }
    }
  }
' -f owner="<owner>" -f repo="<repo>" -F pr=<pr_number>
```

Filter to threads where `isResolved == false` and the first comment's author login contains `copilot`. Resolve each:
```
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
' -f threadId="<thread_id>"
```

### To fix code:
Use the Edit tool. Keep fixes minimal and targeted. Run `pnpm lint` (eslint over the
workspace) and the touched package's `pnpm --filter @qare/<pkg> test` before committing.
If a local lint comes back suspiciously clean, re-run with the cache cleared
(`npx eslint --no-cache`).

---

## Step 7: Commit and Push (if fixes were made)

If any Category B fixes were applied:

1. Stage only the changed files (never `git add -A` — avoid accidentally staging .env or binaries)
2. Commit:
   ```
   git commit -m "[<TICKET>] Address Copilot review feedback (round <N>)

   Co-Authored-By: Claude <noreply@anthropic.com>"
   ```
   Infer the ticket prefix from the branch name or most recent commit.
3. Push to the remote branch.
4. Update the stored **HEAD SHA** to the new commit.

If only Category A dismissals (no code changes), skip the commit and proceed directly to the loop decision.

---

## Step 8: Loop Decision

- **If fixes were pushed** → increment round counter, go back to Step 2 (re-request review against the new commit).
- **If all comments were Category A (dismissed, no fixes)** → stop. All threads are resolved. Tell the user the PR is ready to merge.
- **If round counter ≥ 8** → stop with a warning. Tell the user the loop cap was reached and list any unresolved comments for manual review.

---

## Important Guidelines

- Be concise in replies to Copilot. One or two sentences is enough.
- When declining a suggestion, be respectful but firm. Reference project conventions when applicable.
- When fixing code, make the minimal change that addresses the concern. Do not refactor surrounding code.
- Always lint changed files before committing.
- Never force-push or amend commits.
- If a Copilot comment is ambiguous, err on the side of fixing it.
- Preserve the PR's original intent — do not make scope-expanding changes.
- A comment that is a repeat of one already addressed in a prior round is always Category A.
- Track which comments have been processed across rounds using the `created_at` timestamp filter — never re-process an old comment.
- End every invocation with a machine-readable line so callers can't misread the outcome:
  `COPILOT_RESULT review_received: <true|false> rounds: <n> fixed: <n> dismissed: <n>`.
  `review_received: false` means the gate this was serving is still unsatisfied.