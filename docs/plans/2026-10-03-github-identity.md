# GitHub identity: App or personal access token

Issue #61

## Scope

In:

- One auth interface in `@qare/action` (`GitHubIdentity`) with three
  implementations: a GitHub App installation, a personal access token, and the
  default Actions token every install starts with.
- The choice is made by which credentials are present, never by code:
  `QARE_APP_ID` + `QARE_APP_PRIVATE_KEY` (App), else `QARE_GITHUB_TOKEN`
  (personal access token), else `GITHUB_TOKEN` (the Actions token).
- The reusable pipeline takes the identity by name (`app-id`,
  `app-private-key`, `personal-access-token`) and hands it to the posting
  steps of judge, report and requeue only. qare's own caller and the sweep
  pass the same three, so the App is switched on by setting secrets (#155).
- `ingest-deliver` refuses to open a criteria proposal with the default
  Actions token, because that pull request would trigger no workflows.
- The permissions each option needs, in `docs/pipeline.md`; the spec section
  and ADR-0003 name the interface.
- Release 2026.10.4, so a caller can pin a pipeline that declares the secrets.

Out:

- Creating the App, its key, a token or any repository secret: #155, human
  only. The App path is built against GitHub's documented REST API and tested
  with a fake; it is unexercised against real GitHub until #155 is done.
- Hosting a shared App for other organisations (the issue's own out of scope).
- A workflow that runs ingest and delivers proposals on a schedule or a
  trigger: #37 owns when proposals are opened. This issue owns who opens them.

## Assumptions

- qare mints the installation token itself (a signed JWT, the repository's
  installation, an access token scoped to that one repository), with
  `node:crypto` and no new dependency. The workflow does not use a
  third-party token action: the interface the issue asks for is then real
  code with a fake behind it, and the same code serves `qare-action` run
  outside Actions.
- The App id is passed as a secret, not an input: a calling job may read
  `vars` and `secrets` under `secrets:`, but only `vars` under `with:`, and
  #155 stores the id as an organisation secret.
- collect keeps the Actions token. It only reads the linked issues; the
  identity is for what qare writes, and a job that never posts should not
  hold a key that can.
- GitHub lets only an App write check runs. With a personal access token the
  check run is still written by the Actions token, and everything else is the
  user's.
- The sticky comment is found by its author, so the author is the identity's
  own login (`<app slug>[bot]`, the token's user, or `github-actions[bot]`).
  A pull request open while an install switches identity gets a new comment
  from the new identity; the old one names the commit it checked.
- The posting steps run the pinned qare (an image or a checkout the pull
  request cannot change), so the key is never on a machine with pull request
  code (rule 7). The pipeline keeps passing `GITHUB_TOKEN` too, so a pinned
  qare older than this change posts exactly as it did.
- `GITHUB_TOKEN` in the environment is always read as the Actions token. A
  personal token goes in `QARE_GITHUB_TOKEN` or the variable `--token-env`
  names.

## Tasks

- [x] 1. The identity interface and its resolution: App, then token, then the
  Actions token; a half-configured App and no credential at all stop by name.
  (`packages/action/test/identity.test.ts`)
- [x] 2. The App installation identity: JWT signed with the private key, the
  repository's installation, a token scoped to the repository, cached until it
  nears expiry; not installed and a wrong key are named. (same file, against
  the fake's App endpoints)
- [x] 3. `GitHubClient` asks its identity for the token of each request, and
  writes check runs with the token that may. (`github.test.ts`,
  `identity.test.ts`)
- [x] 4. Posting commands find their own sticky comment under any identity,
  and `ingest-deliver` refuses the Actions token. (`identity-commands.test.ts`)
- [ ] 5. The pipeline declares the identity secrets and hands them to the
  posting steps only; qare's caller and the sweep pass them.
  (`packages/cli/test/pipeline-caller.test.ts`)
- [ ] 6. Documentation: `docs/pipeline.md` (identity, secrets, permissions per
  option), the spec section, ADR-0003.
- [ ] 7. Release 2026.10.4 (`scripts/sync-version.mjs`).
