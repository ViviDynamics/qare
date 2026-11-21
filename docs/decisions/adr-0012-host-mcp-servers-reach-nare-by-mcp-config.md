# ADR-0012: host MCP servers reach nare by --mcp-config, one alias per server

Date: 2026-11-21
Status: accepted

## Context

A profile registers host MCP servers (#93) the plan step's model session may look through. Until #399 the plan step served them as a plain HTTP tool server and handed nare its address as `QARE_MCP_TOOLS` and `QARE_MCP_ENDPOINT`, with `--tools none`. No nare release reads those variables, so a real session was never offered a host tool. The tests passed because the nare stand-in read the same variables.

nare already has the general capability: `--mcp-config` names Streamable HTTP or stdio servers, and `--tools` limits a run to the named tools (`alias__tool`). #377 used it for the exploration channel (ADR-0011).

The host servers are the host's, may hold state, and may need a credential, so they run where the plan step runs and never inside nare's process.

## Options

| Option | Why not, or why |
| --- | --- |
| Hand nare each host server's own command or URL in the config | nare would start or reach the host's servers itself: the calls would no longer be recorded to `mcp-calls.jsonl`, the profile's allowlist would be enforced only by `--tools`, and a credential the server needs would reach nare's process |
| One alias for every host server, tools renamed to fit under it | A model would see invented names that match neither the profile nor the server, and two servers' tools would need a renaming rule of their own |
| **The plan step's tool server speaks MCP, one endpoint per registered server, each its own alias** | Chosen |

## Decision

The plan step's tool server answers MCP Streamable HTTP on loopback, one path per registered server, and lists only the tools the profile allowed, with the schemas the server published. A call crosses to the host server through qare's own client, so it is recorded to `mcp-calls.jsonl` as before, and its result comes back fenced as untrusted data. The JSON-RPC handling is the exploration bridge's, shared (`mcp-serve.ts`).

The runner hands nare one `--mcp-config` naming the exploration bridge (when the plan explores) and each host server under its registered name, and `--tools` naming only the allowed tools, as `server__tool`.

`--tools` is always set when a config is handed over: nare offers every tool every configured server lists when `--tools` is unset (`mcp_allow_all=args.tools is None`). With it set, a tool the server lists but the run did not name is refused by nare's own policy, and a tool the profile did not allow is never listed at all.

With no registered server and no exploration, nare is handed no config and `--tools none`, as before.

The `QARE_MCP_*` variables are no longer set, and a stale one in the ambient environment is cleared.

nare refuses an alias that does not start with a letter or holds anything but letters, digits, `_` and `-` (or holds `__`), and a joined tool name past 64 characters or outside those characters. A plan-step server or tool nare cannot carry is refused by name when the profile loads, and again before any model call, rather than failing inside nare. Execute-step servers are not affected: qare's code calls their tools directly.

A plan given a tool channel still runs one batch at a time: the host servers are started once for the whole plan and may hold state.

## Consequences

- A profile with a plan-step server named, say, `device rig`, or a plan-step tool named `page.text`, now fails to load and says why. Renaming the registered server is enough for a server name; a tool name is the host's, so such a tool can only be registered for the execute step.
- `scripts/nare-compat.mjs`, which CI runs in the core image, proves the hand-off against real nare: the named tool alone is offered, with the host's schema, its call is recorded, and the other two tools never reach the host server.
- Nothing was added to nare: qare uses its existing general MCP client (constitution rules 1 and 2).
