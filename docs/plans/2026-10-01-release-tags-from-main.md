# Release tags must live on the default branch's history

Issue #194

## Scope
In: release.yml refuses to publish a tag whose commit is not reachable from the
default branch; the QARE execute job resolves its runtime image from the base
revision's version the way plan and judge already do; version bump to 2026.10.1
so the release is cut by auto-tag from main's history after this merges.
Out: changing the plan or judge image resolution (already correct); moving or
re-pointing the existing 2026.10.0 tag (published content matches main's tree);
auto-tag changes (its flow already tags the validated commit).

## Assumptions
- Rule 7 (#88): the pull request contributes data only; a job resolves its
  image from a revision the pull request cannot change.
- Execute keeps checking out the pull request tree (it holds no secrets); only
  the image version resolution moves to the base revision.
- The ancestor guard runs before any image build in release.yml, using the
  default branch from origin.

## Tasks
- [ ] 1. Failing tests in packages/cli/test/workflow.test.ts: the execute job
  resolves its image version from the base revision; release.yml refuses a tag
  whose commit is not an ancestor of the default branch.
- [ ] 2. Implement the release.yml guard step.
- [ ] 3. Implement the execute job base-version resolution.
- [ ] 4. Bump the version to 2026.10.1 (package.json + sync-version).
