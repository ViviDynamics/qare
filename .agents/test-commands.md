# Test commands

Run by `preflight` before every push. A row runs only when the branch's diff touches
its paths; rows run top to bottom, cheapest first, and stop at the first failure.
`{files}` is the changed files the row matched. These mirror the pnpm scripts CI runs:
`pnpm build && pnpm typecheck && pnpm lint && pnpm test`.

| Area | Paths | Command |
| --- | --- | --- |
| Lint, changed files | *.ts, *.tsx, *.js, *.mjs, *.cjs | pnpm exec eslint {files} |
| Lint, whole tree | eslint.config.js, package.json, pnpm-lock.yaml | pnpm lint |
| Build and types | packages/*, tsconfig.base.json, package.json, pnpm-lock.yaml, pnpm-workspace.yaml | pnpm build && pnpm typecheck |
| Tests | packages/*, plugin/*, examples/*, package.json, pnpm-lock.yaml | pnpm build && pnpm test |
| Skills wiring | .agents/*, repo.env.example | .agents/skills/ci-safety/scripts/check-wiring |

To run one test: `pnpm test -- <file>`.
