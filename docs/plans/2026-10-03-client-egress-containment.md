# Egress for a process the run starts: contain what a client build reaches

Issue #223

## Scope

In:

- The decision on where containment lives for a process the run starts,
  recorded as `docs/decisions/adr-0006-client-egress-cell.md`.
- A cell for the build a `client` profile launches: a container the runner's
  docker daemon starts with no network but loopback, with one way out, a
  socket to a gate that connects only to the hosts the profile declares.
- `client.hosts` in the profile, the way `target.hosts` reads, and
  `client.egress: uncontained` as the explicit opt-out.
- `outbound.json` in every flow check of a client run, written however the
  flow ended, and a run that is `refused` naming the host when the build
  reached for one the profile does not declare.
- Fail closed: a host that cannot set the cell up blocks a client run by
  name before any check runs.
- Proof on a GitHub-hosted runner, in the `electron-driver` CI job, with the
  real Electron example: a declared host allowed and recorded, an undeclared
  one refused by name, a raw address with no route, and the opt-out saying so.
- What the decision means for command checks and suites, said in the ADR and
  the SPEC, with a follow-up issue for doing it.

Out:

- Containing command checks and suites. They need the repository's own
  toolchain and the booted stack on the runner's loopback, which the cell
  does not carry. Follow-up issue, not this change.
- Provisioning the build (#75) and where a run may be placed (#76).
- Ports other than 80 and 443, and protocols that name no host (the gate
  reads the name from the TLS client hello or the HTTP `Host` header).
- macOS and Windows hosts (#90): the cell is a Linux container.

## Assumptions

- The execute container has no capability, runs under docker's default
  seccomp profile and cannot make a namespace (`unshare` is refused). It does
  hold the runner's docker daemon (ADR-0005). So the cell is a sibling
  container the daemon starts, and execute gains no privilege.
- A docker `--internal` bridge is not containment: its gateway address is the
  docker host, and anything the host listens on is reachable. Measured, not
  assumed. The cell uses `--network none`.
- The cell and the gate run the image the run itself runs in
  (`QARE_IMAGE_REF`), so the launcher and the gate are the run's own qare.
- The repository is mounted into the cell read-only at its own path, which
  the pipeline already guarantees lines up with the daemon's (ADR-0005).
- DNS inside the cell is answered on loopback by the launcher, which asks the
  gate. A declared name resolves to loopback, where the launcher forwards
  ports 80 and 443 to the gate; an undeclared name does not resolve and the
  gate records the lookup. No query leaves the cell.
- The gate is the only place policy is decided and the only source of the
  record. Everything inside the cell runs beside pull request code and is
  trusted with nothing.
- The profile schema change stays small and additive (`hosts`, `egress`),
  because #75 is reworking the `client` section in parallel.
- No version bump.

## Tasks

- [x] 1. Plan and ADR-0006.
- [ ] 2. Profile: `client.hosts` and `client.egress` parse and are refused by
      field when malformed (`profile-client.test.ts`).
- [ ] 3. Wire formats: a DNS question is read and answered, the server name is
      read from a TLS client hello and the host from an HTTP request
      (`cell-wire.test.ts`).
- [ ] 4. The gate: a declared host is connected and recorded, an undeclared
      one is refused and recorded, a lookup is answered, and the summary is
      written when it stops (`cell-gate.test.ts`, over real sockets).
- [ ] 5. The launcher's shim: DNS on loopback, ports 80 and 443 forwarded to
      the gate by name, the DevTools endpoint relayed (`cell-shim.test.ts`).
- [ ] 6. The cell: the docker calls that make it, what it refuses to start
      without, the record it reads back, and its teardown
      (`client-cell.test.ts`, docker stood in).
- [ ] 7. The driver launches through a cell when handed one
      (`flow-electron.test.ts`).
- [ ] 8. The run: blocked by name when the cell cannot be set up,
      `outbound.json` in every client flow check, `refused` naming an
      undeclared host, the opt-out recorded, the result and the comment saying
      which (`client-run.test.ts`, `result.test.ts`, `evidence.test.ts`).
- [ ] 9. CLI: `qare cell gate` and `qare cell launch`
      (`packages/cli/test/cell.test.ts`).
- [ ] 10. The example and the CI proof: `scripts/electron-driver.sh` runs the
      declared, undeclared and opted-out profiles through the pipeline's own
      execute step.
- [ ] 11. SPEC, pipeline guide, schemas; follow-up issue for command checks
      and suites.
