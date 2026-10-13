# Verify the mail regressions from the self-run checkout

Issue #290, PR #339

## Scope
In: executable source checks for both mail regressions in the published image, and profile instructions that select them instead of a Wikipedia flow.
Out: replacing the self-run profile, changing CI verdict policy, or installing a build toolchain in the image.

## Assumptions
- The published Node 22.23 runtime supports native TypeScript transformation and module hooks.
- Source imports use the checkout's modules, with only the shipped production YAML dependency supplied by the image when the checkout has none.
- Controlled mail and boot adapters exercise runJob without a network, Docker, a real mailbox, a model, or credentials.

## Tasks
- [x] 1. Add executable checks and integration tests; demonstrate both regressions against pre-fix source and successful execution against the changed source.
- [x] 2. Declare the commands and explain the target boundary at the beginning of QA.md, inside the planner's size cap.
- [x] 3. Test both checks in the exact published image with no network or node_modules. The old source fails both checks; the changed source passes both.

## Shipping verification
Full preflight and current-head QARE must pass before merge. The QA run must exercise both source checks and publish observed parser and message evidence.
