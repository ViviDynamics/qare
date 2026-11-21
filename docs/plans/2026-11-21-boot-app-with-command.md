# Boot an app with a command, not only compose

Issue #379

## Scope

In:
- A profile may declare `app.boot: { command, image, port }` (and the optional `build: { timeout }` a compose boot takes) in place of `{ compose, service }`.
- The run boots it under the run's own compose project, `qare-<run id>`, published on the run's allocated port, so health, seed, flows, suites, command checks, the base side, cancellation and `qare reap` work as they do for compose.
- `qare readiness` accepts the command form and does not ask for a compose file it does not need.
- `qare init` writes the command form when the repository has no compose file but has a start script (`scripts.start` in package.json).
- An example, `examples/command-app`, that CI boots for real through the pipeline's execute steps, the way it boots `examples/compose-app`.

Out:
- Stubs on a command boot. A stub is provided by a compose service beside the app, and a command boot has one service, so the loader refuses a command boot with stubs and names the compose form. Not asked for by the issue.
- A start script other than package.json's (Procfile, `bin/rails`, `go run`). The profile form takes any command; only init's detection is limited, and a person can write the profile by hand.

## Design

The command form is turned into a one-service compose project at boot time, not run by a second process manager. The boot writes a compose file for the run (in the temp directory, named for the run's project) and from there everything is the compose boot that already exists:

- the project is `qare-<run id>`, so concurrent runs never share a project, network or container, and `qare reap` finds and downs it with `-p` alone, as it already does;
- the service publishes `127.0.0.1:${QARE_APP_PORT}:<port>`, so the run's allocated port, `{{run.app_port}}` and the pinned health URL work unchanged;
- the image is built by the existing build step under `app.boot.build.timeout`: a `dockerfile_inline` of `FROM <image>`, `COPY . /app`, `WORKDIR /app`, with the side's checkout as the context (the head's, or the base tree's on the base side), so the app is the pull request's own code and the repository's `.dockerignore` applies;
- the service runs `sh -c <command>` with `PORT=<port>` in its environment, so `npm start` style apps that read `PORT` listen where the port is published;
- a seed or suite reaches the service as `docker compose -p qare-{{run.id}} exec -T app ...`, which compose resolves from the project name alone, so no file path is needed in the profile;
- a contained command check finds the project's network and the container publishing the run's port by compose labels, as it does for compose;
- the stop downs the project by `-p` with `--volumes` and removes the generated file.

Why not a parallel `docker run` path: it would need its own naming, port publishing, log capture, cancellation, reap discovery and cell wiring, each of which compose already has and is tested for. Generating the project keeps one boot path.

## Safety

The image, command and port come from the profile (repository configuration reviewed like code), never from a model. Nothing a model plans can change them, and no check kind gains anything it could run. The boot runs where a compose boot runs, in the contained execute job that holds no secrets: the generated service gets `PORT` and nothing from the job's environment, and the checkout is copied into the image rather than mounted, so the app cannot write to the runner's workspace. A literal `$` in the command, image or path is escaped for compose, so compose interpolates nothing but the run's own `QARE_APP_PORT`.

## Assumptions

- The service is named `app`. The checkout lands at `/app`, and the command runs there.
- The image must carry `sh` (the command is a shell line, as a Procfile line is).
- `port` is an integer from 1 to 65535: the port the app listens on inside the container.
- `image` is a non-empty string with no whitespace.
- The generated file lives in the OS temp directory as `<project>.compose.json`; compose reads JSON as YAML.
- init's image and port are guesses (`node:22`, 3000) marked with `TODO(qare init):` lines, which readiness reports until a person confirms them; its command installs dependencies by the lockfile it finds, then runs `npm start`.

## Tasks

- [x] 1. Profile: `app.boot` takes `{ command, image, port, build? }` or `{ compose, service, build? }`, refuses a mix, a bad port or image, and stubs on a command boot. Tests in profile.test.ts.
- [x] 2. Boot: `bootApp` writes the project file, builds, ups and health checks the command boot; `stopApp` downs it by project and removes the file. Tests in boot.test.ts with the compose seam, including `$` escaping and the base tree as context.
- [x] 3. Run wiring: the base side keeps the base tree as the command boot's context, a shard boot passes its root, readiness skips the compose file for a command boot. Tests in run and readiness suites.
- [x] 4. Example and CI: `examples/command-app` and the compose-boot job booting it through the execute steps (scripts/compose-boot.sh takes the example). Test: workflow test names the example; CI boots it.
- [x] 5. init: the command form when there is no compose file but there is a start script. Tests in init.test.ts.
- [x] 6. Docs: SPEC profile sketch and run isolation, pipeline.md.
