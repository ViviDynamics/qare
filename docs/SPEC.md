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

## Readiness report

The first run on a repo with no `.qa/` does not QA anything. It inventories how
the app boots, which outbound services it reaches, which are stubbed, and which
are not, then posts a readiness report and files one issue per missing stub.

## Surfaces

One TypeScript codebase, one core, thin adapters:

| Package | Purpose |
| --- | --- |
| `@qare/core` | plan, execute, judge, report; provider interface; `result.json` schema |
| `@qare/cli` | `qare init`, `qare readiness`, `qare run`, `qare judge` |
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

Later: per-PR preview namespaces via the Argo CD ApplicationSet pull request
generator, Argos for visual review, API before/after on Go services.

## Out of scope for now

- Merging or approving PRs.
- Models other than Claude.
- Recording production traffic.
- Replacing unit and integration suites; QARE runs them, it does not own them.

## Open questions

1. Should a human approve the plan before implementation, or only review it with the PR?
2. Where do screenshots live long-term: Action artifacts (90 days) or a `qa-assets` branch?
3. GitHub App for posting, or a bot token to start?
