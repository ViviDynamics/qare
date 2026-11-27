# A flow cannot assert the URL it landed on

Issue #430

## Scope
In: a flow action `assertUrl` that asserts the path the page is at, and optionally
query parameters, judged in the harness's own code from the URL the driver reports.
The observed URL goes in the check's action log, and in the reason when the assertion
fails. The browser driver declares it, the planner is offered it and told to use it
for a criterion that names where a step lands, and the plan loader validates its shape.
Out: the Electron driver and MCP driver mappings. An Electron window's URL is a
`file:` or app URL whose path is not the path `open` takes, so mapping it back is
its own change. An MCP mapping would need a tool that reports the URL. Both drivers
leave `assertUrl` undeclared, so a plan naming it against them is refused at load,
naming the driver, as for any other undeclared action.

## Assumptions
- Shape: `{"action":"assertUrl","path":"/dashboard"}`, with an optional
  `"query":{"tab":"billing"}`. The path starts with `/` and carries no `?` or `#`.
  Query parameters are a subset match: each named one must be present with that
  value, and others may be there too.
- Paths are compared after URL parsing on both sides, so percent-encoding matches.
  One trailing slash is ignored (`/dashboard` and `/dashboard/` are the same
  landing), except for the root path.
- A redirect is waited out: the harness re-reads the URL until it matches or five
  seconds pass, as the text and element assertions do (#236). It fails with the last
  URL it read.
- A driver that cannot report its URL, or a read that throws, leaves the check
  unverified, never failed.
- On a target run, an asserted path resolves below the target URL the way an `open`
  path does, so `/dashboard` on a target at `/app/` asserts `/app/dashboard`.
- Run values (`{{...}}`) may appear in the path and the query values, like other flow
  strings.

## Tasks
- [x] 1. The plan loader parses `assertUrl` and refuses a bad path or query: plan tests.
- [x] 2. `runFlowCheck` judges the path and query from the driver's `url` seam, waits
  out a redirect, records the observed URL, and fails or stays unverified as
  above: flow tests for a matching path, a mismatched path and a redirect.
- [x] 3. The browser driver declares `assertUrl` and reports `page.url()`: driver tests.
- [x] 4. The planner is offered `assertUrl` and told when to use it: plan-step tests.
- [x] 5. Target runs resolve the asserted path below the target, and run values
  substitute into it: run tests.
- [x] 6. Docs: SPEC, schemas.
