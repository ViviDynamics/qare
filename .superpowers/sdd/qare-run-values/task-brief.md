# Task: run-scoped values (qare issue #68)

Worktree: /home/jason/Workspace/ViviDynamics/qare/.worktrees/qare-run-values (branch qare-run-values, off origin/main 98cbb1e). Work ONLY there. Do not commit secrets; do not touch other worktrees (qare-readiness, qare-delivery).

Implement qare issue #68 in the qare repo. Read the issue first:
gh issue view 68 --repo ViviDynamics/qare

## Contract (from the issue)
1. Values minted per run, referenced by name from the profile, the seed step, commands, flows and checks.
2. A mail address is the first minted value; a run id and a timestamp come free with it.
3. Referencing an unknown name fails loudly at plan time, not halfway through a run.
4. Minted values appear in evidence so a reader can see which address a run used.
5. Values are per run, so two concurrent runs never collide.
6. Out of scope: user-authored scripting or expressions — this is substitution, not a language. No mail check kind (#67), no totp (#64).

## Design decisions (binding)
- New packages/core/src/values.ts:
  - `mintRunValues(): RunValues` returns Record<string, string> with keys: id (crypto random, e.g. randomUUID), started_at (ISO 8601), mail_address = `qare-<id>@localhost`. Open record so future values come free.
  - `substituteValues(text, values)` replaces `{{run.<name>}}` tokens; returns the substituted string.
  - `validateValueReferences(text, values, field)` throws (JobValidationError-style, fail closed) naming the field and the unknown name when any `{{...}}` token does not name a minted value. Any `{{...}}` that is not a valid reference is an error, not prose.
- Vocabulary: references are namespaced `{{run.id}}`, `{{run.started_at}}`, `{{run.mail_address}}` ( ":" is reserved for criterion ids; "." namespaces here). Validate against the minted map keys, not a hardcoded list, so new values are automatic.
- Substitution applies at every point user-authored strings enter execution, today:
  - profile app.seed.command (profile.ts: seed: { command })
  - check run and env values (run.ts runCommandCheck / parseCheck in job.ts)
  - flow definition strings where flows are materialised for execution (inspect flow.ts, job-from-plan.ts, plan.ts; if flows are not executable in run.ts yet, apply substitution where they are parsed so the plumbing is proven)
  - login fixture/role strings only if they are value-carrying (they are paths/names; leave them unless trivial)
- Plan-time validation: in runJob, after profile resolution and BEFORE bootApp, walk profile + job strings, collect every {{...}} reference, and fail the whole run closed (verdict refused naming the unknown name and field) when any reference is unknown. Nothing boots when a name is unknown.
- Evidence: after finishRun writes result.json, also write values.json into the evidenceDir (the minted values, redacted through the same rules — constitution: evidence is published, fail closed).
- Per-run isolation: mail_address embeds the run id, which is crypto-random per run; two mintRunValues() calls never share an address. Test asserts different addresses across two mints.

## Tests (vitest, offline, in packages/core/test/values.test.ts + extend run.test.ts)
- substitution replaces all three names in one string and leaves plain text untouched
- unknown name in a reference: named, fielded validation error before boot (runJob-level test with a job whose check references {{run.bogus}}; assert verdict refused, reason names run.bogus, and no boot happened — inject runCompose via BootOpts to prove boot never ran)
- any malformed {{...}} (e.g. {{ or {{}} is a loud error, not silent text
- seed command, check run and check env values each get substitution (assert the spawned command/env received the minted value — reuse the existing runCommandCheck test seams; keep tests offline)
- two concurrent runs mint different mail addresses
- values.json appears in the evidence dir and is covered by redaction (profile redact rule matching the address proves the sweep runs)
- evidence: the done-when "a flow types an address that a later mail check waits on" lands with #67 — do not fake it; the PR body says the plumbing slice is what shipped

## Conventions
- Mimic the repo voice: rationale comments only where the contract is subtle (see run.ts doc comments). Tests follow existing patterns in packages/core/test/.
- No new dependencies. node:crypto randomUUID is fine.
- Fail closed everywhere: unknown reference never degrades to empty-string substitution.
- Update docs/SPEC.md if it names the check kinds or value model in a way this extends (check the Pipeline section; keep edits minimal).

## Verify before you report
From the worktree root: pnpm install (or --frozen-lockfile), pnpm build, pnpm test (all packages must pass), pnpm lint. All green or you are not done.
Commit with a message ending "(refs #68)". Report: what landed, commit sha, test counts, anything you learned that changes the #67/#69 design.
