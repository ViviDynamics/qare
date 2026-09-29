# Agent workflows in qare

Rules that agents must follow when working on this repository.

## Repository facts

- **Repo:** ViviDynamics/qare
- **Default branch:** main
- **Merge method:** squash merge only
- **CI workflow:** .github/workflows/ci.yml (named "CI")
- **Build command:** pnpm build && pnpm typecheck && pnpm lint && pnpm test

## Workflow conventions

1. **Before pushing:** Ensure the build passes locally with `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
2. **Branch naming:** Use the pattern `feat/{issue}-{slug}` (e.g., `feat/123-add-feature`).
3. **Commit messages:** No em or en dashes as punctuation; use periods, commas, or parentheses.
4. **PR review:** Resolve all review threads before merging.
5. **GitHub-hosted runners only:** qare is a public repository; never use self-hosted runners.

## Code requirements

See CONSTITUTION.md for non-negotiable rules about agent behavior, evidence collection, and model decision boundaries.
