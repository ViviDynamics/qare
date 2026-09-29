---
name: draft-criteria
description: Draft acceptance criteria from an issue, a spec section or a change, in the repository's house style, and validate the draft through the ledger's own loader before anyone sees it.
user-invocable: true
allowed-tools: Bash(git *), Bash(gh *), Bash(node *), Bash(pnpm *)
effort: medium
---

# Draft Criteria

Turn an issue, a spec section or a change into draft criteria the ledger will
take, in the house style. Writing the criteria is the act that decides
everything downstream: a criterion that names no observable behavior costs a
run that proves nothing, so the draft is validated mechanically, never by eye.

## The house style

- One criterion proves **one observable behavior**. A sentence joined with
  "and" is two criteria, because a run proves one half and the other half rides
  along unproven.
- Name what a run **sees**: the page, the element, the command, the expected
  result. "The app works properly" is not a criterion; it is a hope.
- No quality words: properly, correctly, appropriately, robustly, works,
  handles, user-friendly. If the only defense of a criterion is an adverb, it
  is not yet a criterion.
- No implementation details: the criterion states the behavior, not the code
  that should produce it.
- Every criterion names its **source**: the issue, spec anchor or pull request
  the behavior is stated in. A criterion without a source is a guess.
- Status is `proposed` until a run proves it `active`. Only a reviewed change
  strengthens a criterion.
- `proof` is `command` when an exit-code command can prove the behavior, and
  `flow` when proving it takes a browser through a page. If you cannot choose,
  `/propose-checks` exists for exactly this.
- The `criterion` id is kebab-case naming the behavior (`payout-1099-notice`),
  stable under rewording, with no `:` and no path separators.
- Write the plain-words meaning in `text`, the way the SPEC's example carries
  `id` and `text` side by side.

## Steps

1. Read the source whole. An issue: `gh issue view <n> --repo ViviDynamics/qare`
   (`--json body` for the raw body). A spec: the section, not the vibe. A
   change: the diff, plus the issue it promises to close.
2. Draft one entry per observable behavior. The fields are the ledger's own:
   `criterion`, `status` (`proposed`), `source` (array of links), `proof`,
   and `text` for the plain-words sentence. Write the draft as a JSON array to
   a file; do not touch the ledger.
3. Validate the draft through the ledger's own loader, so the entries pass
   validation with no hand editing:
   ```bash
   pnpm build 2>/dev/null || true   # only if packages/core/dist is missing
   node .claude/skills/draft-criteria/scripts/validate.mjs <draft.json> <export-dir>
   node packages/cli/dist/index.js ledger import --from <export-dir> \
     --ledger <scratch-dir> --by "$(git config user.name)" \
     --why "validate criteria draft" --publish <scratch-dir>/CRITERIA.md
   node packages/cli/dist/index.js ledger list --ledger <scratch-dir>
   ```
   `imported N entries ... history intact` means the strict loader took the
   draft. If it refuses anything, the draft is wrong: fix the draft and run it
   again. Never widen the loader to fit the draft.
4. Present the draft with the source of each criterion and the read-back from
   `qare ledger list`, and stop. The draft is a proposal: it arrives as a
   reviewable change, never as a silent edit to anyone's ledger.
