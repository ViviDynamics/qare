# Restrict marker-based issue access to the posting identity

Issue #327

## Scope

Stub filing, refused-PR registries, requeue, standing reports, sweep findings
and advisory promotion use only issues opened by the configured posting
identity. Search restrictions are followed by local author and marker checks.

## Assumptions

- GitHub's author metadata is required before reusing an issue.
- Switching identity leaves the old identity's issues untouched.
- An identity lookup or issue read failure stops the operation; it never
  causes another author's record to be accepted.

## Tasks

- [x] Add failing coverage for foreign and unread authors on all marker paths.
- [x] Add a shared owned-issue search with an author qualifier and local checks.
- [x] Check ownership again before writing a refused-PR registry.
- [x] Update existing fixtures to record the authorship real GitHub returns.
- [ ] Run affected action tests and full preflight.
- [ ] Rebase after #310, stamp release, own review and Copilot review.
- [ ] Merge after CI and one QA run, verify main CI, tag and images.

## Validation observed

The eleven new foreign/unread-author cases failed against the original four
marker paths. The two helper cases also failed before implementation. After
the fix, all 219 action tests passed, along with action typecheck and changed
file lint. The fake intentionally returns matching foreign-author and title-only
hits, so these cases exercise local checks independently of the search qualifier.
