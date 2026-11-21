# Faster booted runs: a prebuilt base image, an opt-in build cache, ledger base criteria by default

Issue #381

## Scope

In, as three pull requests in sequence, each merged before the next:

1. Measure first. The standing report records each job's wall clock (criterion 5), and collect runs qare from the published core image instead of installing and building it from source (criterion 4).
2. The base side. A profile can name a prebuilt image for the base side (criterion 1), and `base.criteria` defaults to `ledger` (criterion 3).
3. The build cache. The execute job can opt in to a buildx layer cache that holds no secrets (criterion 2).

Out:
- A cache for any job that holds a secret or a token. #305 decided that no such job restores a cache, and nothing here changes it.
- Per-step timings. The report records jobs, which is what the issue asks for.
- Job timings for the main lane. Its record of passes goes to `passes/main.json`, not to the metrics store, so the standing report has no main lane run record to carry them. The pull request lane is where both sides are built and booted.

## Design

### 1. Each job's wall clock (criterion 5)

The publish job reads the run's own jobs from the Actions API (`actions: read`, which the caller's permission ceiling already grants) and adds them to the run's metrics record before post-evidence pushes it to `qa-assets`: `jobs: [{ name, startedAt, completedAt, wallMs }]`, for every job of this run attempt that has completed. publish and report themselves are still running, so they are not in it. The names drop the caller's prefix (`qare / execute (no secrets)` becomes `execute (no secrets)`), so every caller's report reads the same.

The merge is a short node script in the publish job (node is already set up there for the minting step), not a new CLI flag: publish runs the published image, and a flag added here would not be in the image a pull request's own run pulls until the next release.

The metrics summary reads the optional `jobs` field. The standing report gets one line per job: the median wall clock over the latest ten runs that recorded it, and over the ten before them, so a change in run time shows as two numbers side by side. A record with no `jobs` (every record before this change) counts for nothing in those lines and is still a run.

### 2. collect from the published image (criterion 4)

collect reads the version first (git, curl and jq only, which need no build), then resolves `ghcr.io/vividynamics/qare-core:<version>` to its digest and pulls it, exactly as plan does, and runs `qare linked-issues`, `qare issue-criteria` and `qare-action advisory-context` in that image. The pnpm enable, install and build steps go away. The image is the one plan, execute, judge and publish already run, so collect runs the same qare as the rest of the run.

Trust: collect still holds only the GitHub token. The image is pulled by digest from qare's own registry, never built from anything the pull request carries, and the tokens reach the container as environment variables, as publish already hands them to the same image. The pull request's body, issues and diff are data in files, as before. No cache is involved.

### 3. A prebuilt base image (criterion 1)

`base.image` in the profile names an image to run as the app's service on the base side, in place of building it. It comes from the profile (the head's profile, as `base.criteria` and `base.budget` do), never from the model, and nothing a plan says can change it. `{base}` in the reference is replaced by the full base commit, so `ghcr.io/acme/app:{base}` names the image a repository's own CI pushed for that commit. Booted profiles only: a target profile has no base side and a client profile installs its base from an artefact, so both refuse it at load.

What happens when the image does not match the base revision: the run pulls the image and reads its `org.opencontainers.image.revision` label (the label `docker/metadata-action` writes). The image is used only when that label is the base commit. When the pull fails, the label is missing, or it names another commit, the base side builds from the base tree as it always did. The result says which image the base side used: `base.image` in the run's result names the reference, the digest it resolved to, the revision label, and whether it was used, with the reason when it was not. A wrong image can never stand in for the base, and a missing one costs only the time it would have saved.

Both boot forms: for a compose boot, an override file sets the service's `image` to the pulled reference, resets its `build` (`!reset`, compose 2.24 or later) and sets `pull_policy: never`; the build step then builds only the service's dependencies. For a command boot (#379), the generated one-service project names the image in place of its `build`.

Safety: the base side cannot raise a verdict (#147: the head is the verdict source, and the base only says which head failures are regressions), and the pull request's own profile already controls what runs there (`base.criteria: none`). A pull request that names a bad base image can make its own base side less useful, never its verdict greener.

### 4. `base.criteria` defaults to `ledger` (criterion 3)

The current default is `all`: the whole plan runs at the base. `ledger` runs only the criteria the base revision's ledger carries as active.

This does make existing callers check less at the base, and the docs and the pull request say so: a criterion the base's ledger does not carry yet (every criterion a pull request introduces, and every criterion of a repository with no ledger) is no longer run at the base, so it is reported "not compared" and a head failure of it is not labelled a regression. The reason names the default and how to restore the old behaviour (`base.criteria: all`).

It must not change a criterion's outcome. A visual check and an accessibility audit are decided against the base (#143, #149), so a criterion with one of those, and a flow check when the profile's audit is standing, still runs at the base under the default, whatever the ledger carries. One run verdict can still change, and the docs say so: a waiver does not cover a regression, so a waived criterion that would have regressed failed the run under `all`, and under the default it is not compared and the run ends `waived`. An explicit `ledger` keeps its meaning unchanged. A client profile cannot read a ledger at the base, so its default stays `all`.

### 5. The opt-in build cache (criterion 2)

The pipeline input `build-cache: 'true'` gives the compose builds of execute and main_execute a buildx layer cache, stored with `actions/cache` under a key of its own.

The scope, which is what keeps it safe:
- Only main_execute saves the cache. It runs on the default branch (a push, a schedule, a manual run of main), so the cache it writes is in the default branch's scope and holds layers of code that was merged.
- A pull request's execute only restores. GitHub lets a pull request run restore caches of its own ref and of its base branch, and a pull request's run writes nothing, so no pull request reads anything another pull request wrote, and main never reads anything a pull request wrote.
- execute runs pull request code with the docker socket (ADR-0005), so it could reach the runner's runtime token and write a cache entry itself. GitHub scopes such a write to the pull request's own ref (`refs/pull/<n>/merge`), which only later runs of that same pull request restore. Main and other pull requests never see it, and a pull request poisoning its own later runs can do nothing it cannot already do with its own code; the base side it could affect cannot raise a verdict (above).
- It holds no secrets: the jobs that write and read it hold none, and the cache holds image layers built from the checkout.
- No token-holding job restores it; the #305 rule and its test stand.

How the build uses it: a pipeline step creates a `docker-container` buildx builder (the default `docker` driver cannot export a cache) and the run's container is handed it. `qare run --build-cache-from <dir> [--build-cache-to <dir>]` makes the boot read the services that build, from `docker compose config`, and write an override that adds `cache_from: type=local,src=<dir>/<service>` for each that has a cache, and on main also `cache_to: type=local,dest=<dir>/<service>,mode=max`. Compose that builds through bake needs `BUILDX_BAKE_ENTITLEMENTS_FS=0` to export outside the build context, so only the writing build (main's) is given it. The base side only reads. Off by default.

## Assumptions

- The report's two windows are ten runs each. Fewer than eleven runs that recorded a job show one median over all of them.
- `actions: read` on publish reads only this run's jobs.
- The core image of the version collect reads carries `linked-issues`, `issue-criteria` and `advisory-context` (every release since 2026.11.16 does).
- The OCI revision label is the one way an image says which commit it was built from; no label means no match.
- compose 2.24 or later on the runner for `!reset`. A compose that rejects the override fails the base boot, which is the base side's own failure and never the head's.

## Measurement

Before (15 green QARE pull request runs up to 7cff346, mean wall clock per job): collect 24s, plan 40s, execute 51s, judge 41s, publish 25s. In collect, pnpm install and build took 8 to 12 seconds; pulling the core image takes 4 to 11 seconds in the other jobs. qare's own profile is a target, so it boots nothing: the base image and the build cache are measured on the compose example CI boots, not on qare's own run.

## Tasks

PR 1:
- [x] 1. Metrics: a record may carry `jobs`; the summary and the report lines give each job's median over the latest ten runs and the ten before. Tests in metrics.test.ts and sweep.test.ts.
- [x] 2. Pipeline: publish reads the run's jobs and adds them to metrics.json before post-evidence. Test: the step script, run with curl stubbed, writes the jobs into the record; publish declares `actions: read`.
- [x] 3. Pipeline: collect pulls the core image and runs its three commands there; no pnpm install or build in collect. Workflow tests updated.
- [x] 4. Docs: pipeline.md, SPEC metrics section.

PR 2:
- [x] 5. Profile: `base.image` loads, `{base}` allowed, refused on target and client profiles. Tests in profile.test.ts.
- [x] 6. Base image: pull, read the revision label, used or not with the reason. Tests with a docker seam.
- [x] 7. Boot: a prebuilt image for both boot forms. Tests in boot.test.ts.
- [x] 8. Run: the base side uses it and records it in the result. Tests in run tests.
- [x] 9. `base.criteria` defaults to `ledger`, with the visual, a11y and standing-audit exception, client profiles `all`. Tests in the base side suites.
- [x] 10. Docs. The no-build check for the QARE self-run lands with the last pull request, the one that closes #381.

PR 3:
- [x] 11. `qare run --build-cache`: the boot's override with cache_from and cache_to. Tests in boot.test.ts.
- [x] 12. Pipeline: `build-cache` input, builder step, restore in execute, restore and save in main_execute. Workflow tests.
- [x] 13. Docs, and a no-build check for the QARE self-run (`.qa/checks/faster-runs.mjs`) covering all five criteria.
