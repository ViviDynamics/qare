# ADR-0002: Screenshot storage — Action artifacts for the run, an orphan `qa-assets` branch for the long term

Date: 2026-09-20
Status: accepted

## Context

An open question from the spec draft (issue #33, "Open questions" 2): where do
screenshots live long-term — Action artifacts (90-day retention) or a
`qa-assets` branch?

Action artifacts are already the transport and are not in question: the three
jobs run on separate machines, so the execute job hands `plan.json`, raw
results, screenshots, traces and logs to the judge job as artifacts (SPEC,
"Pipeline", "Output"). The question is what happens after the run, because
artifacts expire after 90 days. Past that, links in the evidence comment rot,
and the ledger's verification records (`last_verified`) point at evidence
nobody can open — which quietly weakens "evidence or it didn't happen"
(principle 2) for every pull request older than a quarter.

The spec has already decided the same shape of question for the criteria
ledger: an orphan branch in the same repo keeps the material out of the
working tree while staying versioned, diffable and reviewable, with nothing to
host (SPEC, "Where the ledger lives").

## Decision

The long-term home for screenshots is an orphan `qa-assets` branch in the same
repo, mirroring the `qa-ledger` branch backend. Visual checks push their
screenshots there under a path naming the run (head sha and date).

Action artifacts remain the run transport and the home for everything else:
traces, logs, `plan.json`, `result.json`. Screenshots land in both places —
artifacts to cross the job boundary, branch to outlive it.

The evidence comment links only to files the harness actually wrote
(CONSTITUTION rule 4): artifact downloads while they live, branch paths
permanently.

## Consequences

- Links from old pull requests keep resolving past 90 days, and the ledger's
  verification records always point at openable evidence.
- The branch is append-only and its history is never rewritten, matching the
  transparency the ledger is required to keep. The repo grows by the
  screenshots a run produces; at QA volumes this is manageable, and PNGs do
  not need to be diffed to be useful.
- Pushing screenshots needs contents write, which the posting identity
  already has (ADR-0003). The push happens in the judge step, which holds the
  identity; the execute step holds no GitHub token and never touches the
  branch (CONSTITUTION rule 7).
- Pushes to `qa-assets` are not pull request completions, so they do not
  re-trigger QA; repository CI should ignore that path so the pushes stay
  quiet.
- Fork pull requests are refused outright in the Action (SPEC, "Triggers"), so
  `qa-assets` writes always land in the base repo.

## References

- [Issue #33](https://github.com/ViviDynamics/qare/issues/33) — decision 2 of 3.
- [docs/SPEC.md](../SPEC.md) — "Open questions" 2, "Principles" 2, "Pipeline", "Where the ledger lives", "Output", "Triggers".
- [CONSTITUTION.md](../../CONSTITUTION.md) — rules 4 and 7.
- [ADR-0003](adr-0003-posting-identity.md) — the identity that does the pushing.
