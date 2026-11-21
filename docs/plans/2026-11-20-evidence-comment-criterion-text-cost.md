# Show criterion text, outcome counts and token cost in every evidence comment

Issue #373

## Scope
In: the five acceptance criteria. Criterion text beside each id in the evidence
comment, a summary line of proven, failed and unverified counts, the run's plan
and judge token totals, thin evidence labelled as thin evidence, and a
proven-or-failed rate in the standing report's metrics section.
Out: the pipeline failure comments (no criteria were judged there), and the
fleet report, which reads the ledger rather than run records.

## Assumptions
- The judged result carries each criterion's text (`text`) and the planning
  model's spend (`planUsage`), so the CLI's comment.md and the action's posted
  comment render from the same record. Both are optional: older results load.
- Criterion text is redacted with the rest of the result (`redactResult`), so
  the profile's rules apply at judge time and the built-in rules again at post time.
- A verifier finding that left a proven criterion unverified carries a reason
  starting `verifier: `. That is thin evidence, a check quality problem.
- The rate is (proven + failed) / all recorded criterion outcomes, from the
  metrics store, since that is where "33 proven, 10 failed, 475 unverified" comes from.
- Tokens not recorded for a step are said to be not recorded, never zero.

## Tasks
- [x] 1. Result carries `text` and `planUsage`: parse tests in result tests, judge test that judgeExecuted attaches both, redact test that text is swept.
- [x] 2. Comment rows show the criterion text on one line: evidence tests (relative and posted).
- [x] 3. Comment summary line with counts and token totals: evidence tests.
- [x] 4. Thin evidence label: evidence test for a `verifier: ` unverified reason.
- [x] 5. Standing report rate: metrics and sweep tests.
- [x] 6. Callers pass the plan's text and usage (CLI judge with or without the verifier, replay): cli test.
