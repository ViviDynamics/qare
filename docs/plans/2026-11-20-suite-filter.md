# The profile declares the project's test command, and the planner prefers it over source greps

Issue #376

## What already exists

- `suites` in `config.yml` name a command and a kind, and since #386 `qare init`
  writes them as `docker compose -p qare-{{run.id}} ... exec -T <service> <command>`,
  so a suite already runs inside a compose service. A plan names one with a flow
  check, `{"kind":"flow","suite":"<name>"}`, and the planner is told each declared
  suite with the command it runs (#258). What a suite cannot do is run one test:
  its command is fixed.
- `commands` take placeholders, and a `filter` plus `report` pair (#157) that
  verifies the filter selected some tests and not all of them. They run in the run
  image or its cell, not in a compose service, and the program gate admits any
  arguments to a declared program: declaring `docker compose ... exec` there would
  let a plan run any `docker` command. So `commands` are not the place for a
  service's test command.

## Scope

In:
- A suite may declare `filter` (the placeholder of its command that takes the test
  name or path) and `report` (the machine-readable format it prints), the same pair
  a declared command takes. Both or neither.
- A plan's suite check may carry `filter`, the value for that placeholder. The value
  is validated in code: one token, from a fixed character set, not starting with `-`,
  with no `..` step. It is refused at the plan step (one correction round), when a
  job loads, and at run time. A filter on a suite that declares none, or a filtered
  suite named without one, is refused the same way.
- The run substitutes the validated value into the suite's own command, runs it, and
  reads the report: a filter that selected none or all of the tests leaves the check
  unverified, as for a declared command (#157). The evidence records the filter and
  the selected tests.
- The planner is told which suites take a filter and is told to prefer a suite
  check naming a test over a grep for a criterion about behaviour.
- docs/SPEC.md and docs/pipeline.md describe the new fields.

Out:
- Ledger `suite:<name>` references and the main lane carry no filter; a ledger
  entry naming a filtered suite is reported unverified, which keeps that path
  closed until a ledger filter is asked for.
- `qare init` does not write a filter: it cannot tell which report format a
  project's runner prints.

## Assumptions

- A plan can only name a suite the profile declares and fill its one placeholder,
  so the command that runs is the profile's. That keeps the planned command within
  what the profile declares, as #371 does for interpreters.
- Requiring `report` with `filter` keeps the verdict code-decided and fails closed:
  some runners exit 0 when a filter matches nothing.
- Criterion 3 is about what the model writes. Code cannot force it; what code can
  prove is that the prompt asks for it, that such a plan is accepted and carried to
  the job, and that it runs. The tests cover those.

## Tasks

- [x] 1. Profile parses `filter` and `report` on a suite: profile.test.ts cases for
  accept, filter without report, report without filter, filter not in the command,
  unknown report.
- [x] 2. Plan and job carry a validated `filter` on a suite flow check, and
  job-from-plan and plan-lock keep it: plan.test.ts, job tests, job-from-plan.test.ts.
- [x] 3. The run substitutes the filter and verifies the selection: flow-run.test.ts
  cases for a selecting filter, a filter selecting nothing, a filtered suite named
  without a filter.
- [x] 4. The planner prompt lists the filter and prefers a named test over grep, the
  schema offers `filter`, and the plan step corrects an unsafe or undeclared filter:
  plan-browserless.test.ts and plan-step tests; the CLI hands the filter through.
- [x] 5. Docs.
