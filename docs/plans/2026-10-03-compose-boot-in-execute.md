# The execute step cannot boot a compose app from inside the run image

Issue #209

## Scope

In:

- `.github/workflows/pipeline.yml`, execute: a step that finds the runner's
  docker (CLI, compose and buildx plugins, daemon endpoint and its group)
  and hands it to the run, on the runner's network; a step that takes the
  run's compose projects down afterwards.
- `examples/compose-app`: a profile that builds and boots an app with
  compose, with a plan that checks it from beside qare and from inside the
  booted service.
- `scripts/run-pipeline-step.mjs` and `scripts/compose-boot.sh`: run the
  pipeline's own execute steps against that example. A `compose-boot` job in
  CI does it on every change, in the core image built from the tree.
- `docs/decisions/adr-0005-execute-docker-access.md`: the security trade and
  the network model. `docs/pipeline.md`: what a runner needs, and how a
  profile that boots is written.
- Version bump to 2026.10.3, so callers can pin a tag that carries the fix.

Out:

- Moving dettmore-platform onto the reusable workflow (dettmore-platform#810).
- The image: nothing is added to it. The docker client comes from the runner.
- `defaultRunCompose` spawning `docker -f ...` without `compose`: fixed in
  #110, before 2026.10.1, with a test that pins what the default runner
  spawns. The note in dettmore's vendored workflow is stale.

## Assumptions

- The runner that execute lands on can itself run `docker compose`. The run
  gets exactly that docker and no other.
- The trust boundary is the machine (rule 7), not the run's container. The
  ADR says why nothing narrower is on offer.
- Host networking, because qare names the app at `localhost:<port>` and
  picks the port by binding it.
- qare's own pipeline pulls the image of the base revision's version, so the
  fix must work with an image that is already published. It does: the change
  is in the workflow.

## Tasks

- [x] 1. execute hands the run the runner's docker: `workflow.test.ts` holds
      the step to found paths, the socket's group, the host network, and no
      secret.
- [x] 2. execute takes the run's compose projects down: `workflow.test.ts`
      holds the step to the projects the evidence names.
- [x] 3. The example profile and plan load, and the steps CI runs are the
      pipeline's own: `examples/test/compose-app.test.mjs`.
- [x] 4. A real boot in CI: the `compose-boot` job fails unless the app
      booted, both checks passed against it, and the stack was taken down.
- [x] 5. The decision and the caller's guide.
- [x] 6. Version 2026.10.3.
