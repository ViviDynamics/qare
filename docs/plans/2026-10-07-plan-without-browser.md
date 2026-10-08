# The planner plans browser flows for a profile whose image has no browser

Issue #258

## Scope
In: the plan step learns the profile's flavour. A profile whose checks would
run on the browser driver, and whose flavour ships no browser, is planned with
suites, commands and mail only; a plan that still holds a browser check is
corrected once and then refused, naming the flavour and the setting that
changes it. The plan step hands the planner the profile's own suites, with
their commands, which it never did. docs/pipeline.md says which checks each
flavour runs.

Out: `qare check` and ledger ingest, which plan outside the pipeline's images
and keep the driver they had. Checking that a suite a plan names exists, which
the run already reports.

## Assumptions
- A flavour ships a browser or it does not: `web` does, `core` does not, and a
  profile that names none runs in `core`, as the pipeline's execute job reads it.
- A profile that names a client (electron) or maps an MCP driver plans against
  that driver, whatever its flavour: the driver is not the image's browser.
- With no profile loaded there is no flavour to read, and the plan step keeps
  the browser driver it assumed before.
- A flow check that names a suite needs no browser of qare's: the suite's
  command brings its own. It stays plannable, and is the only flow offered.
- The refusal is the plan step's usual one: one correction round, then every
  criterion unplannable with the reason, and the pipeline's later jobs report it.

## Tasks
- [x] 1. `browserlessFlavour(profile)` names the flavour when the browser driver has no browser to drive: core/test/plan-browserless.test.ts
- [x] 2. The planner is offered no action flow, visual or a11y check for it, and is told to use suites and commands: same file
- [x] 3. A plan holding a browser check is corrected, then refused, naming the flavour and `flavour: web`: same file
- [x] 4. `qare plan` reads the flavour and the suites from the profile: cli/test/plan-command.test.ts
- [x] 5. docs/pipeline.md lists the checks each flavour runs; release 2026.10.21 stamped
