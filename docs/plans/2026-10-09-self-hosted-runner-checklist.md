# A self-hosted runner checklist, and qare doctor checks what it can see

Issue #313

## Scope

In: one operational checklist, bounded diagnostics on self-hosted jobs,
doctor findings, and the same observations in execute evidence and summaries.
Out: provisioning runners or proving external isolation from inside a job.

## Assumptions

- GitHub-hosted callers need no extra setup; qare's own workflows stay hosted.
- The checklist recommends both ephemeral runners and a separate execute pool.
  The placement gate's recorded ephemeral alternative remains a separate decision.
- Findings name credential variables or paths, never values or file contents.
- A reachable cluster endpoint is probed without credentials, with a short timeout.
- Docker access does not prove exclusive ownership; report it as unobservable,
  and warn on a reachable remote daemon or unrelated running containers.
- Diagnostics report hazards without changing criteria verdicts.

## Tasks

- [x] 1. Add runner safety probes and doctor findings: tests for hosted no-op,
  service tokens, credential names, cluster connectivity, daemon access, and
  explicit unobservable checklist items.
- [x] 2. Capture diagnostics before code runs and preserve them through result
  loading: a real command run records the same findings in result.json and the
  evidence comment; malformed diagnostics are rejected.
- [x] 3. Publish the checklist and execute/main execute summaries: workflow
  tests hold both jobs to publishing their recorded diagnostics.
- [ ] 4. Run preflight and full gates, review, CI, merge, and verify closure.
