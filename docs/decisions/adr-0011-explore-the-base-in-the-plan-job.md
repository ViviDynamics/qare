# ADR-0011: the plan job boots the base app to explore it, and the steps that run it hold nothing

Date: 2026-11-21
Status: accepted

## Context

The exploration channel (#87) lets the planner look at the running app before
it names the elements a flow acts on: a browser and a small tool server run
beside the app, and only tool calls and their results reach the model
session. Until #377 nothing in the pipeline reached it, so flow selectors were
guessed from the diff and QA.md.

The pipeline splits jobs by credential (constitution rule 7). plan holds the
model key and checks out only the base revision; execute runs the pull
request's code and holds no secret. Exploring means a model session steering
a browser through a running app, and the session has to be in the job with the
key. So the question is which app may run in that job, and with what access.

#87 settled the first part: exploring the head needs the sandbox split,
because the head is pull request code, and exploring the merge base or a
deployed target does not, because no pull request code is beside the app.

## Options

| Option | Why not, or why |
| --- | --- |
| Explore the head in execute and plan from there | execute holds no key by design, and a model session needs one. This is the sandbox split #87 describes, and it is not what #377 asks for |
| A separate no-secrets job that serves the base app to plan over the network | Jobs on GitHub-hosted runners are separate machines with no network path between them. A tunnel would be a new external service on the path of every tool call |
| Boot the base app in the plan job, in the planner's own container | The process that holds the key would also hold the runner's docker, and with it every container on the machine |
| **Boot the base app in the plan job, in steps of their own that hold nothing** | Chosen |

## Decision

A profile opts in with `explore: base`. Absent or off, the plan job is what it
was. On, the plan job runs four extra steps around the plan step:

1. **Boot.** `qare explore boot` in the web image, handed the runner's docker
   as execute is (ADR-0005), builds the base app from the base checkout, seeds
   it and exits, leaving it up. It never uses the prebuilt base image (#381):
   that image is trusted by its revision label, and a label is whatever its
   pusher wrote. In execute, which holds nothing, the label check is enough;
   beside the key it is not, because a registry the pull request's own CI can
   push to would put pull request code on the machine that holds the key. The
   build cache is not read either.
2. **Serve.** `qare explore serve` in the web image, on the runner's network,
   with no docker access and nothing mounted but the directory its ready file
   lands in: the browser and the exploration server. Navigation is held to the
   booted app's origin, so a prompt injected through the diff cannot point the
   browser at the runner's metadata service or another port.
3. **Plan.** The plan step gains `--network host` and `--explore <endpoint>`,
   and nothing else. Inside it, a bridge on loopback speaks MCP to nare
   (`--mcp-config`, with `--tools` naming only the channel's tools) and makes
   each call across the channel with the channel's own client, fencing every
   result as untrusted data and recording each page it snapshotted.
4. **Teardown.** The serve container is removed and the boot's compose project
   reaped, whatever the plan did.

None of these steps names a secret, and the boot and serve steps run before the
plan step writes the key file. While the key exists, the only process qare
started that has the runner's docker has already exited.

The model plans and code decides: every element a planned flow names must
carry the page it was read from and its path in that page's snapshot, and both
must be ones the bridge recorded. Anything else is corrected once and then
refused, like any other plan gap.

A boot, seed or serve that fails stops the plan job by name (rule 6): the
profile asked for flows planned against the app, and a plan written blind is
not that.

## Consequences

- The base revision's own containers (its compose services, built from its own
  tree) run on the machine while the plan step holds the key. That is code the
  repository already merged, the same trust the plan job already places in the
  base checkout's profile and QA.md. A profile whose base compose file reaches
  for something a pull request can write, a mutable image tag its CI pushes for
  instance, should not turn exploration on. pipeline.md says so.
- The plan job needs docker compose on the runner when a profile explores, as
  execute does when a profile boots an app.
- `capture` is not served over the bridge: nare hands an MCP result to the
  model as text, so a screenshot would arrive as a base64 string the size of
  the page.
- The host MCP channel (#93) still reaches nare as environment no nare release
  reads. That is its own follow-up, not this decision. #399 closed it the same
  way; ADR-0012 records how.
