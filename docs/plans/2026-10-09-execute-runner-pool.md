# Require an execute runner pool or an ephemeral runner declaration

Issue #308

## Scope

In: refuse self-hosted execute and main_execute jobs before checkout when their
runner selector is empty or names the same pool as runs-on, unless the caller
sets ephemeral-runners: 'true'. Record that caller declaration in result.json
and the posted evidence. Document the isolation required for both choices.
Out: prove infrastructure isolation from labels, audit cluster configuration,
or change qare's own GitHub-hosted CI. These belong to runner operators and #313.

## Assumptions

- Acceptance criteria supersede the older warning-first recommendation: refusal
  ships immediately for both execution lanes, including private repositories.
- Runner labels are case-insensitive sets; JSON whitespace, ordering, duplicates,
  or single-label array syntax cannot disguise the same selector.
- Only the exact string 'true' declares ephemeral runners. This is a caller
  assertion of one fresh machine and daemon per job, not a qare inspection.
- Existing public-repository self-hosted opt-in remains independent.

## Tasks

- [ ] 1. Guard both execution jobs before checkout. Execute the real workflow
  scripts with self-hosted shared, separate, malformed and ephemeral selectors,
  and GitHub-hosted inputs; prove refusal and unchanged hosted behavior.
- [ ] 2. Preserve the declaration in detected host evidence and validated results,
  render it as a caller assertion, and pass it through both run containers.
  Tests catch loss at detection, result parsing and posted evidence boundaries.
- [ ] 3. Document dedicated pool labels, per-job daemon and storage isolation,
  ephemeral lifecycle, migration inputs, and independent public opt-in.

## Validation

Run the targeted workflow script tests and core placement/result tests after
red-green cycles, then pnpm build && pnpm typecheck && pnpm lint && pnpm test.
Commit and run ship-issue preflight plus quality guard before each push. Review,
watch CI, squash merge, verify issue closure, and preserve the worktree for root.
