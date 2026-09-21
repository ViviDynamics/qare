# QARE: spec draft

Status: draft, not yet a repo. Written 2026-09-18 from the research in
internal research on QA for agentic development.

## What it is

QARE is a QA agent harness. Given a pull request and the issue it closes, it
runs the app before and after the change, checks every acceptance criterion,
and posts evidence on the PR: a per-criterion table with screenshots, logs and
traces, and a verdict that code decided, not a model.

It sits beside NARE in the Coordinare project family. An orchestrator calls
NARE to develop and QARE to QA, and any other harness (Claude Code, Codex,
OpenCode) can call QARE the same way.

## Principles

0. **nare is the agent harness.** Every model call goes through
   [nare](https://github.com/ViviDynamics/nare); qare never calls a provider
   SDK. A gap in nare becomes an issue on nare, never a workaround here. See
   [CONSTITUTION.md](../CONSTITUTION.md).
1. **The model plans and witnesses; code decides.** A model writes the check
   plan and acts as an independent verifier. The harness runs every command,
   takes every screenshot, and computes every verdict.
2. **Evidence or it didn't happen.** A criterion is proven only by a check the
   harness executed. The PR comment links only files the harness uploaded.
3. **Checks are locked before the code.** The plan is fixed before execution
   and cannot be edited to match what passed.
4. **"Couldn't verify" is not "failed".** Environment problems block with their
   own outcome and never read as code defects.
5. **No stubs, no QA.** If the app reaches a service the project hasn't stubbed,
   QARE refuses and files the stub work. Stubs merge first, so the baseline can
   boot against them too.
6. **Humans approve.** QARE never merges. Its verdict feeds a human sign-off.

## Outcomes

Per criterion: `proven`, `failed`, `unverified`.

Per run:

| Verdict | Meaning | Check state |
| --- | --- | --- |
| `passed` | Every criterion proven, no regressions | success |
| `failed` | A criterion failed or a regression appeared | failure |
| `blocked` | Some criterion unverified for environment reasons | neutral |
| `refused` | Missing stub or missing QA profile | neutral |
| `waived` | A human applied `qa-waived`; recorded, never shown as a pass | neutral |

A regression is anything that worked at the merge base and fails at the head,
whether or not a criterion covers it.

## Pipeline

Three jobs, so the model and the GitHub token never share a machine with PR code.

| Job | Secrets | Network | Does |
| --- | --- | --- | --- |
| **plan** | model key | yes | Reads the issue, the diff and `.qa/`; writes `plan.json` mapping each criterion to checks tagged `command`, `flow` or `visual`. Never executes PR code. |
| **execute** | none | stub containers only | Boots the app at the merge base and at the head with stubs, runs the plan, saves artifacts and raw results. |
| **judge** | model key, GitHub token | yes | Computes verdicts in code from raw results, runs the verifier model on the evidence, posts the comment and check. |

Execute stages, per side (base, head):

1. Boot from the `.qa/` recipe (compose, command, or preview URL); prove the app is up with a health check the harness runs.
2. Seed fixtures, log in test accounts.
3. Run `command` checks (exit code and output), `flow` checks (Playwright from a fixed action set, or existing suites such as cucumber-js), and `visual` checks (named screenshots at named widths and themes).
4. Record every outbound connection attempt. Anything outside the stub map is a `refused: missing stub` finding.

Judge:

- Criterion verdicts come from executed results only.
- Visual diffs are advisory evidence for the human, never the sole basis for a pass.
- The verifier model gets the criteria, diff and evidence in a fresh context and reports only criteria the evidence does not actually show. Its findings can downgrade a verdict, never upgrade one.

## The `.qa/` profile (per repo)

```
.qa/
  config.yml      # boot recipe, health check, widths/themes, suites, stub map
  QA.md           # instructions: what the app is, what matters, how to log in
  fixtures/       # seed data, test accounts
  stubs/          # project-provided stubs, or compose services that provide them
  learned.yml     # written back by QARE: the boot recipe that last worked
```

Sketch of `config.yml`:

```yaml
app:
  boot: { compose: compose.qa.yaml, service: admin }
  health: { http: "http://localhost:3000/up", timeout: 120s }
  seed: { command: "bin/rails db:seed:qa" }
  login: { fixture: fixtures/users.yml, role: admin }
stubs:
  - service: billing
    hosts: ["api.billing-vendor.example"]
    provided_by: { compose_service: billing-stub }
  - service: mail
    hosts: ["api.mailgun.net"]
    provided_by: { compose_service: mailpit }
visual:
  widths: [1440, 390]
  themes: [light, dark]
suites:
  - { name: browser-e2e, command: "npm --prefix e2e test", kind: flow }
```

Agent-written stubs are allowed only when flagged: any check that depends on a
stub QARE wrote itself is shown as such and cannot count as `proven` without a
human note.

## The criteria ledger

A single pull request's acceptance criteria are the small case. The general
case is a repo whose criteria accumulate: hundreds of statements about how the
product behaves, written at different times by different people, some of them
now contradicting each other. QARE maintains that ledger.

The ledger is one schema behind a storage interface, with two backends. Sketch
of an entry, identical either way:

```yaml
- id: BIL-014
  text: A host paid more than the annual threshold gets a 1099 in January.
  proof: command
  status: active          # proposed | active | superseded | retired
  source: { issue: 2988, pr: 3011 }
  supersedes: [BIL-009]
  checks: [billing/spec/payout_tax_spec.rb:1099_threshold]
  last_verified: { sha: 9f3c1ab, run: 812, at: 2026-09-18, verdict: proven }
```

### Where the ledger lives

Both backends hold the same entries and are readable by the same commands, and
`qare ledger migrate` moves a ledger between them without losing history.

| Backend | Where | Good for |
| --- | --- | --- |
| `branch` (default) | an orphan `qa-ledger` branch in the same repo | keeping criteria out of the working tree while staying versioned, diffable and reviewable, with nothing to host |
| `files` | `.qa/criteria/*.yml` on the working branch | small repos and teams that want criteria in front of them next to the code |

A separate store only earns its keep if it stays legible, so transparency is a
requirement of the backend, not a feature on top:

- Every change records who made it, when, and why, and history is never rewritten.
- `qare ledger` reads either backend the same way.
- `qare ledger export` writes the whole ledger as plain files at any time, so
  nobody is locked in.
- The current state is published where the team already looks, not only in the
  store.

Lifecycle:

- **Ingest.** QARE reads acceptance criteria from an issue or PR and proposes
  ledger entries. Proposals arrive as a pull request, never as a silent edit.
- **Verify.** Every run records its verdict against the criteria it covered, so
  the ledger always knows when each statement was last proven and by what.
- **Contradict.** A change can put a new criterion at odds with an old one, or
  make an old one fail on purpose. QARE separates the two: a criterion the diff
  intends to replace is proposed as `superseded` with the replacement linked; a
  criterion that fails without any intent to change it is a regression.
- **Ask, rarely.** When evidence cannot settle whether a conflict is intended,
  QARE asks one question in one place, with its own recommendation attached.
  Only the affected criteria are held as `unverified`; the rest of the run
  reports normally, and an unanswered question never blocks a whole pull
  request.
- **Retire.** Criteria for removed features are retired with a reason and stay
  in history.

Criteria can only be weakened, superseded or retired through a reviewed change,
and every run's evidence names any ledger change that landed with it. This is
the same defense as locking checks before code: without it, the cheapest way to
go green is to edit the requirement.

### A job handed in

The smallest possible input, and the one an orchestrator uses. Everything QARE
needs arrives in one file:

```yaml
job:
  id: card-4821                     # caller's own id, echoed back
  repo:
    path: /work/repo                # a checkout the caller already has
    base: origin/main               # what "before" means
    head: HEAD                      # what "after" means
  profile: .qa/config.yml           # or the profile inline
  post: none                        # none, or a pull request to comment on
  criteria:
    - id: card-4821-1
      text: A host paid over the threshold sees the 1099 notice on the payouts page.
      proof: flow
    - id: card-4821-2
      text: bin/rails test test/payout_tax_test.rb passes.
      proof: command
      check: { command: "bin/rails test test/payout_tax_test.rb" }
```

Rules for this mode:

- Nothing is read from a ledger and nothing is written to one. Job criteria
  live and die with the job unless the caller asks for them to be recorded.
- Job criterion ids are the caller's, namespaced so they can never be confused
  with ledger ids or inherit another criterion's verification history.
- No GitHub is required. With `post: none` the result is `result.json` and an
  exit code; evidence is written to a directory the caller names.
- Every other rule still holds: the plan is fixed before execution, the harness
  runs the checks, code decides the verdict, missing stubs refuse the run.

### Working small and working large

The same engine serves both ends, and nothing in the pipeline assumes the whole
ledger, a pull request, or GitHub at all:

- **A job handed in.** A caller supplies the criteria itself, in a job file, and
  gets a verdict back. No ledger, no pull request, no issue. This is how an
  orchestrator asks for one specific QA check.
- **A few criteria.** Given one issue, QARE plans and checks only those
  criteria. No ledger is required to run at all.
- **A named subset.** An orchestrator hands QARE a set of criterion ids for one
  card and gets back a verdict for exactly those.
- **The whole ledger.** For a diff, QARE selects the criteria the change could
  affect, plus a standing smoke set, within a time budget. What it did not run
  is reported as not selected, never as passed.
- **A sweep.** On a schedule, QARE works through the ledger to refresh staleness
  and catch drift that no pull request would have touched.

Selection, caching, sharding and budgets are what make the large case possible;
they never change what a verdict means.

## GitHub identity

QARE posts comments, checks and pull requests, so it needs an identity. Both
are supported and the choice is per install:

| Option | Notes |
| --- | --- |
| GitHub App (preferred for an org) | its own actor, per-repo installation, scoped permissions, and a far higher rate limit |
| Personal access token | one file, nothing to host; work appears as that user, and the limit is shared with everything else that user runs |

Two constraints hold either way. A pull request opened with the default
Actions token does not trigger workflows, so criteria proposals would arrive
with no checks; QARE opens them with the App or the token instead. And the
identity only ever exists in the plan and judge steps, never in the step that
executes pull request code.

## Running against a deployed environment

Most runs use a stack QARE boots itself, where every dependency is a stub. A run
can instead point at a deployed environment such as staging, where the
dependencies are real. The checks are the same checks; only the profile's target
and its sources change.

The one part that differs in kind is anything QARE has to observe from outside
the app. Mail is the usual case: locally a sink in the stack catches it, and on a
deployed environment QARE reads a real mailbox instead. Credentials for those
sources exist only in this mode, never in the sandboxed step that executes pull
request code, and anything that cannot be reached is reported as `unverified`
with the reason named, never as a failed criterion.

## Triggers

- CI completes green on a PR (`workflow_run`), once per head SHA.
- A `/qa` comment on the PR.
- A `qa` label.
- Locally: `qare run` from the CLI or the Claude Code skill.

Fork PRs are refused outright in the Action.

## Output

- One sticky PR comment, regenerated per push: criterion, check, result,
  before/after/diff images, trace link, preview URL if any, verifier notes.
- A `qare` check run with the state from the table above.
- Artifacts: screenshots, traces, logs, `plan.json`, `result.json`.
- `result.json` is the machine contract other harnesses consume.
- Both artifact schemas are documented in [schemas.md](./schemas.md); the
  orchestrator contract — invocation, exit codes and reaction per verdict — in
  [orchestrator.md](./orchestrator.md).

## Readiness report

The first run on a repo with no `.qa/` does not QA anything. It inventories how
the app boots, which outbound services it reaches, which are stubbed, and which
are not, then posts a readiness report and files one issue per missing stub.

## Surfaces

One TypeScript codebase, one core, thin adapters:

| Package | Purpose |
| --- | --- |
| `@qare/core` | plan, execute, judge, report; provider interface; `result.json` schema |
| `@qare/cli` | `qare init`, `qare readiness`, `qare run`, `qare run --job`, `qare judge`, `qare ledger`, `qare sweep` |
| `@qare/action` | GitHub Action wrapping the three jobs |
| `@qare/mcp` | MCP server so orchestrators, Codex, OpenCode and others can call it |
| `plugin/claude-code` | skill, verifier subagent, Stop hook for local runs |

Model access: qare shells out to `nare run` and consumes its typed JSONL
events and session files. Model, provider and sampling flags are nare's
concern. Claude only at first, because model variance is what makes verdicts
unstable.

Capabilities qare needs from nare, each an issue on nare when it is missing:
schema-constrained output for `plan.json`, a read-only tool set for the
verifier step, and a per-step token budget with a retry on truncation.

## Repo conventions

Matches NARE and the rest of the Coordinare family: public, Elastic License 2.0 (LICENSE
and NOTICE copied from NARE), issues yes and pull requests no (CONTRIBUTING.md
and SECURITY.md adapted from NARE), CalVer. Node LTS, TypeScript strict, Playwright Test, pnpm workspaces, vitest.

## Milestones

**M0: skeleton.** Repo, license, CI, packages, `result.json` schema, CalVer.

**M1: core loop on one repo (pilot: an internal Rails admin console, during a
framework upgrade that changes most of its screens).**
1. `.qa/` profile schema and loader with validation errors that name the field.
2. Boot and health check from compose, harness-run, with a timeout and logs.
3. Plan step: issue plus diff plus profile to `plan.json`; empty plan fails closed.
4. Execute `command` checks with exit codes and captured output.
5. Execute `visual` checks at widths and themes; base and head screenshots.
6. Execute `flow` checks from a fixed action set, plus existing suites.
7. Egress recording and `refused: missing stub`.
8. Judge: verdicts in code, regressions against base, `blocked` vs `failed`.
9. Evidence comment and check run.
10. First real `.qa/` profile, for the pilot app.

**M2: automation.** GitHub Action with the three-job split, `workflow_run`,
`/qa`, label triggers, once-per-SHA memory, fork refusal, `qa-waived`.

**M3: guards.** Plan locked before implementation (plan commit first, guard on
edits to locked checks), verifier model step, agent-written stub flagging.

**M4: harness integration.** MCP server, Claude Code plugin, an orchestrator
calling QARE through `result.json`.

**M5: readiness and second repo.** `qare readiness`, stub issue filing, and a
profile for a second Rails app whose flow checks come from its Cucumber suite.

**M6: criteria ledger.** Ledger format, ingest as proposals, identity across
rewording, verification records, contradiction detection, the resolution
protocol, the integrity guard, and `qare ledger`.

**M7: scale and steady state.** Impact selection with a budget, subset runs by
criterion id, caching and skip-unchanged, parallel execution, scheduled sweeps,
flake quarantine, and the measures that say whether any of this is working.

Intended order: M0, M1, M2, M3, M6, M4, M5, M7. The ledger comes before the
harness integrations, because an orchestrator asking for a subset of criteria
needs the ledger to exist.

Later: per-PR preview namespaces via the Argo CD ApplicationSet pull request
generator, Argos for visual review, API before/after on Go services.

## Out of scope for now

- Merging or approving PRs.
- Models other than Claude.
- Recording production traffic.
- Replacing unit and integration suites; QARE runs them, it does not own them.

## Decisions made

- **Language:** TypeScript, because Playwright's runner, screenshot comparison
  and trace viewer are native there, and the design is what carries over from
  earlier work rather than the code.
- **Agent harness:** nare, by constitution.
- **Ledger storage:** both backends, `branch` by default, with export and
  migration so neither is a trap.
  ([ADR-0004](./decisions/adr-0004-ledger-authority.md))
- **GitHub identity:** App or personal access token, chosen per install.
  ([ADR-0003](./decisions/adr-0003-posting-identity.md))
- **Unsettled conflicts:** hold only the affected criteria, never the run.
  ([ADR-0004](./decisions/adr-0004-ledger-authority.md))
- **Plan approval:** review with the pull request; the plan is locked before
  implementation. ([ADR-0001](./decisions/adr-0001-plan-approval.md))
- **Screenshot storage:** Action artifacts carry the run; an orphan
  `qa-assets` branch is the long-term home.
  ([ADR-0002](./decisions/adr-0002-screenshot-storage.md))

## Open questions

None. Both questions from the draft are closed:

1. Plan approval: review with the pull request, the plan locked before
   implementation. ([ADR-0001](./decisions/adr-0001-plan-approval.md))
2. Screenshot storage: Action artifacts carry the run, an orphan `qa-assets`
   branch holds them for the long term.
   ([ADR-0002](./decisions/adr-0002-screenshot-storage.md))
