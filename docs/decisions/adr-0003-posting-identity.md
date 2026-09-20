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

## References

- [Issue #61](https://github.com/ViviDynamics/qare/issues/61).
- [docs/SPEC.md](../SPEC.md) — "GitHub identity", "Decisions made", "Pipeline", "Triggers".
- [CONSTITUTION.md](../../CONSTITUTION.md) — rules 1 and 7.
- [ADR-0002](adr-0002-screenshot-storage.md) — a consumer of the identity: the judge step pushes `qa-assets`.
