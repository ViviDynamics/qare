# A check proves a criterion only if it exercised it (#157)

## The failure

#138's check ran `npm test -- --testNamePattern=replay...` six times; the flag
landed nowhere, every check ran the whole suite, and the verifier accepted
"all tests pass" as "replay proven". A pass that proves the wrong thing is the
worst outcome qare can produce.

## Design

The profile author is the one who knows a command's semantics, so the
declaration carries them:

- `profile.ts`: `ProfileCommand` gains `filter` and `report`. `filter` names a
  placeholder of the command's run (for example `pattern`); the token at that
  position is the test filter. `report` is the machine-readable format the
  command emits on stdout: `vitest-json` (also jest's shape), `junit-xml` or
  `node-tap`. Declaring one without the other is a validation error: a filter
  whose selection cannot be read is a lie, and a report with no filter has
  nothing to verify.
- `job-from-plan.ts`: the run context already carries the profile (inline or by
  path). When a plan command check's filled command matches a declared
  command's shape, the runner attaches the filter value (the token at the
  filter placeholder's position) and the report format to the job check. A
  plan check whose shape does not match stays a plain command, unchanged.
- `run.ts`: after a command check exits 0, the runner parses the captured
  stdout with the declared format's reader and counts the tests the filter
  selects. A filter that selects none of them, or every one of them, leaves
  the check unverified naming the filter and both counts; it never counts as
  passed. A filter that selects some of the tests passes, and the selected
  tests' names are written to the check's evidence as `selected.txt`. A report
  the runner cannot read is unverified too. A non-zero exit stays failed,
  whatever the filter did.
- `judge.ts`: the verifier's instructions gain the rule - a check proves a
  criterion only if the evidence shows the behaviour the criterion names being
  exercised; a whole-suite run, a filter that matched nothing relevant, or an
  exit code with no output tying it to the criterion does not prove it. The
  verifier's findings gain a kind: `unexercised` downgrades the criterion to
  unverified with the reason, not to failed - the change may be fine, it just
  was not checked. Other findings keep downgrading to failed.

## Formats and matching

- `vitest-json`: vitest and jest JSON reporters
  (`testResults[].assertionResults[].fullName`).
- `junit-xml`: `<testsuite>`/`<testcase name>` under `<testsuites>`.
- `node-tap`: TAP `ok N name` and `not ok N name` lines.
- The filter matches the way vitest and jest match `-t`: as a regular
  expression against the full test name, falling back to a substring match
  when the filter is not a valid regular expression.

## Changes

1. `packages/core/src/profile.ts` - `ProfileCommand.filter`, `ProfileCommand.report`, validation in `parseCommands`.
2. `packages/core/src/job.ts` - `JobCommandCheck.filter`, `JobCommandCheck.report`, parsed conditionally.
3. `packages/core/src/job-from-plan.ts` - resolve the declared command by shape, attach the filter value and format.
4. `packages/core/src/run.ts` - selection verification in the close handler, `selected` on `CheckOutcome`, `selected.txt` beside `stdout.txt`.
5. `packages/core/src/judge.ts` - the exercise rule in `VERIFIER_INSTRUCTIONS`, `kind: 'unexercised'` in the output schema and in `consumeVerifierFindings`.
6. `docs/SPEC.md` and `docs/orchestrator.md` - the contract and the evidence layout.
7. Tests: runner (exact selection passes and writes selected.txt; none and every unverified; unreadable report unverified; plain command unchanged), judge (unexercised downgrades to unverified), profile (filter/report validation), job-from-plan (threading), and a test named for #138: the whole-suite run cannot prove a filtered criterion.

## Evidence

- The three done-whens become tests: #138's plan shape (filters that select
  nothing) yields unverified naming the filter; a filter selecting exactly the
  replay tests proves the criterion with selected.txt listing them; a
  whole-suite run cannot prove a filtered criterion.
- No stored artifacts from #138's self-run exist in the repository, so its plan
  is reconstructed inline from the issue's description.

## Not here

- qare's own `.qa` commands stay grep and node (#158); they are not test
  commands and gain no filter or report.
- #198 (the planner prompt's standard tools) stays open.
