# ADR-0003: Posting identity — GitHub App or personal access token, chosen per install

Date: 2026-09-20
Status: accepted

## Context

QARE posts comments, check runs and criteria proposals, so it needs a GitHub
identity, and both candidate forms have to work (issue #61). The two options
trade off differently:

| Option | Gains | Costs |
| --- | --- | --- |
| GitHub App | its own actor, per-repo installation, scoped permissions, far higher rate limit | something to host and register |
| Personal access token | one file, nothing to host, working in minutes | work appears as that user; rate limit shared with everything else the user runs |

Two constraints hold regardless of which is chosen:

- Pull requests opened with the default Actions token do not trigger
  workflows, so criteria proposals opened with it would arrive with no checks.
- The identity must never exist in the step that executes pull request code
  (CONSTITUTION rule 7); planning and judging run in separate steps for
  exactly this reason.

The spec already records this decision under "Decisions made" ("GitHub
identity: App or personal access token, chosen per install") and in its
"GitHub identity" section. This ADR records it as a decision record properly,
with the interface that makes the choice hold.

## Decision

Both options are supported behind one auth interface, and the choice is per
install, made in configuration. A GitHub App is preferred for an organisation;
a personal access token is the zero-hosting option for a single install.

Switching between App and token requires no code change (issue #61, done when
checkbox): the seam is an auth interface with two implementations, as with the
repo's other seams — the caller configures credentials, and the posting code
is written against the interface.

Criteria proposals are opened with the configured identity, never the default
Actions token, so the repository's checks run on them. Each option's required
permissions are documented for the install (issue #61, "document the
permissions each needs"). The identity only ever exists in the plan and judge
steps, never in the step that executes pull request code.

## Consequences

- An organisation install gets a distinct, auditable actor with per-repo
  scoping and a high rate limit; a small install gets posting without hosting
  anything.
- Whatever the option, the credential stays at the plan/judge boundary and
  never rides with pull request code.
- Hosting a shared App for other organisations is out of scope (issue #61,
  out of scope): an org runs its own App or uses a token.

## Implementation (2026-10-03, issue #61)

The interface is `GitHubIdentity` in `packages/action/src/identity.ts`: a
token for each request, a token for check runs, and the login what it writes
is attributed to. It has three implementations, chosen by `resolveIdentity`
from what is configured, in this order:

| Configured | Identity |
| --- | --- |
| `QARE_APP_ID` and `QARE_APP_PRIVATE_KEY` | the App's installation on the repository |
| `QARE_GITHUB_TOKEN` | a personal access token |
| `GITHUB_TOKEN` | the Actions token of the workflow run |

The reusable pipeline declares the first three as the secrets `app-id`,
`app-private-key` and `personal-access-token`, and hands them to the posting
steps of judge, report and requeue. Decisions taken while building it:

- **qare mints the installation token itself**, with `node:crypto`: a JSON
  web token signed by the private key, the repository's installation, and a
  token scoped to that one repository. No third-party action holds the key,
  and the same code serves `qare-action` run outside a workflow.
- **The Actions token is a third implementation, not a missing one.** Every
  install starts with it, and the code can land before any App exists. It is
  the one identity a criteria proposal is refused under.
- **Half an App is an error.** An id without a key, or the reverse, stops the
  step by name instead of falling to a weaker identity (rule 6).
- **Check runs under a personal access token are written by the Actions
  token.** GitHub lets only an App write one.
- **collect does not hold the identity.** It only reads the linked issues,
  and a job that never posts should not hold a key that can.
- **The comment author is the identity's login**, so a pull request open
  while an install switches identity gets a new comment and keeps the old.

## Where the key is used (2026-10-09, issue #305)

This section supersedes two statements above for the pipeline and the sweep:
there are now four implementations, and the posting steps are no longer
handed the App's id and key.

The implementation above handed the App's private key to every step that
posts, and in judge and main_judge that meant into a container. The key is
the long-lived credential of the whole App, and a posting step only ever
needs a token for one repository that expires within an hour. So, in the
pipeline and in the sweep:

- **The key is used in one step of each job that posts**, "Mint the App
  token for this job". It runs `scripts/mint-app-token.mjs` of the pinned
  qare with node on the runner, before any dependency is installed, any
  artifact downloaded or any container run. The script imports node's own
  modules alone, so the step that holds the key runs no dependency, restores
  no cache and starts no image. No third-party action is handed the key:
  that decision stands.
- **The token is scoped twice**: to the calling repository alone, as before,
  and now to the permissions the job declares. A job that only comments
  cannot push, whatever the App may do.
- **The posting steps are handed the token and the App's slug**
  (`QARE_APP_TOKEN`, `QARE_APP_SLUG`), which `resolveIdentity` reads ahead of
  the id and key as a fourth implementation, `MintedAppIdentity`. It signs
  nothing and asks GitHub nothing to learn its login.
- **The cost is renewal.** `AppInstallationIdentity` replaces a token near
  its expiry; a step that holds no key cannot. A job's posting steps must
  run within an hour of its minting step. A job that overruns is told so by
  name, before GitHub is asked, and fails; for judge, the report job then
  says the verdict went unpublished. Publishing from a job of its own, which
  would mint after the model has answered and on a clean machine, is the
  way to give a slow verifier its hour back; it is not done here. Minting later in the job would keep the hour for the model
  but put the key on a machine that already holds the run's artifacts, which
  is the thing this change removes.
- **The run's jobs are read with the Actions token**, so the App is asked
  for no Actions permission.
- **The key is still a secret of the job.** GitHub hands a job's runner
  every secret the job's steps name. The steps that run on the runner after
  the minting step, the build of the pinned qare in report, advisory,
  requeue and the sweep and the step that enables pnpm with corepack, run on a
  machine that was given the key, though
  never in their own environment. Actions has no way to hand a token from
  one job to another as a secret, so the key cannot be moved to a job that
  runs nothing else.
- **What GitHub answers is checked.** A token whose answer names a
  permission that was not asked for, a higher level, or any repository but
  the calling one is given back and never handed on. The script reads the
  `repositories` and `permissions` of GitHub's documented answer. The
  [first live QARE run](https://github.com/ViviDynamics/qare/actions/runs/37941939128)
  exercised this check against GitHub and posted as `vivi-qare[bot]`.
- **An image that cannot read a minted token stops the job.** judge and
  main_judge check the image they pulled before they post with it, so a
  version skew between the pipeline and its image is a named failure and
  never a quiet fall to a weaker identity.
- **The sweep runs on its schedule, and otherwise for the default branch
  alone**, so a manual run from another branch does not hand the identity to
  that branch's code by accident. The condition is a line of the workflow
  file: it does not stop a branch that removes it. Keeping the App's secrets
  in an environment restricted to the default branch would, and is a
  repository setting.
- **`qare-action` outside a workflow is unchanged**: it still takes the id
  and the key and mints for itself, with a token for the one repository.
  The script repeats the sign-in on purpose, so that it runs before any
  build exists; both are tested against the same fake.

The same change removed the dependency cache from every pipeline job and
from the sweep: a job that holds a token installs by the lockfile from the
registry, and not from a cache another job could have written.

The App path is tested against a fake of GitHub's REST API and has also
been exercised against GitHub in the live run above. Its evidence comment
was posted as `vivi-qare[bot]`; the QA verdict was blocked by unverified
harness-internal criteria. This observes minting and posting, not the App's
installation permissions or key custody. Those checks, and whether a
criteria proposal triggers workflows, remain open in #155 and #61.

## References

- [Issue #61](https://github.com/ViviDynamics/qare/issues/61).
- [docs/SPEC.md](../SPEC.md) — "GitHub identity", "Decisions made", "Pipeline", "Triggers".
- [CONSTITUTION.md](../../CONSTITUTION.md) — rules 1 and 7.
- [ADR-0002](adr-0002-screenshot-storage.md) — a consumer of the identity: the judge step pushes `qa-assets`.
