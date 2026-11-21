# Hand the host MCP channel to nare through --mcp-config, not unread environment

Issue #399

## Scope
In: the host MCP channel (#93) reaches nare the way the exploration channel does since #377. The plan step's tool server speaks MCP Streamable HTTP, one endpoint per registered server; the runner names each in one `--mcp-config` beside the exploration bridge, and `--tools` names only the allowed tools as nare addresses them (`server__tool`). The `QARE_MCP_*` environment is gone. Calls are still recorded to `mcp-calls.jsonl`. Real nare (the core image's, in `scripts/nare-compat.mjs`) proves it.
Out: host servers for the execute step (#94), which qare's code calls directly with no model. Concurrency is unchanged: a plan given a tool channel still runs one batch at a time.

## Assumptions
- Each registered server is its own MCP alias, named by its registered name, so a model sees `rig__power_on`. nare refuses an alias outside `[A-Za-z][A-Za-z0-9_-]*` (or with `__`) and a tool name outside `[A-Za-z0-9_-]{1,64}`, so a profile whose plan-step server or tool cannot be carried is refused when it loads, by name, rather than failing inside nare.
- `--tools` is always set when a config is handed over, so nare's allow-all default for MCP tools (`mcp_allow_all=args.tools is None`) never applies. The host server also lists only the allowlisted tools, so a tool the profile did not allow is neither offered nor listed.
- Every host tool result is fenced as untrusted data, as the exploration bridge fences its own, and an errored call is an MCP error result the model can adapt to.
- The JSON-RPC handling the exploration bridge has is shared with the host server rather than written twice.

## Tasks
- [ ] 1. The runner hands host servers to nare in the MCP config, with `--tools` naming only their allowed tools, and sets no `QARE_MCP_*` variable: nare-runner tests.
- [ ] 2. The host tool server speaks MCP Streamable HTTP at one path per server, lists only allowed tools with their schemas, fences results, and records calls: mcp tests.
- [ ] 3. The plan step builds the nare channel from the registered servers and refuses names nare cannot carry; the profile refuses them at load: plan-step and profile tests.
- [ ] 4. `qare plan` with a registered server: the planner stand-in reads `--mcp-config`, speaks MCP, and its call lands in `mcp-calls.jsonl`; no server means no config and `--tools none`: plan-command tests.
- [ ] 5. Real nare in the core image is offered only the allowed host tool, calls it through the config, and cannot call one it was not offered: nare-compat.
- [ ] 6. Docs (SPEC, ADR-0012) and a QARE self-run check.
