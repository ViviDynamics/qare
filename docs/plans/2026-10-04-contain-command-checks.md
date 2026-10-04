# Contain what a command check and a suite reach

Issue #224

## The gap

#223 closed the network gap for the build a `client` profile launches: the
build runs in a cell, a gate connects it only to the hosts the profile
declares, and what it reached is recorded. A command check and a suite still
run with whatever network their step has, and both the SPEC and
ADR-0006 say so in as many words. The step that executes pull request code is
meant to reach nothing outside the declared stubs (constitution rule 7), and
today a command check can reach anything the runner can.

## Scope

In:

- **One cell shape for a command.** A contained command check runs in a cell
  of its own, made through the docker daemon the run already holds, from the
  image the run is in (`QARE_IMAGE_REF`): a gate container and a command
  container. The command container has no network and no capability; the
  gate is the only thing it can talk to, over the socket volume the client
  cell introduced. The command is launched by the same `qare cell launch`
  the build uses, so the shim makes the socket look like a network to a
  program that knows nothing about it.

- **Reach: the app and its stubs as declared hosts through the gate.**
  The gate is handed the hosts the profile's stack declares: the booted app
  (what `{{run.target_url}}` names, on the port the run published it on) and
  each stub's declared hosts. A stub host is dialed as the compose service
  the stub names (`provided_by.compose_service`) on the compose project's
  network, with the port the connection asked for, so a stub answers on
  whatever port it listens on. A host on a target run (no stack booted) is
  the target's own. The gate carries any port on a declared host, not only
  80 and 443, because a stack publishes the app on the run's own port; the
  shim gains the interception port for it, with the scheme the profile's
  target names. An undeclared name resolves to nothing and an undeclared
  connection is refused, exactly as the client cell's gate refuses.

- **Writes: declared scratch paths.** The checkout is copied into the cell
  the way a build's directory is, and mounted read-only at the path the
  command runs from. A named command declares the paths it may write
  (`commands.<name>.scratch`, each inside the repository, validated like the
  reads #162 validate); each is a writable tmpfs mounted over the copy at
  the same path. A write anywhere else fails against the read-only copy,
  and the failure names itself in the command's output.

- **Suites run uncontained, and the evidence says so.** A suite may need
  the docker daemon (`docker compose exec` inside a booted service), and a
  cell withholds the daemon. A suite that is also contained and able to
  start containers is a privilege handed twice, so suites are not contained
  here; the suite's evidence says in as many words that it ran uncontained
  and its traffic was not recorded.

- **The opt-out is explicit and recorded.** A named command says
  `egress: uncontained` the way a client build does. The check's evidence
  then says `containment: "none"` and names it, and nothing lists hosts
  because nothing was recorded. A command that opts out and declares
  scratch is refused when the profile loads: the scratch promise is kept by
  the cell, so one without the other is a contradiction, as
  `client.hosts` beside `client.egress: uncontained` is.

- **Evidence.** A contained command check writes `outbound.json` beside its
  stdout and stderr, in the same shape the client's flow checks write:
  the command, `containment: "cell"`, the declared hosts, and what the gate
  recorded, `declared` true or false per destination. Any undeclared
  destination makes the check `refused`, naming `host:port (protocol)` with
  the words the flow path already uses, and a refusal is never cached.

- **The host is held to it before anything boots.** A profile whose named
  commands are contained requires a cell, so `requirementsOf` (`placement.ts`)
  gains that requirement and the run refuses by name on a host that cannot
  make one, before a base checkout or a compose boot, the way a contained
  client build already does.

- **The cache key names the containment.** A command check's result cached
  before commands were contained is never replayed as one that was, the way
  `CLIENT_CONTAINMENT` keeps client results apart.

- Docs: ADR-0006 ("What the same decision means for command checks and
  suites" becomes the decision itself), the SPEC's profile example, command
  check section and cell limits, `docs/schemas.md`.

Out:

- Compose services themselves: a booted stack's egress is the stubs' business
  (the issue's own exclusion).
- Containing a suite. The daemon conflict is decided, not engineered around:
  no suite starts containers from inside a cell in this change.
- macOS and Windows hosts (#90): the cell is a Linux container, and a
  non-Linux host is refused by name before anything runs.
- The client build's cell, which #223 shipped, and any change to what a flow
  check records.

## Assumptions

- Contained is the default, and the opt-out is per named command. A command
  the planner writes by hand (`run:` strings) is always contained; the
  profile's named commands are where an opt-out lives, in the diff, where a
  reviewer reads it.
- The toolchain a command needs lives in the image (`QARE_IMAGE_REF`); a
  command whose tools are not in the image fails with the image's own exit,
  named in the command's output. The pipeline's image is the flavour that
  carries the toolchain.
- The gate is qare's own code on the default bridge, as the client's gate is;
  it gains no capability and holds no secret, and its record covers every
  dial it was asked for, declared or not. The stack's app port answers the
  bridge only when the profile's compose file publishes it on more than the
  loopback (`"${QARE_APP_PORT:-3000}:3000"`, which the SPEC's isolation
  section already prescribes); a loopback-only publish is a documented limit
  that lands in the record as `unreachable`, never as silence.
- The checkout is copied per check. That is heavy and honest: a check's
  writes must never land in another check's copy, and the client cell
  already pays the same price per launch.
- `qare doctor` reports the cell requirement through the same
  `requirementsOf` the run holds a host to.

## Tasks

- [ ] 1. Profile: `egress` and `scratch` on a named command, validated
  (`contained`|`uncontained`; scratch paths inside the repository; a command
  that opts out and declares scratch is refused), with tests.
- [ ] 2. The gate carries what a command needs: a host dialed as a compose
  service (`--map`), a carried port beyond 80 and 443, and the record's
  protocol for it, with tests against a fake dial.
- [ ] 3. The shim intercepts the app's port beside 80 and 443, with the
  scheme the run hands it, with tests.
- [ ] 4. `command-cell.ts`: the cell's docker calls (gate, checkout copy,
  scratch tmpfs, no-network command container) and its removal on a
  cancelled run, tested against a fake docker.
- [ ] 5. The run: a contained command check launches in the cell, writes
  `outbound.json`, refuses on an undeclared destination naming it, records
  the opt-out, and never caches a refusal; suites record uncontained; the
  cache fingerprint names the containment. Tested with seams, as the client
  path is.
- [ ] 6. Placement: a profile with contained commands requires a cell; a run
  on a host that lacks one refuses by name before anything boots.
- [ ] 7. Docs: ADR-0006's section, the SPEC's example, limits and command
  sections, `docs/schemas.md`.
