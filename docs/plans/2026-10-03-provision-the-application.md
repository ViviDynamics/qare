# Provision the application under test, not just a server

Issue #75

## The gap

Getting the application in front of a driver is three different things today,
and only one of them is a concept. A profile with `app` is booted from a
compose recipe, health checked, compared with its base and torn down. A
profile with `client` (#72) names a binary that somebody else already built
and left in the checkout: nothing installs it, nothing proves it starts before
the first check finds out, nothing provisions a build of the base, and when
it is not there the run says so in a sentence with no log behind it. A phone
application has no shape at all.

## Scope

In:

- **One provisioning lifecycle, held in code** (`provision.ts`): obtain the
  artefact (use the prebuilt one, or run the build the profile declares),
  install it, prove it is up with a health check the harness runs, hand the
  driver what to launch, and tear it down so nothing is left. The compose
  boot is the server's implementation of it and is not changed; a client
  artefact is the second; a device artefact (#73, #74) is the third, behind
  the installer seam.
- **`client.artefact` in the profile**: what kind of artefact the build is,
  where the build for each side of the comparison is, an optional build
  command for a side whose artefact is not there yet, and the executable
  inside the installed artefact. `client.executable` (#72) keeps working as it
  did: a build already in the checkout, launched in place, one side.
- **Artefacts for both sides.** `client.artefact.base` names a prebuilt build
  of the base revision. With it a client profile has a second side: the same
  plan runs against the base build first, then the head build, and the
  comparison and the regression flag are the ones a booted profile gets
  (#147). No base checkout is made when the base artefact is already there.
- **A health check per client, run by the harness**: the driver launches the
  installed build once and waits for its first window, within
  `client.health.timeout`. The server's stays the HTTP probe it is.
- **Teardown**: the install directory is the run's own, outside the checkout
  and the evidence, and it is removed when the side's checks are done, on a
  blocked provisioning and on a cancelled run. The teardown is recorded.
- **A provisioning failure is `blocked` with its log attached.** Every step
  writes to `provision.log` in the side's evidence, swept by the redaction
  rules; a blocked run's criteria are `unverified` naming the artefact and
  carry the log as evidence. A compose boot that blocks attaches its compose
  output the same way, which it never did.
- **The installer seam for devices.** An `ArtefactInstaller` is keyed by
  artefact kind and returns what was installed and how to uninstall it. The
  Electron driver ships `archive` and `directory`. The seam is exercised with
  a fake device installer in tests; nothing real installs on a device.
- The result names what was provisioned (`client.artefact`, `client.base`,
  `client.comparison`), the comment says which builds were compared, and
  `qare doctor`, `qare readiness`, `qare init`'s guidance and the docs
  describe the new shape.
- The proof on the one real non-server client there is: `examples/electron-app`
  packaged as archives for base and head, run through the pipeline's own
  execute step, locally and in CI's `electron-driver` job.

Out:

- **Building the artefact as a pipeline concern** (the issue's own "out of
  scope"). qare runs a build command the profile declares, as it runs a seed
  command; it does not know how to build anything, and it downloads nothing.
- **Fetching over the network.** The execute step holds no token and reaches
  nothing outside the declared stubs (rule 7), so a "prebuilt artefact" is a
  file the project's pipeline already put in the workspace. Downloading it is
  that pipeline's step.
- **Runner requirements and placement** (#76), **evidence beyond the
  screenshot** (#78), **device and emulator isolation** (#77), the **Android
  and iOS drivers** (#73, #74) and **egress containment of a launched build**
  (#223). The installer seam is what #73 and #74 plug into; nothing here
  starts an emulator or declares what a runner must have.
- **A client that needs a booted backend** (`app` and `client` in one
  profile). The two stay exclusive. The lifecycle is written so the two could
  be composed, but composing them changes what a flow's `open` and the run's
  isolation mean, and it is not needed to show either "done when".
- **A client profile in a several-app run.** Still refused, as in #72: the
  result of such a run names no client.

## Assumptions

- **The artefact is a path inside the repository the run checks**, for both
  sides, held to the rule `client.executable` already has: relative, no `..`,
  and what it resolves to must be inside the checkout. A pipeline that
  downloads the base build puts it in the workspace. Both sides' paths are
  read from the head profile, the one the run was configured with, like the
  base side's cost limits (#147): the base artefact embodies the base
  revision, and where the pipeline left it is the run's configuration.
- **qare cannot prove a prebuilt artefact was built from the base ref.** It
  records the path and the SHA-256 of what it installed for each side, and
  the comment names both. Which revision a file was built from is the
  pipeline's to hold.
- **`build` is a declared command, spawned with no shell**, split on
  whitespace like `commands.<name>.run`, run only when the side's artefact is
  not already there, in the tree of its side: the head checkout for the head,
  a checkout of the base revision for the base (`--base-repo`, or a worktree
  the run makes, as for a booted profile). It is told where to write through
  `QARE_ARTEFACT`. It is pull request code: on a host it gets the minimal
  environment (#91).
- **A base side problem is never the head's verdict.** A base artefact that
  is missing, will not install or does not come up leaves the base
  `not-executed` with the reason naming the artefact, `base/provision.log`
  kept, and every criterion `not-compared`. Only the head's provisioning can
  block the run.
- **The health check is the launch.** A desktop build is up when the driver
  can start it, attach, and see its first window. It costs one extra launch
  per side. A profile that still names `client.executable` gets it only when
  it declares `client.health`, so #72 profiles behave exactly as before.
- **The run tears a provisioned client down itself**, where a booted server
  is left up for the caller to inspect and stop: there is nothing to inspect
  in an install directory that the log does not already say.
- **`base` section on a client profile**: allowed once the profile names a
  base artefact, for `criteria: all | none` and `budget`. `criteria: ledger`
  reads the ledger of a base checkout, which a prebuilt base does not have,
  so it is refused by name.
- **The cache key does not carry the artefact's hash.** Like #72, the key is
  the revisions, the plan and the profile; a pipeline that produces two
  different builds from one revision should not cache.
- **Archives are tar**, unpacked by the `tar` every image and runner already
  has, into the run's install directory. A host with no `tar` blocks the run
  saying so.

## Tasks

- [ ] 1. Profile `client.artefact` and `client.health`: shape, sides, build
      command, kind per driver, path safety, exclusivity with `executable`,
      the `base` section (`profile-client.test.ts`).
- [ ] 2. The lifecycle and the installers: obtain, build when absent, install
      (`archive`, `directory`), health, teardown, the log; a fake device
      installer through the seam (`provision.test.ts`).
- [ ] 3. `bootApp` provisions a client artefact and reports what it launched;
      a legacy `executable` profile is untouched (`boot.test.ts`).
- [ ] 4. The run: flows drive the installed build, `provision.log` is written
      swept, a blocked provisioning attaches it and fails no criterion, the
      install is removed afterwards, a blocked compose boot attaches its
      output (`client-provision-run.test.ts`, `run.test.ts`).
- [ ] 5. Both sides: `client.artefact.base` gives the run a base side without
      a checkout, regressions are computed, a base that cannot be provisioned
      is `not-executed` naming the artefact (`client-provision-run.test.ts`,
      `result.test.ts`, `evidence.test.ts`).
- [ ] 6. `qare doctor`, `qare readiness`, `qare init` guidance and the CLI's
      messages name the new shape (`doctor.test.ts`, `readiness.test.ts`).
- [ ] 7. The example: archives for base and head, the provisioned profile,
      `scripts/client-provision.sh` run by the `electron-driver` job
      (`examples/test/electron-app.test.mjs`).
- [ ] 8. SPEC, schemas, pipeline and image docs.
