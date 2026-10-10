# Pull and run resolved immutable images

Issue #331

## Scope

The PR and main lanes resolve their published release image once, validate
its digest, pull it by digest, and run every later container against that
same reference. Evidence retains the human-readable release tag.
Dockerfile base and package hashes are separate audit work.

## Assumptions

- Registry resolution uses Docker's buildx imagetools inspection, which
  supports both single manifests and multi-platform indexes.
- A missing inspection tool or unreadable digest stops with a named error.
  GitHub-hosted runners need no caller configuration; self-hosted runners
  must provide the tool alongside their Docker client.
- The resolved digest protects the rest of the job from tag changes; release
  immutability remains a separate administration control.

## Tasks

- [x] Add behavioral shell fixtures for all image pulls, malformed metadata,
  missing tools, immutable container references and evidence tag recording.
- [x] Resolve and validate a digest before each pull, update container readers.
- [x] Document the runner inspection requirement and its named refusal.
- [x] Run affected tests, rebase after the preceding fixes and stamp release.
- [ ] Own review, Copilot review, one QA evaluation, CI and verified publication.
