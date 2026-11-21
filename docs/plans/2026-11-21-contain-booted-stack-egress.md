# Contain a booted stack's egress, or record that it ran uncontained

Issue #382

## Scope
In:
- A booted stack (a compose boot, and a command boot, which is a generated one-service compose project) runs on networks that are all `internal: true`. Its only external routes are the declared stubs, which are services of the same stack.
- A DNS sink (`qare cell egress-dns`) on the stack's internal network, run from the image the run is in (`QARE_IMAGE_REF`). Every service of the stack resolves through it (`dns:`): a declared stub host is answered with the address of the compose service that provides it, wildcards included; any other name is answered NXDOMAIN and recorded.
- A relay (`qare cell egress-relay`) that publishes the stack's published tcp ports on the runner's loopback and forwards them to the services inside: the health check, the checks, the explorer and a contained command's gate reach the app exactly as before.
- The record read back in code (`compose logs` of the sink, parsed and validated) after each side's checks, for the head and the base, and for each app of a several-profile run.
- `result.json` carries `egress` (and `base.egress`): contained or not, why not, the declared hosts the stack looked up, and the undeclared ones. The evidence comment lists every undeclared host, and says in as many words when a stack's egress was not contained.
- An undeclared host refuses the run (`refused: missing stub: <host>:unknown (dns)`), whichever side looked it up, and the stub issue step files it like any other missing stub.
- `stopApp` and `qare reap` take the sink, the relay, the new networks and the override files down with the project.
- A target run and a run whose stack cannot be contained (no `QARE_IMAGE_REF`, host networking, an external network, a published udp port) say that its egress was not contained, and why.
- CI: examples/compose-app, examples/command-app and examples/mail-app boot contained; a new example, examples/egress-app, proves that an undeclared host is blocked and listed.

Out:
- A connection to a literal IP address, with no name looked up, is blocked by the internal network but not recorded: there is no name to record. The docs say so.
- A profile key to opt a stack out of containment: not asked for, and it would weaken the rule the owner chose.

## Assumptions
- The verdict is decided by the SPEC already (principle 5, execute stage 4): a host outside the stub map is a `refused: missing stub` finding. So an undeclared lookup refuses the run; it is not recorded only. Both sides count, because stubs merge first so the base boots against them too.
- An undeclared host is recorded on the lookup, the first thing any client does with a name, and answered NXDOMAIN so the app fails fast rather than hanging on a connect that cannot route.
- Docker's embedded DNS forwards a name it does not own to the servers in `dns:`, and does so for a container on an internal network when that server is on the same network (checked against docker 29). Published ports are dropped on an internal network, hence the relay.
- The sink's address is known only once it is up, so the sink starts first and prints its address; the second override carries `dns:` for every service.
- A record the run cannot read (the sink died, its log is not JSON) is a run that cannot say what the stack reached: the run is blocked, never passed (rule 6).
- The sink and the relay run beside pull request code, so nothing the stack sends them is trusted: names are held to being names, and the record is capped.

## Tasks
- [ ] 1. core `stack-egress.ts`: the containment plan from `compose config` (networks internal, services joined to the contained network, ports moved to the relay) and the reasons a stack cannot be contained: unit tests on config fixtures.
- [ ] 2. core `egress-sink.ts`: the DNS sink (declared answered, undeclared NXDOMAIN and recorded once, capped) and the tcp relay: tests with real sockets.
- [ ] 3. CLI `qare cell egress-dns` and `qare cell egress-relay`: dispatcher test.
- [ ] 4. boot: `bootApp` contains the stack when an image is named and reports how, `stopApp` downs it with its overrides, reap removes the files: boot tests with a recorded compose runner.
- [ ] 5. command cell: the gate joins the stack's contained network when there is one: test.
- [ ] 6. run: the record read after each side, `result.egress` and `base.egress`, the verdict refused or blocked, result parsing: run tests.
- [ ] 7. comment and stub issues: the egress lines, undeclared hosts listed, "not contained" stated; missing stubs read from `egress`: tests.
- [ ] 8. examples/egress-app and CI: a stack whose app looks up an undeclared host is refused, with the host listed; the existing example boots still pass.
- [ ] 9. docs: SPEC and pipeline.md describe containment, the record and its limits.
