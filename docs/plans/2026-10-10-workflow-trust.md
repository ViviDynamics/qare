# Pin workflow dependencies and narrow release authority

Issue #310

## Scope

Pin every external workflow action by commit, enable the manifest's pnpm
through Corepack, isolate its download cache, narrow release permissions,
and refuse auto-tag runs outside main or with a malformed version.
Container image dependencies and image digests remain separate audit work.

## Assumptions

- Node 22 supplies Corepack; the manifest records pnpm's version and hash.
- Fresh Corepack storage is needed because cached pnpm is reused before
  Corepack compares a requested hash.
- Existing caller inputs and the separate self-hosted execution pool remain
  unchanged. qare itself runs exclusively on GitHub-hosted runners.

## Tasks

- [x] Pin action uses and verify all workflow files, including comments.
- [x] Replace pnpm setup actions with Corepack and verify resolved versions.
- [x] Prove fresh per-job Corepack storage and propagation with a failing test,
  then isolate all enabling steps under RUNNER_TEMP.
- [x] Cover missing Node setup, download failure and different pnpm snippets.
- [x] Narrow release permissions, remove credential persistence and caches.
- [x] Refuse non-main manual tagging and validate CalVer before environment writes.
- [x] Correct dependency, fleet example and image publication documentation.
- [ ] Rebase onto merged #307, preserve #323/#325, stamp the release and preflight.
- [ ] Independent final review, Copilot review, CI, merge and image read-back.
