# Wire exploration into the pipeline so flows are planned against the running app

Issue #377

## Scope

In: `explore: base` in the profile has the plan job boot the base app and serve it to the planner over the exploration channel (#87). The channel reaches nare through its MCP client (it reached nare as environment no release reads). Every element a planned flow names carries the page it came from, held in code to what the session was shown. Off, nothing changes.

Out: exploring the head (the sandbox split #87 describes); target and client profiles (refused at load); the host MCP channel (#399); `capture` over the bridge (nare hands MCP results to the model as text).

## Trust boundary

[ADR-0011](../decisions/adr-0011-explore-the-base-in-the-plan-job.md).

## Assumptions

- `explore` is a top-level key, read by the pipeline with the flavour's `awk` and validated by the loader. It needs `app` and `flavour: web`.
- The bridge is MCP Streamable HTTP on loopback in the planner's process, alias `explore`; a page is a path on the app.
- Exploring, every role and name element carries `page` and `at` from a recorded snapshot; a test id is refused.

## Tasks

- [x] 1. Profile key: profile.test.ts.
- [x] 2. `page` on an element: plan.test.ts.
- [x] 3. Flow page as exploration page, origin-pinned: explore-page.test.ts.
- [x] 4. MCP bridge recording snapshots: explore-bridge.test.ts.
- [x] 5. Runner hands nare `--mcp-config` and `--tools`: nare-runner.test.ts.
- [x] 6. Plan step prompt and `exploredGap`: plan-explored.test.ts.
- [x] 7. `qare explore boot|serve`, `qare plan --explore`: explore-command.test.ts, plan-explore-command.test.ts.
- [x] 8. Plan job steps: pipeline-explore.test.ts, workflow-images.test.ts; end to end in CI with scripts/explore-boot.sh.
- [x] 9. Docs and `.qa/checks/explore.mjs`.
