# Test commands for ViviDynamics/qare
#
# The file named by VIVI_TEST_COMMANDS_FILE in repo.env; watch-ci Step 7 and the
# review loops read "the command for that area" from here. These mirror the
# `verify` job in .github/workflows/ci.yml, so a local pass predicts CI.

## Whole repo, fresh checkout (or after pulling)

pnpm install && pnpm build

Workspace types resolve to `dist/`, so typecheck and tests need a build first
after a fresh checkout, a rebase, or any change to another package's public
surface.

## Everything (matches the CI `verify` job)

pnpm build && pnpm typecheck && pnpm lint && pnpm test

## One package

pnpm --filter @qare/<pkg> test        # core, cli, action, mcp
pnpm --filter @qare/<pkg> typecheck
pnpm --filter @qare/<pkg> build

## Plugin and examples

Covered by the root `pnpm test` (it includes `plugin/claude-code/test/**/*.test.mjs`
and `examples/test/*.test.mjs`).

## End-to-end examples that boot compose

Some example tests boot the compose stack and need Docker running. When Docker is
unavailable, everything else still runs green; note the gap in the PR body rather
than skipping CI's verdict.

## Lint only

pnpm lint                              # eslint over the workspace
npx eslint --no-cache <file>           # when a cached run looks suspicious
