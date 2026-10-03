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

The App path is built against GitHub's documented REST API and tested
against a fake of it. Until the App exists (#155) it has not been exercised
against GitHub itself.

## References

- [Issue #61](https://github.com/ViviDynamics/qare/issues/61).
- [docs/SPEC.md](../SPEC.md) — "GitHub identity", "Decisions made", "Pipeline", "Triggers".
- [CONSTITUTION.md](../../CONSTITUTION.md) — rules 1 and 7.
- [ADR-0002](adr-0002-screenshot-storage.md) — a consumer of the identity: the judge step pushes `qa-assets`.
