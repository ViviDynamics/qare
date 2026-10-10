# Validate workflow outputs and isolate judge downloads

Issue #329

## Scope

Validate the two collect version outputs and the four executed-verdict outputs
before writing them. Keep judge downloads in separate input directories and
update their readers. Other image/source pins remain their own audit work.

## Assumptions

- Published versions follow the existing CalVer format.
- The result contract's five verdicts are the complete output vocabulary.
- Missing, unreadable or malformed data stops the step before an output write.
- Judge evidence retains its own file root; trusted qare scripts remain separate.

## Tasks

- [x] Add failing shell fixtures for both version steps and all verdict steps.
- [x] Validate whole JSON fields before shell command substitution or output writes.
- [x] Add a simulated download fixture proving trusted files survive judge inputs.
- [x] Move judge input downloads and update every reader.
- [ ] Rebase onto current main, stamp a release and run full preflight.
- [ ] Own review, Copilot, one QA run and merge when CI is green.
- [ ] Verify main CI, release tag and core/web image publication.

## Validation observed

Eight initial boundary cases failed against the original workflow. Six cases
then exposed multiple-document input acceptance; requiring exactly one JSON
document closed that gap. Two reader fixtures failed with the old root paths
and passed with the isolated downloads. All 18 boundary fixtures and all 412
CLI tests pass. Existing source assertions now name the new paths and whole-field
validation, with runtime fixtures covering both accepted and refused inputs.
