# An onboarding pull request is planned with no profile, because the base has none

Issue #431

## Scope
In: when the base revision has no profile, collect exports the head's profile
directory from git objects (regular files only) as an artifact, and the plan
job hands it to `qare plan --pr-profile`, which reads it as data: its suites,
app address, commands and QA.md reach the planner, its host MCP servers are
not started, and it cannot be explored. `qare plan` records which profile it
read in `plan.json` (`profileSource`), judge copies it onto the result
(`planProfile`), and the comment and the plan job's summary say it. ADR-0013
records the decision.
Out: exploring the head (it needs the sandbox split of #87); changing what a
plan reads when the base has a profile.

## Assumptions
- `--pr-profile` is a new flag, and qare's CLI ignores flags it does not know.
  The pipeline passes the head's profile only through `--pr-profile`, never
  through `--profile`, so a pinned image older than this change plans with no
  profile, as before, instead of reading the head's profile with its MCP
  servers started.
- A profile's MCP driver mapping is kept, because it is what the plan's flows
  may do in execute; only the servers are left unstarted.
- `profileSource` is `checkout` for `--profile`, `pull-request` for
  `--pr-profile`, and `none` when the flag named no usable profile. The plan
  job's `--profile` is always the base checkout, so the comment says "base".
- The comment states the planning profile only when the result carries it,
  so a result judged without a plan renders as before.

## Tasks
- [ ] 1. `qare plan --pr-profile`: reads the profile, records `profileSource`, starts no MCP server, refuses `--explore` and `--profile` beside it: plan-pr-profile-command.test.ts
- [ ] 2. `plan.json` and `result.json` carry the field; judge copies it; the comment says it: plan, result and comment tests
- [ ] 3. Pipeline: collect chooses and exports, plan downloads and passes it, summary says it: pipeline-pr-profile.test.ts
- [ ] 4. Docs: pipeline.md, schemas.md, ADR-0013
