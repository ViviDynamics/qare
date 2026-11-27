# First-run setup from a QAre release

Issues #434 and #436

## Scope

Publish an installer with each GitHub release, document a direct Docker alternative
and provide a setup prompt that an agent can run in the target checkout.

## Assumptions

- The installer carries its own release tag. The matching image already uses its
  stamped CLI version when it writes a workflow.
- Init owns boot detection and preserves existing files. Readiness owns the list
  of app-specific decisions. Repository secrets are set privately by the operator.

## Tasks

- [x] Exercise a fresh checkout and repeat setup, credential guidance, and Docker failures.
- [x] Stamp and publish the installer with the release that built its image.
- [x] Verify the README and quickstart commands on a fresh sample.
