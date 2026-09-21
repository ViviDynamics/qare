# Plan: `qare readiness` (issue #30)

## Global Constraints (bind all tasks)

- Constitution (CONSTITUTION.md): verdicts decided in code; fail closed; no provider SDKs; model calls only through the `AgentRunner` seam; offline tests only — a scanner bans the literal strings `http://` and `https://` in test sources (build URLs with `['http:', '//host'].join('')`); strict loaders with named errors; canonical forms; deterministic output.
- Readiness NEVER emits a QA verdict and never writes `result.json`. It inventories and reports.
- No new dependencies unless one already exists in the workspace.
- Commit messages end with `(refs #30)`.
- Verification per task: `pnpm -r build` (visible output), `pnpm -r test`, `pnpm lint`, plus `node --test "plugin/claude-code/test/**/*.test.mjs"` and `node --test "examples/test/*.test.mjs"`.

## Task 1: Readiness inventory, report, and `qare readiness` (issue #30)

Goal: the first run on a repo with no `.qa/` inventories what QA needs instead of refusing every PR.

Scope:
- Core module `packages/core/src/readiness.ts`:
  - Boot inventory: find compose files (`docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml`, in repo root and app subdirectories at reasonable depth); parse services with the same YAML loading path the profile loader uses; report service names, image, healthcheck presence, command/entrypoint if present.
  - Outbound reach inventory: deterministic, bounded, sorted scan of repo text files (skip `.git`, `node_modules`, `dist`, binaries, files over 1 MB; cap file count with a note) for scheme+host URL literals; summarize by `scheme://host[:port]` origin, with file:match counts (deterministic order).
  - Stub comparison: if a `.qa/` profile exists and loads, compare reached origins against profile stub URL prefixes and the health URL using the existing egress matching (`matchesStub`); report covered vs uncovered origins; report profile gaps (no health, no seed, no login, no stubs for uncovered origins).
  - Gaps: named list — no compose found / no healthcheck / no `.qa/` / reached origins without stubs / profile origins never reached.
  - `buildReadinessReport(inventory): string` — deterministic markdown; `Report NEVER contains a verdict`.
- CLI `qare readiness [path]` (default cwd): prints the report to stdout; `--out <file>` also writes it (parent dirs created); exit 0 when a report is produced; exit 4 with named errors for usage/IO failures (missing path, unparseable compose). Update the CLI usage line and `--help`. Never runs checks, never boots the app, never writes `result.json`.
- Tests: core unit tests (boot detection, reach summary, stub comparison with/without profile, bounded-scan caps, deterministic ordering); CLI test for stdout report, `--out`, and error exits (follow packages/cli/test patterns).

Done when: running `qare readiness` on a repo with no `.qa/` produces a report and no QA verdict (pinned by a test).
