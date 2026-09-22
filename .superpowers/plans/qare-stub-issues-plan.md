# Plan: stub issues and re-queued QA (issue #31)

## Global Constraints (bind all tasks)

- Constitution (CONSTITUTION.md): verdicts decided in code; fail closed; no provider SDKs (GitHub calls are plain `fetch` against the REST API — no SDK, no Octokit); model calls only through the `AgentRunner` seam; offline tests — a scanner bans the literal strings `http://` and `https://` in test sources (build URLs with `['http:', '//…'].join('')` or `['https:', '//…'].join('')`); strict loaders with named errors; canonical forms; deterministic output.
- The engine (`@qare/core`) never calls GitHub. GitHub calls live in the action package behind a core-defined seam, exactly like `EvidencePoster`.
- Deterministic, canonical stub-issue content: same refused findings → same title, same body, same dedup key.
- Commit messages end with `(refs #31)`.
- Verification per task: `pnpm -r build` (visible output), `pnpm -r test`, `pnpm lint`, plus `node --test "plugin/claude-code/test/**/*.test.mjs"` and `node --test "examples/test/*.test.mjs"`.

## Task 1: core stub-issue model — drafts, markers, re-queue decisions (issue #31)

Goal: everything about "one issue per missing stub" that can be decided without GitHub, decided once, in code.

Scope:
- `packages/core/src/stub-issues.ts`:
  - `missingStubs(findings: EgressFinding[]): MissingStub[]` — parse refused findings of the shipped shape `refused: missing stub: <host>:<port> (<protocol>)` (from `summarizeEgress`) into canonical records `{host, port, protocol, count}`; unknown/non-refused findings are ignored, malformed reason strings are skipped (fail closed: never guess a host); findings merge by host (sum counts, first-seen port/protocol kept deterministically).
  - `stubIssueDraft(missing: MissingStub): StubIssueDraft` — deterministic title `Stub needed for <host>`, canonical dedup key `qare-stub: <host>`, body: **Calls made** (host:port (protocol) with counts), **What the stub must answer** (protocol/port; the exact `stubs:` YAML entry the profile needs, with a suggested `provided_by.compose_service` name derived from the host), **Linking** (the `qare-stub: <key>` marker and the refused-PR registry format `qare-refused: #<pr>`). No timestamps, no run ids — byte-identical for identical inputs.
  - Marker helpers: `stubIssueMarker(key): string`, `parseStubIssueMarkers(text): string[]` (canonical keys found in a comment/body), `refusedRegistryLine(pr): string`, `parseRefusedRegistry(text): number[]` (PR numbers from a stub issue body).
  - Re-queue decision: `requeueTargets(mergedKeys: string[], refused: Array<{pr: number; keys: string[]}>): number[]` — refused PRs whose missing-stub keys intersect the merged stub keys, deduplicated, sorted by PR number.
  - Extend `EvidencePoster`-style seams: `StubIssuePoster` interface `{ fileIfMissing(draft): Promise<number>; addToRegistry(issue: number, pr: number): Promise<void>; comment(pr: number, body: string): Promise<void> }` defined in core, implemented by the action in Task 2.
- Export everything from `packages/core/src/index.ts`.
- Tests: parsing (shipped reason format, malformed lines skipped, merge-by-host), deterministic drafts (snapshot-compare full body, no timestamps), marker/registry round-trips, requeue ordering/dedup, fail-closed on garbage.

## Task 2: action GitHub surface — filing, linking, re-queue workflow (issue #31)

Goal: the judge side files and links stub issues; a stub PR merge re-queues the refused PRs it unblocked.

Scope:
- `packages/action/src/github.ts`: minimal REST client (`fetch`, token from env, configurable API root for tests): create issue, search issues by qualifier, get issue, patch body, list issue comments, post issue comment, post PR comment (reuse issue-comment endpoint), list open PRs. Error handling: non-2xx → named errors with status + endpoint, never silent.
- `packages/action/src/stub-issues.ts`: implements the core `StubIssuePoster` seam: search issues for the canonical `qare-stub:` key → create if missing (title/body from the draft) → append `qare-refused: #<pr>` to the registry if absent → comment on the refused PR with the stub-issue link.
- `packages/action/src/requeue.ts`: given a merged stub PR (set of touched stub keys from the event) and the repo's stub issues, read each stub issue registry, and re-queue matched refused PRs by posting `/qa` comments (the existing comment trigger). Once-per-SHA stays with the trigger module.
- `packages/action/src/index.ts`: named CLI entry points the workflow can call: `qare-action stub-issues --result <path> --pr <n>` and `qare-action requeue --keys-from-diff <base>...<head>` (parse the diff for `.qa/config.yml` `stubs:` hosts and/or touched `.qa/` files) with `--api-root`, `--token-env` overrides for tests.
- Workflow (`.github/workflows/qare.yml`): judge job gains a stub-issue filing step (only on refusal; uses GITHUB_TOKEN); a new `requeue` job on push to main touching `.qa/**` posts `/qa` on the refused PRs the merge unblocked. Named, actionable errors; secret hygiene comments follow the existing file pattern.
- Tests: action tests against a local fake GitHub REST endpoint (node `http` server on loopback, URL built with the join idiom) covering search-hit (no duplicate issue), create path, registry append idempotence, comment posting, requeue filtering and named errors. Offline: no real GitHub traffic.
- Done-when pinned by tests: a refused result produces stub-issue drafts that file idempotently; merging stub keys re-queues exactly the refused PRs whose keys intersect.
