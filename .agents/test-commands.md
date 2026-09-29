# Test commands

Each area's local command, mirroring pnpm scripts. Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test` to do all of them in the same order CI does.

| Area | Command |
| --- | --- |
| Build | `pnpm build` |
| Types | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Tests | `pnpm test` |
| One test | `pnpm test -- <file>` |
| Skills wiring | `.agents/skills/ci-safety/scripts/check-wiring` |
