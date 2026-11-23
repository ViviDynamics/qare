# An onboarding PR can never pass: an inferred accessibility audit blocks a run with no base

Issue #419

## Scope
In: an audit the planner inferred, on a run whose base revision has no usable
profile, reports its violations as advisory and decides nothing; an audit the
criterion asked for decides as before; the rule in docs/SPEC.md,
docs/pipeline.md and docs/schemas.md.
Out: a standing audit (`a11y.standing: true`) with no base profile. It is the
profile's own ask, so it is not inferred and keeps deciding.

## Assumptions
- "No usable profile at the base" is the base side's own refusal reason, read
  in code, single profile and per app of a several-profile run.
- A base with a profile that does not boot is a fault, so its audits stay
  unverified.
- The plan's `inferred` mark is model output, so code holds it to the
  criterion's words: a criterion that names accessibility asked for the audit.
- An advisory outcome is not cached: the next run may have a base.

## Tasks
- [x] 1. Carry `inferred` from the plan to the job's a11y check: job-from-plan and job loader tests.
- [x] 2. `decideA11y` marks violations `advisory` and passes, naming why: a11y unit tests.
- [x] 3. The head side learns when the base had no profile, and an inferred audit advises: a11y-run tests (advisory, asked, words ask, base did not boot, one side).
- [x] 4. The result carries `a11y.advisory` and `a11yAdvisory`, and the comment shows them: result and evidence tests.
- [x] 5. SPEC, pipeline and schemas state the rule.
