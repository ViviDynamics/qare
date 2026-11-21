# Wire exploration into the pipeline so flows are planned against the running app

Issue #377

## Scope

In:
- A profile opts in with `explore: base`. Absent (or `explore: off`), nothing changes: no step boots anything in the plan job, `qare plan` is called as today, and nare is handed no tool.
- With `explore: base`, the plan job boots the base revision's app, serves it to the planner over the exploration channel (#87), and the planner plans its flows from what it saw.
- The channel reaches nare for real. Today qare hands nare the channel as `QARE_EXPLORATION_*` environment variables, which no nare release reads, and passes `--tools none`, so a real model session never sees a tool. nare's general MCP client (`--mcp-config`, Streamable HTTP) is the capability that exists; qare speaks it.
- Every element a flow names carries the page it was read from (`page`, a path on the app) beside the snapshot path it sat at (`at`), and when the plan explored, code holds each one to the snapshots the session was actually served.

Out:
- Exploring the head. That is the sandbox split #87 describes (PR code beside the browser), and the issue asks for the base.
- Exploring a `target` or a `client` profile. A target already runs elsewhere and a client build has no browser page; the loader refuses `explore` on both, so nothing silently does less than asked.
- The host MCP channel (#93), which reaches nare through the same unread environment variables. It is a separate feature with its own servers; a follow-up issue is filed rather than widening this one.
- `capture` over the channel. nare hands an MCP result to the model as text, never as an image, so a screenshot would arrive as a base64 string the size of the page. The bridge serves `observe`, `snapshot` and `navigate`, the read-only subset #87 already allows.

## Trust boundary

What #87 guarantees: the browser and the exploration server run beside the app and hold no secret; the only traffic is tool calls and their results; exactly the read-only tools are served; every result is fenced as untrusted data. SPEC: "Exploring the merge base or a deployed target needs no sandbox split, because there is no PR code beside the app there."

Constitution 7 is about pull request code. The plan job already checks out only the base revision and holds the model key and nothing else. The design keeps every rule as follows:

1. **No PR code runs in the plan job.** The app is built from the base checkout the job already has. The prebuilt `base.image` (#381) is never used for exploration: it is trusted by its revision label, and a label is whatever its pusher wrote, so a registry a pull request's own CI can push to could put PR code beside the key. Execute holds no secret, so the label check is enough there; here it is not, and exploration always builds from the base tree. The build cache (#398) is not read either.
2. **The steps that run base code hold nothing.** Booting and serving are their own steps, with no `secrets.*` and no token in their environment, started before the key exists on disk. The boot step is the only one handed the runner's docker, and it exits once the app is up and seeded. The serve step (browser and exploration server) is handed no docker access, so nothing qare starts can `docker inspect` the planner's container while the key is in it.
3. **The plan step holds what it held.** It gains a host network (to reach the served channel on loopback) and an `--explore` endpoint, and nothing else. The model key still travels in its file, and no GitHub token is anywhere in the job.
4. **Navigation stays on the app.** The browser's `navigate` is pinned to the booted app's origin, so a prompt injected through the diff cannot point the browser at the runner's metadata service or anywhere else.
5. **Fail closed.** A boot, seed or serve that fails stops the plan job with the reason in the step summary; it never falls back to planning blind, because the profile asked for exploration.

What remains, and is written in pipeline.md: the base app's own containers run on the machine while the plan step holds the key. That is the base revision's code, which the repository already merged, and the same trust the plan job places in the base checkout's profile. A profile whose base compose file reaches out to something a pull request can write (a mutable image tag CI pushes, say) should not turn exploration on.

## Assumptions

- `explore` is a top-level profile key, read by the pipeline with the same `awk` the flavour is read with, and validated for real by `qare explore boot`, which refuses a profile the loader rejects.
- `explore: base` needs `app` and `flavour: web` (the browser is in the web image). The loader refuses it otherwise, naming why.
- The bridge is an MCP Streamable HTTP server (JSON responses, no SSE) on loopback inside the planner's container, at the root path, aliased `explore` for nare, so the model calls `explore__observe`, `explore__snapshot`, `explore__navigate`.
- The bridge records what it served: for every snapshot, the page's path (read with `observe` first) and the snapshot's node paths. A planned element's `page` is that path (`/settings`), never an absolute URL, because the run boots the app on another port.
- With exploration, every role and name element in a flow or visual check must carry `page` and `at`, the page must be one the session snapshotted, and `at` must be a path in that page's snapshot. A test id is refused, because a snapshot does not show one. Otherwise the plan is corrected once and then refused, like every other plan gap.
- The plan with exploration is one batch at a time (already true for any tool channel).

## Tasks

- [x] 1. Profile: `explore: base | off`, refused without `app` or without `flavour: web`. Tests in profile.test.ts.
- [x] 2. Plan loader: an element may carry `page`, a path starting `/`. Tests in plan.test.ts.
- [x] 3. Browser page: the Playwright session answers `observe`; `explorationPageOf` adapts a flow page to the channel with navigation pinned to the app's origin. Tests in explore.test.ts.
- [x] 4. Bridge: `startExplorationBridge` speaks MCP over HTTP, forwards to the exploration server through the channel client, fences every result and records the pages snapshotted. Tests in explore-bridge.test.ts.
- [x] 5. Runner: an exploration channel reaches nare as `--mcp-config` and an explicit `--tools` allowlist, not as environment. Tests in runner.test.ts.
- [x] 6. Plan step: the prompt names the tools and the `page`/`at` rule; `exploredGap` corrects then refuses an element not seen. Tests in plan-step.test.ts.
- [x] 7. CLI: `qare explore boot` and `qare explore serve`; `qare plan --explore`. Tests in explore-command.test.ts and plan-command.test.ts.
- [x] 8. Pipeline: the plan job's explore steps, gated on the profile; the plan step unchanged when off. Tests in workflow tests, pins updated.
- [x] 9. Docs: SPEC exploration paragraph and profile sketch, pipeline.md, a QARE no-build check in `.qa/checks`.
