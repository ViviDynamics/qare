# Ship the pipeline as a reusable workflow, so each repository calls it in ten lines

Issue #145

## Scope

In:

- `.github/workflows/pipeline.yml`: the collect, plan, execute, judge, report
  and requeue jobs, moved out of `qare.yml` unchanged in what they do, behind
  `on: workflow_call` with typed inputs and one named secret.
- `.github/workflows/qare.yml` becomes a caller of it (`uses:
  ./.github/workflows/pipeline.yml`), so qare runs the pipeline it ships.
- The caller interface: `runs-on`, `execute-runs-on`, `profile`,
  `nare-provider`, `nare-base-url`, `nare-model`, `model-key-env`,
  `planner-diff-exclude`, `qare-ref`; secret `model-key`.
- From review: execute and plan leave no checkout token on disk, the model
  key goes to its container in a file and never into the step's shell,
  execute can have runners of its own, and the failure report places the
  pipeline by the calling job its own report job sits under.
- A release pin: `qare-ref` defaults to the release the workflow file ships
  in, held to `package.json` by a test and stamped by `scripts/sync-version.mjs`,
  so a caller pins one tag in `uses:` and upgrading is that one line.
- Version bump to 2026.10.2, so a tag exists that carries the workflow.
- `report-failure` recognises pipeline jobs under a caller's job name
  (`qare / plan (model key only)`), which is how a called workflow's jobs are
  listed.
- `requeue --profile <dir>`, so a caller whose profile is not `.qa` is
  re-queued from its own stub registry.
- `docs/pipeline.md` (caller workflow, permissions, secrets, upgrading) and a
  SPEC subsection.

Out:

- Moving dettmore-platform onto it (its own issue, dettmore-platform#810).
- A Marketplace listing.
- The sweep workflow: it is a schedule, not part of the pull request pipeline.
- Booting a compose app from inside the run image. Probing the published
  core image shows the execute step's container has no `docker compose` and
  cannot open the mounted socket as the runner's user. That is an image and
  execute-step gap that predates this change, qare's own profile boots
  nothing so nothing here can prove a fix, and #147 is reworking execute.
  Filed separately.

## Assumptions

- A called workflow cannot learn its own ref from the `github` context
  (`github.workflow_ref` names the caller), so the release is written into
  the file as the default of `qare-ref` rather than discovered at run time.
- qare itself passes `qare-ref: base sha` (or the pushed sha on push), which
  keeps today's rule: every token-holding job builds qare from a revision the
  pull request cannot change, and the images are the base revision's version.
- Token-only jobs (collect, report, requeue) keep building qare from source,
  now from a checkout of `ViviDynamics/qare` at `qare-ref` under
  `.qare-pipeline/`. For qare that is the base commit, as today; for a caller
  it is the pinned release. One path for both, so qare runs what it ships.
- collect reads the version from that checkout and hands it to plan, execute
  and judge as a job output, so no image job reads a version from any tree.
- `runs-on` is a JSON string (`'"ubuntu-latest"'` by default, or a label
  list), because a `workflow_call` input cannot be a list. qare's own caller
  never sets it: qare is public and runs on GitHub-hosted runners only.
- The model key arrives as the secret `model-key` and is exported under the
  name `model-key-env` gives (default `OPENAI_API_KEY`). It is optional at the
  interface, because a fork pull request has none, and the plan and judge
  steps fail closed naming it when it is empty.
- The caller grants the permission ceiling on its calling job; each called
  job still declares only what it needs, and the called workflow defaults to
  `contents: read`.
- judge's metrics step ran `node packages/cli/dist/index.js` in a job that
  never builds, which cannot work in a caller's repository at all. It runs
  the image's `qare metrics record` now.
- requeue gains `contents: read`: a private caller's checkout needs it.

## Tasks

- [x] 1. `classifyPipelineFailure` matches a job listed under a caller's job
  name: a test with `qare / plan (model key only)` in a `plan` pipeline.
- [x] 2. `requeue --profile`: a test that the stub diff is read under the
  given profile path.
- [x] 3. `pipeline.yml` is the reusable workflow and holds the pipeline: the
  structural tests read it, and a new test holds its `workflow_call`
  interface (inputs, defaults, the one secret).
- [x] 4. `qare.yml` is a caller: a test holds its `with` and `secrets` to the
  declared interface, refuses `secrets: inherit` and a `runs-on`, and checks
  the permission ceiling covers every called job.
- [x] 5. Secret boundaries and fail closed: the model key reaches only the
  planner and verifier steps, and nothing is `continue-on-error`.
- [x] 6. The release pin: `qare-ref` defaults to `package.json`'s version,
  `sync-version` stamps it, version 2026.10.2.
- [x] 7. Documentation: `docs/pipeline.md`, SPEC subsection, and a test that
  holds the documented caller to the interface and the pinned release.
