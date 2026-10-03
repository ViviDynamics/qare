# ADR-0005: execute is handed the runner's docker, and the machine is the boundary

Date: 2026-10-03
Status: accepted

## Context

The pipeline's execute job runs `qare run` inside the published image. A
profile with `app.boot` boots its application with `docker compose`, so the
run has to reach a docker daemon (issue #209). Until now it could not, for
three reasons at once:

- the image carries no docker CLI and no compose plugin, and the step mounted
  only `/usr/bin/docker` from the runner;
- the run keeps the runner's uid and gid, which are not the socket's group,
  so the mounted socket could not be opened;
- the run had a network namespace of its own, so `localhost:<port>` inside it
  was not where compose published the app.

The socket was already mounted, so the intent was always that execute reaches
the daemon. It never worked, which means the run's container had, by
accident, been behaving like a sandbox. Fixing the boot removes that
accident, so the trade has to be made on purpose.

What a daemon grants: a client that can ask a docker daemon for a container
can ask for one that mounts the host's root filesystem, runs privileged, or
joins the host's namespaces. Access to the daemon is root on the machine the
daemon runs on. And the compose file the run boots is the pull request's own
file: the services, images, mounts and commands in it are pull request code.
Booting a pull request's compose stack and keeping that pull request away
from the daemon are not both possible.

## Options

| Option | What it gives | Why not |
| --- | --- | --- |
| Leave execute without a daemon | The container stays an accidental sandbox | No profile that boots an app can run, which is most applications |
| A daemon of its own inside the job (docker-in-docker) | The runner's daemon is not handed over | The inner daemon needs a privileged container, and privileged is root on the runner again. It is the same grant with more moving parts, a cold image cache on every run, and compose paths that no longer line up with the workspace |
| A rootless or user-namespaced daemon | A real reduction in what the pull request can reach | It is a property of how the runner is built, not something a workflow can switch on. GitHub-hosted runners do not offer it. A caller whose runner does gets the benefit without qare doing anything |
| Bake the docker CLI and plugins into the image | No dependence on the runner's binaries | About 180 MB on an image whose budget exists to keep it small, a client version that drifts from the daemon it talks to, and no reduction in what is granted |
| Hand the run the runner's own docker | Works wherever the runner itself can run compose | Grants the daemon, which is the point of this record |

## Decision

execute hands the run the runner's own docker, found at run time rather than
at written paths:

- the docker CLI the runner resolves on its `PATH`, mounted read-only;
- the `compose` and `buildx` plugins that CLI reports, mounted read-only
  where a docker CLI looks for them. No other plugin is passed through;
- the daemon endpoint the runner's docker context names: a unix socket is
  mounted, and the run is given the group that owns it; any other endpoint
  is passed as `DOCKER_HOST`;
- the runner's network (`--network host`).

The run still starts as the runner's uid and gid, and is never privileged.

The network model is the host's, not the compose project's. qare picks a free
port, hands it to compose as `QARE_APP_PORT`, and names the app at
`localhost:<port>`. Sharing the runner's network makes all three statements
true as written: the port is free where compose will bind it, and the health
check, command checks and browser flows reach the app where the profile says
it is. Joining the compose network instead would mean rewriting every URL a
profile and a plan carry to a service name, per project, and a browser
flavour would see a different origin than a developer does. Host networking
adds nothing to what the daemon already grants.

A suite that must run inside the booted service does it through the daemon:
`docker compose -p qare-{{run.id}} -f <compose file> exec -T <service> ...`.
The run's compose project is `qare-<run id>`, and `{{run.id}}` is that id.

The pipeline is the run's caller, so it also takes the run's compose projects
down when the run ends, with `qare reap` on the projects the evidence names.

## What this means for security

The execute container is not a sandbox, and nothing describes it as one. The
boundary is the one CONSTITUTION rule 7 already draws, the machine:

- **No secret is on it.** execute declares no secret, its checkout leaves no
  token on disk, and neither plan's model key nor judge's token is ever in
  the job. That is unchanged, and a test holds the workflow to it. Daemon
  access is not a secret and brings none.
- **On a GitHub-hosted runner** the machine is created for the job and
  destroyed after it. A pull request that takes the runner over has taken
  over a machine that holds nothing and is about to be deleted. This is the
  same position any workflow that runs a pull request's tests is in.
- **On a runner that outlives the job** the pull request can leave anything
  behind, as root. Such a runner must never also run plan, judge, or any
  other job that holds a secret: give execute a pool of its own with
  `execute-runs-on`, or use runners that are destroyed after one job. This
  was the guidance before; it is now the condition, because the socket that
  was mounted now opens.
- **Evidence integrity.** Evidence is produced by the harness (rule 4), and
  the harness runs on a machine the pull request controls for the length of
  the job. A pull request written to forge its own evidence could. That was
  already true of any command check, which runs the pull request's code as
  the user that owns the evidence directory; the daemon makes it easier, not
  newly possible. qare's verdict is a check on honest changes and a record
  for reviewers. It is not a defence against a contributor who can already
  push to the repository and edit the workflow that calls it. Pull requests
  from forks get no model key, so they never reach execute.

What would change this decision: a runner offering a daemon that does not
grant the host (rootless, or a per-job microVM) can be used today by pointing
the runner's docker context at it. qare needs no change for that, because it
reads the endpoint from the runner.

## Consequences

- A runner needs docker with the compose v2 plugin, and buildx if the stack
  builds images. A GitHub-hosted runner has all three. A runner without
  compose is named in the job summary.
- The runner's docker CLI has to run inside the image, which is Debian
  bookworm. Docker's own packages and GitHub's runners ship a CLI that does.
- Docker contexts that need client certificates (TLS over TCP) are not
  carried into the run. A unix socket or a plain TCP endpoint is.
- `examples/compose-app` is a profile that builds and boots an app. CI runs
  the pipeline's own execute steps against it (`scripts/compose-boot.sh`), so
  the path every caller gets is exercised on every change.
- On a long-lived runner each run builds its images under a fresh project
  name. The stack is taken down; the images stay until the runner prunes.
