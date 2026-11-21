# A service that exits during boot leaves no log in the evidence

Issue #407

## Scope

In:

- When a booted stack does not come up (compose up fails, the watchdog fires, the
  health check does not pass, a containment step blocks the boot) or its seed fails,
  the run reads every service's state from `compose ps -a` and its last 200 log lines
  from `compose logs --tail 200`, before anything takes the stack down.
- Each service's log is written, redacted by the run's rules, to
  `<side>/services/<service>.log`.
- The result records the boot failure: each service with its state, exit code and
  health, the path of its log, and for each service that failed the last 20 redacted
  lines. The base side's is carried into `base.boot`.
- When the stack was contained, the resolver's record is read on a failed boot too,
  saved in the result's `egress` (and `base.egress`), and summarized in the comment.
- The comment names each service that failed, its exit code, and at most 20 redacted
  lines of its log.
- `examples/crash-app`: a contained service that looks up a name no stub declares,
  prints a known line and exits 1. `scripts/crash-boot.sh` boots it in CI's
  compose-boot job through the pipeline's execute steps and asserts the evidence and
  the comment.

Out:

- A several-app run (`profiles`) keeps its own per-app provisioning logs and does not
  get the services section: no criterion asks for it, and its comment groups by app.
- The verdict of a failed boot stays `blocked`: what the resolver refused is recorded
  and shown, and decides nothing more than it did before.

## Assumptions

- `docker compose -p <project> ps -a` and `logs` address a project by name alone, as
  `readStackEgress` already does, so the capture needs no compose file.
- The run's own resolver and relay are left out of the services: the resolver's log is
  the egress record, read on its own.

## Tasks

- [x] 1. `captureServiceLogs` and `failedServices` in boot.ts: tests over a stub
  compose for NDJSON and array `ps` output, the tail argument, the run's own services
  left out, and a call that never settles bounded.
- [x] 2. `bootApp` captures services and the resolver record on every failure path:
  tests for compose up exited, health, watchdog, and a contained boot that failed.
- [x] 3. The run writes `services/<service>.log`, records `boot` and `egress` on a
  blocked boot and a failed seed, and the base side carries both: run tests.
- [x] 4. result.ts parses `boot` and `base.boot`; redactResult sweeps the tails: tests.
- [x] 5. The comment names the failing service, its exit code and its last lines, and
  the names a contained stack looked up before it failed: evidence tests.
- [x] 6. `examples/crash-app` and `scripts/crash-boot.sh` in the compose-boot job.
