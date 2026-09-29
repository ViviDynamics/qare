# Agent workflows in qare

Rules that agents must follow when working on this repository.

## Repository facts

- **Repo:** ViviDynamics/qare
- **Default branch:** main
- **Merge method:** squash merge only
- **CI workflow:** .github/workflows/ci.yml (named "CI")
- **Build command:** pnpm build && pnpm typecheck && pnpm lint && pnpm test

## Workflow conventions

1. **Before pushing:** run `.agents/skills/ship-issue/scripts/preflight <issue>`, which runs the rows of `.agents/test-commands.md` the diff touches. The full gate is `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
2. **Branch naming:** Use the pattern `feat/{issue}-{slug}` (e.g., `feat/123-add-feature`).
3. **Commit messages:** No em or en dashes as punctuation; use periods, commas, or parentheses.
4. **PR review:** Resolve all review threads before merging.
5. **GitHub-hosted runners only:** qare is a public repository; never use self-hosted runners.

## Workflow skills

`.agents/skills/` holds the workflow skills (`.claude/skills` and `.opencode/skill` point at the same copies), adapted from the org's internal skill set at tag `2026.09.15` and tuned to qare. Never weaken a lint, type, test or CI gate to get green: the quality guard blocks it unless the PR body justifies each file under `### Quality gate changes`.

## Code requirements

See CONSTITUTION.md for non-negotiable rules about agent behavior, evidence collection, and model decision boundaries.
