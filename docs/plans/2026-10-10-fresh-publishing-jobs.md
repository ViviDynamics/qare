# Publish long verification runs with fresh identity tokens

Issue #306

## Scope and owner decision

Jason approved separate judge and publish jobs on 2026-10-10, with advisory
replies carried out after judging. The extra runner starts and check names
are approved. The short caller interface stays unchanged.

The PR and main judge jobs hold the model key and no App key. Fresh publish
jobs mint first, before artifacts or containers, then publish the recorded
result. Failure reporting names the new publishing boundary.

## Assumptions

- A recorded verdict is still published when a preceding job is red; no
  missing or unread result is shown as evaluated or healthy.
- The publishing token's lifetime starts after verification completes.
- Already recorded advisory dismissals remain reviewer context. Reading
  that context is separate from acting on new replies; new replies are
  carried out in publishing after judging.
- Downloaded data remains in dedicated directories alongside the trusted
  checkout. Existing single-use key minting and immutable image rules hold.

## Tasks

- [x] Add failing workflow fixtures for key separation, fresh mint order,
  long judging, result propagation and failure reporting.
- [x] Preserve recorded advisory context through a read-only collection path;
  act on new replies only after judging.
- [x] Split PR judge and publishing; carry evidence, metrics and recorded result.
- [x] Split main judge and publishing; preserve findings and pass recording.
- [ ] Update check lists, docs and affected tests; final rebase and release stamp.
- [ ] Own review, Copilot review, one QA evaluation and verified publication.
