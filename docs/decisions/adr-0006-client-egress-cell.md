# ADR-0006: a client build runs in a cell with no network, and a gate is its only way out

Date: 2026-10-03
Status: accepted

## Context

CONSTITUTION rule 7 says the step that executes pull request code reaches
nothing outside the declared stubs. That holds for what qare can see: a
booted stack's stubs, and the hosts the browser qare drives reaches on a
target run. It does not hold for a process qare starts and cannot see into
(issue #223). The build a `client` profile launches (#72) is the sharpest
case: an Electron main process opens sockets no page ever sees, so watching
the windows records nothing, and the driver said so by writing no
`outbound.json`.

Two things about where that build runs today decide what is possible.

**What the execute container can do.** It is started by the pipeline with the
runner's uid, `--network host`, the runner's docker socket, and nothing else
(ADR-0005). Measured in the web image, started as the pipeline starts it:

- `CapEff` is `0`: the process holds no capability, so no `CAP_NET_ADMIN`
  and no `CAP_SYS_ADMIN`;
- `Seccomp` is `2` (docker's default filter), and `unshare -n` and
  `unshare -Urn` are both refused with `Operation not permitted`.

So the run cannot make a network namespace for a child, with or without a
user namespace, and cannot install a packet filter. It shares the runner's
network outright.

**What an in-process hook is worth.** Chromium's proxy switches steer the
renderer's requests and nothing else. The main process is Node: `net`,
`http`, `https`, `dgram` and any native module go straight to the kernel and
honour no proxy flag and no proxy variable. A hook the build can step around
is advice, not containment.

## Options

| Option | What it gives | Why not |
| --- | --- | --- |
| Proxy flags or variables on the launched build | Records what the renderer fetches | The main process ignores them. Not containment |
| A network namespace made by the run (`unshare`, bubblewrap) | The build gets loopback only, in-process | The execute container cannot make one. It would need `CAP_SYS_ADMIN` or a seccomp profile that allows `unshare`, which hands every command check and compose service in the same container the same power. A privilege added to the place pull request code already runs, to contain pull request code |
| A packet filter on the runner (`iptables`, `nftables`) | Rules by address for the whole step | Needs `CAP_NET_ADMIN` on the runner's own network namespace, and rules by address cannot name a host: one address serves many names |
| A sibling container on a docker `--internal` network, with a proxy on it | No privilege in execute; the daemon makes the namespace | An internal bridge is not closed. Its gateway address is the docker host, and a listener on the host's `0.0.0.0` answered from inside it when measured (docker 29.7). A booted stack publishes exactly such listeners |
| A sibling container with `--network none`, and a socket to a gate | No privilege in execute; the namespace holds loopback and nothing else; no address in it leads anywhere | It needs the docker daemon, and the build runs in the image rather than beside the run. This is the decision |

## Decision

The build a `client` profile launches runs in a **cell**: a container the
runner's docker daemon starts from the image the run itself runs in, with

- `--network none`: the namespace holds a loopback interface and no route;
- `--cap-drop ALL` and `--security-opt no-new-privileges`, the run's own uid
  and gid, no docker socket, and no environment but the image's;
- a read-only copy of the directory the build is in, at its own path, and
  nothing of the machine's filesystem mounted;
- one tmpfs volume, shared with the gate, holding two unix sockets.

Beside it runs a **gate**: a second container from the same image, on
docker's default bridge, holding the profile's `client.hosts`. The gate is
the only thing the cell can talk to, over `gate.sock`, and it does two
things: it says whether a name is declared, and it connects to a declared
name on port 80 or 443 and carries the bytes. Everything else is refused.
Every request, declared or not, is counted in the gate, and the gate writes
the record when it stops.

Inside the cell a **launcher** (qare's own, the image's entry point) makes
that one way out look like a network to a program that knows nothing about
it:

- **DNS.** The cell's resolver is `127.0.0.1`. The launcher answers there:
  it asks the gate about each name, answers a declared name with
  `127.0.0.1`, and answers anything else with no such name. No query leaves
  the cell, so a lookup cannot carry data out, and the gate has recorded the
  name before the build learns it will not resolve.
- **Connections.** The launcher listens on loopback ports 80 and 443, reads
  the host a connection is for (the `Host` header, or the server name in the
  TLS client hello), and asks the gate to connect it. TLS is carried, never
  opened: the build's certificate check is against the real host.
- **The driver.** The build opens its DevTools endpoint on the cell's
  loopback. The launcher relays it to `cdp.sock`, the gate relays that to a
  port of its own, and the Electron driver attaches there: at the port
  published on the runner's loopback, or at the gate's address on the
  default bridge where a daemon publishes on a loopback the run does not
  share. The virtual display is started inside the cell.

**A copy, never a mount.** The cell is handed a copy of the directory the
build is launched from: the one its executable is in, for a build launched
in place, or the one the run installed an artefact to (#75). The copy is a
volume filled with `docker cp` through a container that is created and
never started, mounted read-only at the same path. Two reasons, either
enough. A mount of the live checkout would let a process outside the cell
(a command check, a build command) leave a unix socket in it for the build
to connect to, and a socket on a filesystem is not closed by
`--network none`; a copy carries no socket and nothing made after it was
taken. And an install lives in the run's own temporary directory, which the
daemon cannot see from inside the execute container, so it could not be
mounted at all. The health check's launch runs in a cell like a
flow check's, on both sides of a comparison. A build command is not the
build: it runs with the step's network, like any command (see below).

A host the build reaches for that the profile does not declare leaves the
flow `unverified` with `refused: undeclared host: <host>:<port> (<protocol>)`,
and the run `refused`, exactly as a target run's undeclared host does.
`outbound.json` is written into every flow check of a client run, after the
build has exited, however the flow ended.

**Fail closed.** Before any check runs, a client run is held to being able
to make a cell: a docker daemon it can reach and the image it runs in
(`QARE_IMAGE_REF`). Without either the run is `blocked`, naming what is
missing. A gate whose record does not come back leaves the flow `unverified`.

**The opt-out.** `client.egress: uncontained` launches the build as it was
launched before, beside the run, with the network the step has. The
result carries `client.egress: "uncontained"`, the comment says the build was
not contained, and each flow check's `outbound.json` says nothing was
recorded and why. It is the profile's to write and a reviewer's to see.

**No privilege is added to the execute container.** It keeps no capability,
the default seccomp filter, and no new mount. The cell is made by the daemon
ADR-0005 already hands the run.

## What this means for security

What is contained is the build: the process tree the driver launches. From
inside the cell it has no interface but loopback, no docker socket, a
read-only copy of its own directory, and no capability. Proven in CI on a hosted
runner with the real Electron example, from the main process, through both
Node and Chromium's own network stack: a declared host answers, an undeclared
name does not resolve and is named in the refusal, a raw address has no
route, and a unix socket a process outside the cell listens on in the build's
own directory is not in the cell.

What is not claimed:

- **The rest of the step.** A command check, a suite and a compose service
  still run with the network the step has, and still hold the daemon. The
  execute container is not a sandbox (ADR-0005), and this record does not
  make it one. A named command is contained since #224; a pull request that
  wants the network from anything else still can. The boundary for that
  remains the machine: no secret on it.
- **Who writes the list.** The profile is a file in the repository, so a pull
  request can add a host to `client.hosts`. The addition is in the diff and
  in `outbound.json`; containment makes reaching a host a declared act, not
  an impossible one.
- **What travels to a declared host.** The gate decides by name. The bytes
  to a declared host are the build's own, TLS included.
- **Ports and protocols.** For the build, ports 80 and 443 only, and only
  connections that name their host. Anything else has no route and is not
  recorded by name: the build sees the failure, the record does not. The
  command cell's gate carries any port a declared host answers on (#224),
  because a stack publishes the app on the run's own port, and a target
  answers on its own; the record names the protocol it saw.
- **A raw address.** It has no route, so it fails; nothing names it in the
  record, because nothing left the cell.

The launcher runs beside the build as the same user, so the build can kill
it or speak to `gate.sock` itself. Neither gets it further: policy and the
record live in the gate, on the other side of the socket, and a build with
no launcher has no network at all.

## What the same decision means for command checks and suites

#224 applies this decision to a named command. A command check is not a
program that only needs a display: it needs the repository's toolchain,
which lives in the flavour image, write access to the checkout, and the
booted stack, which a cell with no network cannot see. So its cell is
handed those through the one door it has: the toolchain is the image the
cell is made from, the checkout is copied in read-only at the path the
command runs from, with the paths it declares as scratch mounted over the
copy as writable tmpfs, and the stack arrives as declared hosts through the
gate — the app on the port the run published it, each stub dialed as the
compose service that provides it. The evidence carries the gate's record in
`outbound.json` beside the command's streams, an undeclared destination
refuses the check, a refusal is never cached, and the profile opts out with
`egress: uncontained` on the command itself. A profile whose commands run
contained requires a cell, and a host without one is refused before
anything boots.

What stays outside, and why:

- **Suites.** A suite may need the docker daemon (`docker compose exec`
  inside a booted service), which a cell withholds, and a suite that is
  both contained and able to start containers is a privilege handed twice.
  Suites run uncontained, and their evidence says so.
- **Compose services.** A booted stack's egress is the stubs' business: the
  profile declares what its checks reach, and the services keep the network
  compose gave them.
- **A build command** (`client.artefact.*.build`) runs with the step's
  network still: it runs before the build it configures, and containing it
  is #224's decision applied to named commands only.

## Consequences

- A client run needs a docker daemon and `QARE_IMAGE_REF`. The pipeline's
  execute step provides both. A run on a developer's machine either has
  them, or opts out, or is refused by name before anything is provisioned
  (since #76 the cell is one of the requirements a run holds its host to;
  it was `blocked` when this was written).
- The build runs in the image, not beside the run: it sees the image's
  libraries and environment, a read-only copy of its own directory, and a
  `/tmp` of its own. A build that writes beside its own executable, or reads
  files elsewhere in the repository, has to be told otherwise. Each launch
  copies the directory, which for an Electron build is a few hundred
  megabytes.
- A cancelled run removes its cells from the signal handler, half made ones
  included. A flow check's cache key names the containment, so a result
  cached before builds were contained is not replayed, and a refusal is
  never cached.
- The daemon must be on the machine the run is on, because the driver
  attaches to the gate over that machine's loopback or its default bridge.
  A remote daemon (`DOCKER_HOST` over TCP) leaves the flow `unverified`,
  saying the relay answered at neither.
- A runtime's own background traffic becomes visible. Electron's
  spellchecker downloads its dictionary from `redirector.gvt1.com` as soon
  as the application starts; contained, that is an undeclared host, and the
  example run was refused for it until the example gave the spellchecker no
  language (`--disable-component-update` and `--disable-background-networking`
  do not stop it). An application does that, or its profile declares the
  host.
- Each flow check costs a volume, two container starts and their removal,
  a few seconds on a hosted runner.
- The CI proof reaches `example.com`, the one declared host, over the
  internet. A hosted runner that cannot reach it fails that proof.
- macOS and Windows hosts are not covered: the cell is a Linux container
  (#90).
