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

Both sides (#147). To find one, a run of a profile that boots an app executes
the same locked plan twice: against the app booted from the base revision,
then against the app booted from the head, each under an isolation of its own
(#53), the base torn down before the head boots. The result says, per
criterion, what the base showed:

| At the base | At the head | Reported as |
| --- | --- | --- |
| proven | failed | `failed`, a regression (`regression: true`), with the base's evidence beside the head's |
| failed | failed | `failed`, not a regression (`regression: false`): behaviour that does not work yet |
| failed | proven | `proven`: new behaviour, or a fix |
| not compared | anything | the head's outcome, with why nothing was compared |

Not compared is never passed and never a regression. A base that has no
checkout, has no profile, or will not boot is not compared, for every
criterion, and the result names why once. A check that cannot run at the base
(the behaviour is new, so what it needs is not there) is not compared for its
criterion alone. The verdict is the head's: the base side decides only which
of the head's failures are regressions, so nothing that happens at the base
can turn a criterion green. The comparison is computed in code from the
executed outcomes of both sides. A criterion the verifier fails after its
check passed is `failed` with the verifier's reason and is never named a
regression, because no model output creates one. A waiver does not cover a
regression: a waived criterion that regressed still fails the run, and the
comment says so on its row.

The base side has a cost, two boots and two runs of the plan, and the profile
states it (`base` in `config.yml`). `criteria: ledger` runs at the base only
the criteria the ledger at the base already carries as active, which are the
old behaviours a regression can be found in; `criteria: none` runs nothing
there; `budget: 10m` bounds the base side's wall clock from the moment it
starts. Whatever those leave out is reported as not compared, with the limit
named.

A run against a target (#122) has one side by definition and says so, and so
does `qare check`, which checks the app as it runs.

Not evaluated (#203). A pipeline that fails before it records a verdict
(a tool that will not install, an image that will not pull, a planner that
will not answer, or judge failing to post) evaluated no criterion, so it has
no verdict above. The report job posts the sticky comment headed `QARE run:
not evaluated (qare or its environment failed)` and a failing check run
titled `QARE: not evaluated (qare or environment failure)`. Both name the job
and step that failed and say the failure is on qare's side or the runner's,
not the project's. The check fails closed: not reaching a verdict never
passes. A failed or blocked verdict is never reported this way. It is in
`result.json`, and judge publishes it even though it left execute red. When
execute recorded a verdict and judge then failed before posting it, the report
says so instead: the comment is headed `QARE run: verdict not published (qare
failed after checking)`, names the recorded verdict and the step that kept it
from the pull request, and points to the evidence artifact that holds it. A
verdict already in the sticky comment for the same head (judge posted it, then
failed creating its check run) is never replaced by a report. A run
whose execute step recorded no readable verdict fails execute, so it can never
leave the pipeline green with nothing posted.

## Pipeline

Four jobs, so the model and the GitHub token never share a machine with PR
code, plus a report job for a run that reached no verdict. Every secret-holding job builds and runs qare from the base commit, a
revision the pull request cannot change; the pull request contributes data
only: its body, the linked issues, the diff, its `.qa/` profile read as YAML,
and the artifacts execute uploaded.

| Job | Secrets | Network | Does |
| --- | --- | --- | --- |
| **collect** | GitHub token | yes | Reads the pull request body, linked issues and diff from the base commit's checkout; writes `criteria.json`. Never executes PR code. |
| **plan** | model key | yes | Reads the criteria, the diff and `.qa/`; writes `plan.json` mapping each criterion to checks tagged `command`, `flow` or `visual`. The planner is also told any flow action kinds the change itself introduces, read from the diff as data. The planner is told the run's declared inputs — the profile directory and every path the diff touches — and a command check reading anything else, the plan file itself included, is corrected against them (#162, #156). The planner is also told that the executing job runs no model, so a criterion whose evidence can only come from a model-driven session is marked unplannable instead of planned as a check for an artifact the pipeline never produces (#168). It is also told the profile's QA.md instructions, redacted and size capped, and the commands the profile declares as known to work; a plan whose command check runs a program that is neither the program of a declared command nor one of the standard tools the runner carries is corrected, naming the program, then refused (#156). A plan the loader still rejects after its correction round comes out with every criterion marked `unplannable` naming why (#64), so the pipeline reports the planning gap instead of failing red. Never executes PR code. |
| **execute** | none | stub containers only | Boots the app at the merge base and at the head with stubs, runs the plan on both sides, saves artifacts and raw results. The run image carries no git, so the step checks the base commit out on the runner, outside the head's checkout, and hands it to `qare run --base-repo`; both sides run in this one job, which holds nothing (#147). |
| **judge** | model key, GitHub token | yes | Computes verdicts in code from raw results, runs the verifier model on the evidence, posts the comment and check. The plan is loaded with the same flow action kinds the plan step was given. Runs whenever execute recorded a verdict, including a failed or blocked one that left execute red (#203). |
| **report** | GitHub token | yes | Runs only when the pipeline failed and no verdict reached the pull request. Reads the run's jobs from the Actions API and posts the not-evaluated comment and check naming the job and step that failed (#203). Builds qare from the base commit. Never executes PR code. |

Execute stages, per side (base, head):

1. Provision the application under test from the `.qa/` profile (#75): boot a server from its compose recipe, install a client build from the artefact the profile names for this side, or reach a preview URL. Then prove it is up with a health check the harness runs: an HTTP probe for a server, a launch that opens its first window for a desktop build. A provisioning that fails is `blocked`, with its log attached as `provision.log`, and no criterion is `failed`. See [Provisioning](#provisioning).
2. Seed fixtures, log in test accounts.
3. Run `command` checks (exit code and output), `flow` checks (a fixed action set driven by a client driver, or existing suites), `visual` checks (a page captured at named widths and themes; the head's captures are compared with the base side's, see [Visual checks](#visual-checks)), and `mail` checks (a message waited for and read). Each `command` check also writes `command.json` beside its streams: the command as run, its outcome, and the exit code it closed with. A check that passes silently (`test -f`, `grep -q`) saves no output, so the streams alone read as a check that never ran; the record is the evidence that the harness ran it and captured its result.
4. Record every outbound connection attempt. Anything outside the stub map is a `refused: missing stub` finding.
5. Tear down what was provisioned. A client build the run installed is removed when its side's checks are done; a booted stack is left up for its logs and taken down by the pipeline when the run ends.

Exploration (#87). When the planner explores a running application, an exploration tool server runs inside the execute sandbox beside the booted app, and the plan step's model session connects to it over the network: the only thing that crosses is tool calls and their results. The server holds no secret — the sandbox environment is built from an allowlist that carries only what an app needs to run, so the model key and every token stay out — and it serves exactly four read-only tools, `observe`, `snapshot`, `navigate` and `capture`; nothing that writes files or runs commands is reachable over the channel, whatever the plan, the profile or a tool result asks for. Every tool result is treated as untrusted input: it is handed to the model fenced as data, and nothing in it can change the plan's schema or the run's policy. Exploring the merge base or a deployed target needs no sandbox split, because there is no PR code beside the app there; the channel is on by default wherever it is available, and off wherever it is not.

Judge:

- Criterion verdicts come from executed results only.
- Regressions are computed from both sides (#147). `result.json` carries what the base showed for each criterion, so the judge is handed a base wherever a result is judged (`qare run`, `qare judge`, replay, this job), and it alone decides what regressed.
- A visual check's outcome is computed from its captures and diffs (#143): a difference between base and head fails it, and a capture or a comparison that could not be made leaves it unverified. No model reads a screenshot to decide it.
- The verifier model gets the criteria, diff and evidence in a fresh context and reports only criteria the evidence does not actually show. Its findings can downgrade a verdict, never upgrade one. A verifier that gives no readable answer leaves the criteria it was asked about unverified, so the run blocks rather than passing unchecked.
- A blocked run whose every unverified criterion is one the planner could not plan, whose planned command cannot run without a shell, or whose check could not start at all (the planner named an executable the runner does not have), reports the criteria by name and the check run comes out neutral: the gap is in the planning vocabulary, and nothing was disproven. Any other blocked run — a check that could not reach the app, an environment that would not boot — is a fault and stays red.
- A planner whose plan the loader rejects through its correction round ends in the same neutral path: the plan command writes every criterion as `unplannable` naming the rejection, and the run reports rather than fails red.
- A command check may read only the declared run inputs: the profile directory and the paths the diff touches. The plan file itself is off limits — it is what this planning step writes, so a check that reads it shows what the planner wrote, never that the change under test holds (#156). The run's own outputs — `result.json`, `judged-result.json`, `comment.md`, the evidence directory — do not exist while a check runs, because the run writes them when it ends. A check may run only the standard tools the runner carries, plus the program of a command the profile declares; the harness's own CLI sits on the image's PATH and still runs no check, because the harness is the thing under test, not its witness. The planner is told this up front; a plan that still reads an undeclared path after its correction round marks the criterion unplannable and the run stays neutral (#162).
- A plan whose command check fills a path placeholder with a file the checkout does not carry is corrected, then refused, like any other contract violation (#201): an invented script is a model-step guess, and the correction round catches it before the runner turns it into a red verdict.
- A command check whose profile command declares a filter and a report format is proven only if its report shows the filter selecting tests: none or all selected leaves the check unverified naming the filter and the counts, and the selected names are saved to evidence, because a whole-suite run does not prove a filtered criterion (#157). A command with no declared filter is proven by exit 0 as before.
- A criterion whose evidence can only come into existence through a model-driven session is unplannable: the executing job runs no model, so no check can produce that evidence, and the run publishes evidence only when it ends. Evidence under a declared profile directory is not an exception — a command check reading it is corrected, then refused like any other undeclared input (#168).

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
  login:
    fixture: fixtures/users.yml
    role: admin
    totp: { secret: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ }  # a test-only secret the seed step plants; defaults: 6 digits, 30s, SHA-1
    # backupCode: { value: 4321-9876 }                  # an alternative factor, for apps that accept one
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
commands:                        # optional: invocations the planner may rely on (#156)
  test:
    run: "pnpm --filter {{package}} exec vitest run -t {{pattern}}"  # the planner fills {{placeholders}} itself
    about: runs the tests of one package whose name matches the pattern
    filter: pattern              # which placeholder is the test filter (#157)
    report: vitest-json          # the machine-readable report the command prints: vitest-json, junit-xml or node-tap
base:                            # optional: what the base side of a run costs (#147)
  criteria: ledger               # all (default), ledger (only criteria the base's ledger carries), or none
  budget: 10m                    # the base side's wall clock; what did not run is "not compared"
a11y:                            # optional: what an accessibility audit holds a page to (#149)
  standard: wcag22aa             # the rule set: wcag2a, wcag2aa, wcag21a, wcag21aa or wcag22aa (default)
  fail: [serious, critical]      # the impacts that fail a check (default); minor and moderate are reported
  standing: true                 # audit every action flow, without a planned a11y check
  accept:                        # known violations, each carried with its reason
    - { rule: color-contrast, page: /legacy, reason: "brand grey, replaced in the redesign" }
mail:                            # optional: where mail checks read from (#65)
  source: { kind: mailpit, url: "http://localhost:8025" }  # the catcher in the stack
  # domain: qa-mail.example.com  # what follows the @ of the address a run mints
ux:                              # optional: the advisory UX review (#150), which never decides a verdict
  review: true                   # false turns it off (default: on, for runs whose flows drove pages)
  rules:                         # house rules the reviewer holds screens to
    - An error message says what went wrong and what to do next.
findings:                        # optional: who a finding on main reaches (#154)
  fallback: acme/qa-leads        # a person or a team, mentioned when no change can be blamed
  bots: [release-robot]          # logins whose pull requests are a bot's, beyond the ones GitHub marks
redact:                          # optional: fixture data that must not be published
  values: ["jane@pilot.example"] # literal strings
  patterns: ['CUST-\d{6}']       # regular expressions
  masks:                         # page regions blacked out in every screenshot
    - css=.fixture-banner        # at capture (#119); a selector that does not
    - '[data-testid="fixture-email"]' # parse fails the profile when it loads
```

A profile that checks an app already running (staging, a preview deployment,
a public site) names a `target` instead of `app`; see [Running against a
deployed environment](#running-against-a-deployed-environment).

Agent-written stubs are allowed only when flagged: any check that depends on a
stub QARE wrote itself is shown as such and cannot count as `proven` without a
human note.

### Several profiles (monorepo)

A repository that holds several apps keeps one profile per app, in its own
subdirectory of `.qa/` (#55):

```
.qa/
  admin/config.yml   # boots the admin app
  admin/QA.md
  storefront/config.yml
  storefront/QA.md
  fixtures/          # shared across profiles: no config.yml here
  stubs/
```

Discovery finds the single root profile at `.qa/config.yml`, or named profiles
in the subdirectories that carry a `config.yml`. The two forms do not mix: a
`.qa/` that holds both is a layout nobody can select from, and loading it fails
closed. The root form is present exactly when `.qa/config.yml` is, so a root
profile whose `QA.md` is missing is malformed, not absent, and fails closed
rather than reading as a named-profile layout. The name `default` is reserved
for the root form: a `.qa/default/config.yml` is a layout nobody can select
from, so it fails closed too. A subdirectory without a `config.yml` is not a
profile; it is fixtures, stubs or learned notes the profiles share. A boot
profile keeps its `fixtures/` and `stubs/` beside its own `config.yml`, or
shares the ones the `.qa/` root keeps when it has none of its own.

Selection follows what a change touches: the root profile is always selected,
and a named profile is selected when a touched path falls under an area its
`paths` (added to `config.yml` as a list of `apps/admin` style prefixes,
matched at a segment boundary; the area `.` covers the whole repository), or
under the profile's own `.qa/<name>/` directory, so editing a boot recipe
selects the app it boots. A profile that declares no `paths` is selected only
by its own directory. A change that matches no profile selects none, and the
caller refuses: nothing was checked, and a verdict would have to say so.

`qare profiles [path] [--diff <path> | --paths a,b]` reports the selection
before anything runs.

A run may also check several apps in one run: its job carries named profiles,
one group per app, each with its own criteria. Every app of the group boots
under an isolation of its own (its own compose project, network and host
port); a run over several apps always mints each isolation itself, so a
caller-carried isolation is refused instead of shared, and the run hands
every app's isolation back, so a caller can stop each stack it booted. The run
writes one result carrying a verdict per app, and the comment reports them in
one comment, one section per app. Every app's redaction rules are known before
any app runs, so a secret any app declares is swept from the whole run's
evidence, not just its own. Criterion ids must be unique across every group of
the job, because a criterion's id names its evidence directory. A group that
cannot run (a profile that is not there, an isolation that will not mint, a
boot that never came up) reports its criteria unverified with the reason named,
and the other apps still run.

A plan may name the apps it is planned against: `profiles`, one
`{ name, path }` per app, whose path is exactly `.qa/<name>` — judge and
redact re-read every named profile from the .qa root the run publishes, so a
plan selects its apps from the named directories of that root — and every
criterion names the app it is checked against. `qare run --plan` builds the
several-app run from such a plan and takes no `--profile` for it. An app that
declares a hosted target is checked in its own single run instead: a
several-app result names no target.

The result of a several-app run carries where each app's profile lives, so
judge and redact apply the same rules the run did: an inline profile travels
in the result itself, and a named profile is re-read from the .qa root with
the fixtures and stubs the root shares, exactly as the run loaded it. A
profile reference the artifact cannot carry is refused, never silently read
from the app's name alone.

### Run-scoped values

Strings in the profile, the seed step, commands, flows and checks may carry
`{{run.<name>}}` references, which the harness substitutes with values minted
fresh for each run. The first minted value is a per-run mail address
(`{{run.mail_address}}`, the run's id on the profile's `mail.domain`, or on
`localhost` when it names none), and a run id and started-at timestamp come
free with it (`{{run.id}}`, `{{run.started_at}}`). A run against a target also mints
`{{run.target_url}}`, the URL its checks point at, and a run that boots its own
app mints `{{run.app_port}}`, the host port its compose project publishes the
app on (#53). Checks may also carry
`{{mail.<name>.link}}` references, which the harness substitutes at run time
with artefacts the run has observed (single-use artefacts, below). This is
substitution, not a language: no expressions, no conditionals, no nesting. A
reference to a name the harness does not mint, to an artefact from a mail check
that has not run yet, or an unterminated `{{`, fails the run closed at plan time
and nothing boots. The minted values are written to the run's evidence, so a
reader can see which address a run used, and two concurrent runs never collide.
Flow definitions substitute with the flow runner.

### Run isolation (#53)

Two runs of the same repository at the same time never share a compose stack.
Every run boots its app under its own compose project, `qare-<run id>`, so the
project's name, network and volumes belong to that run alone. The app's host
port is allocated per run too: the harness picks a free port and hands compose
both it and the run id as `QARE_APP_PORT` and `QARE_RUN_ID`, so a profile's
compose file binds it with `ports: ["${QARE_APP_PORT:-3000}:3000"]` and two
concurrent runs never collide on the host.

The health URL names where the app answers. A profile may write the port as
`{{run.app_port}}` — `http://localhost:{{run.app_port}}/up` — and a plain local
port in the health URL is pinned to the run's port either way, so the run
proves the app it booted and not another run's. A URL the harness cannot name
(a remote target, or one with no explicit port) is left unchanged.

A run writes `isolation.json` into its evidence before booting — the project,
the run id, the port, the started-at timestamp — so whatever happened to the
run, what it booted is findable. Cleanup has three paths: a boot that outlives
its health deadline is torn down by the boot watchdog; a canceled `qare run`
(SIGINT/SIGTERM) stops its own project before the process exits; and a run
that died without stopping its stack is reaped by hand with `qare reap`, which
takes down a named run's project, or — with no names, the quiescent sweep —
every running compose project named `qare-*` and nothing else. A stuck run is
reaped rather than holding the queue, and a sweep is for when no qare run is
left working, because it downs active runs too.

### Visual checks

A `visual` check (#143) captures one page at each width and theme and, when
the run has two sides, compares each capture with the same page at the base.
The plan names the screenshot, the page, and the widths and themes the
criterion is about; a check that names no width or theme takes the profile's
`visual` section, and one with no theme anywhere is captured in `light`, the
browser's default colour scheme.

```json
{ "kind": "visual", "name": "dashboard on a phone", "screenshot": "dashboard", "url": "/dashboard", "widths": [390], "themes": ["light"] }
```

`url` is a path on the app: below the target URL on a target run, and on the
origin the run proved healthy on a run that booted the app, so the base and
the head each capture their own app. It may be a full URL and may carry run
values. Without it the check captures the app's root. The page is opened at
the URL as written, at a viewport of the width named.

The base screenshots are the ones the base side of the run saved (#147).
There is no other way to get one: the base side captures into `base/`, is
torn down, and the head side reads those captures and diffs its own against
them, pixel for pixel. Baselines are never kept between runs.

| What happened | Outcome |
| --- | --- |
| Every capture taken, every pair identical | `proven` |
| A pair differs at any width and theme | `failed`, with the diff image as evidence |
| A screenshot could not be taken, or the backend did not start | `unverified`, naming why |
| The base side saved no screenshots (it did not boot, the profile's `base` limits left the criterion out, the page could not be captured there) | `unverified`, naming why, never `failed` |
| The two sides were masked differently | `unverified`: a region masked on one side only would show as a difference |
| The run has one side (a target, #122, or a run nobody asked a base of) | `proven` from the head's captures alone; the record says there was nothing to compare with |

The outcome is computed in code from the captures and the diffs. Which
differences a change intended is not decided yet (#40), so any difference
fails the criterion, and a difference against the base is a regression by the
rule above: proven at the base, failed at the head. An outcome that only says
the base had no screenshots this time is not cached (#47).

Masks (#119) are the same at both sides: the head profile's `redact.masks`
are in force at the base too, beside the base profile's own, so a mask the
change adds never shows as a difference.

Evidence, under the check's directory: `visual.json` (the page, the side,
each capture with the masks in force for it, each diff, the outcome and its
reason), `head/<width>x<theme>.png`, and on a compared run
`base/<width>x<theme>.png` and `diff/<width>x<theme>.png` for each pair that
differs. The diff image is the head, dimmed to grey, with every differing
pixel in red. On a target run `outbound.json` records what the screenshot
browser reached, and a host the profile does not declare refuses the run, as
it does for a flow (#122). The text of the record is redacted like any other
evidence; the images are masked at capture, and the pipeline's sweep (#52)
accepts them as images.

### Accessibility checks

A screen can meet every stated criterion and still be unusable with a keyboard
or a screen reader. Accessibility rules are objective, so they are checked in
code and decide the outcome (rule 3). An `a11y` check (#149) runs a rule
engine, axe-core, in the pages it visits. It names its page, or reaches it
with the actions a flow takes, never both; with neither it audits the app's
root.

```json
{ "kind": "a11y", "name": "settings are accessible", "url": "/settings", "inferred": true }
{ "kind": "a11y", "name": "the dashboard after sign-in", "actions": [{ "action": "open", "url": "/login" }, { "action": "click", "element": { "role": "button", "name": "Sign in" } }, { "action": "assertText", "text": "Dashboard" }] }
```

The planner may add one to any criterion about a user interface, marked
`inferred` unless the criterion asked for it. A profile whose `a11y` section
says `standing: true` audits every action flow of the run without a planned
check, and what the audit finds decides the flow's criterion. A flow that
names a `suite` runs a browser of its own, which nothing here can audit.

The audit rides the flow's own session, so nothing is driven twice. The page
is audited where the plan itself declared it settled: after each `open`,
after each `waitFor`, `assertText` and `assertElement` that held, and at the
end of a flow that passed, skipping a point nothing acted on the page since
the last one. Each point is audited at every width and theme: the check's own,
else the profile's `visual` section, by resizing the viewport and emulating
the colour scheme in place and putting both back. With no width anywhere the
page is audited once at the viewport the flow ran in, and with no theme in
`light`. The engine's source is evaluated into the page, never fetched by it.
Only the page's own document is audited; content inside a frame is not.

The profile's `a11y` section says what a page is held to: `standard` is the
rule set, `fail` the impacts that fail a check, and `accept` the violations
the project knowingly carries, each with a `reason` and optionally narrowed to
a `page` (the URL path) and an `element` (its snapshot path or selector). The
configuration in force is written into the record, so a change that accepts a
violation shows that it did.

New and existing violations are told apart on the two sides the run already
executes (#147), the way a visual check gets its base screenshots: the base
side audits and saves its record under `base/`, and the head side reads it.
A head violation is matched against the base audit of the same point of the
flow, width and theme, first on its exact identity (rule, snapshot path,
selector) and then on its path with occurrence indexes dropped, each base
violation matching once, so an unnamed button added beside an old one is one
new violation and not two. The head profile's rule set, impacts, accepted
list, widths and themes are in force at the base too, so a pull request that
turns the audit on is compared under one set of rules and old debt does not
fail it.

| What happened | Outcome |
| --- | --- |
| No violation at a failing impact, or only accepted ones | `proven`; milder findings are listed as `reported` |
| Two sides, and every failing violation was already there at the base | `proven`; each is listed as `existing` |
| Two sides, and a failing violation the base audit did not have | `failed`, naming the rule and the element; a regression by the rule above |
| Two sides, failing violations at the head, and no base audit to hold them against (the base did not boot, the profile's `base` limits left the criterion out, its flow stopped earlier) | `unverified`, naming why, never `failed`; not cached (#47) |
| One side (a target, #122, or a run nobody asked a base of) and a failing violation | `failed`: nothing excuses it |
| The audit could not be made (a driver with no audit, axe-core missing, the page threw) | `unverified`, naming why |
| The flow part failed an assertion, or could not run an action | the flow's own outcome; what was audited on the way is still recorded |

A head with nothing wrong is proven without reading the base: nothing can be
new on a clean page.

Evidence, under the check's directory beside the flow's own: `a11y.json` and
`a11y/<point>-<width>x<theme>.png`, a full-page screenshot of each audited
page that had a violation, masked like every other screenshot (#119) and
withheld while a one-time code is on the page (#64). The record names the rule
set, impacts and accepted list in force, each audit, and each violation on
each element: its rule, impact and help text, its status (`new`, `existing`,
`accepted` with the reason, `reported`, `uncompared`), the page, the
element's role, accessible name and path from the normalised snapshot (#82),
its selector, and the screenshot it appears in. An element the snapshot does
not hold (the document itself, text with no role of its own) is named by its
selector alone. Markup is not recorded: it is where fixture data leaks. The
record is redacted like any other evidence, and the audits are swept before
they are compared, so a redacted name reads the same at both sides.

The criterion's result carries the counts (`a11y`), and the comment lists
them by criterion under "Accessibility", so violations that fail nothing are
still reported where the verdict is read.

### Advisory UX review

Some problems a change introduces are judgement calls no criterion states: a
confusing flow, a label that does not match the ones around it, an error
message that helps nobody, a screen that breaks the patterns of the product.
A model can spot these, and a model decides nothing (rule 3). So the review
(#150) is advisory: its findings are shown to a person, and are never in the
verdict.

It runs in `qare judge`, after the verdict is computed, as the second thing
judge asks the model: through nare, with the read-only tool set and the
evidence directory as its file root, exactly as the verifier is run, in the
step that already holds the model key (rule 7). It is on by default. A run
with no screen makes no call, and neither does `--runner none`, a refused
run, or a profile whose `ux` section says `review: false`.

A screen is the evidence directory of one check that drove a page: one that
holds a flow's action log, an accessibility snapshot (#82) or an audit record
(#149). The run checks the criteria of the change, so the screens its flows
visited are the screens the change touched; the base side's evidence is not
reviewed. For each screen the reviewer is handed the text evidence the
harness saved, with the text of the criterion the check belongs to, `QA.md`,
and the profile's house rules (`ux.rules`: a design system, voice and tone,
patterns to hold to). All of it is swept with the run's redaction rules before
the model sees it, as the planner's copy of `QA.md` is. In a run of several
apps each screen names its app, and a rule is held to the screens of the app
whose profile wrote it. It reads no screenshot: nare's `read` tool returns
text, so the reviewer works from the snapshots and logs and is told so
(ViviDynamics/nare#48 asks for images).

Each finding names its screen, a category (`label`, `error-message`,
`consistency`, `flow`, `copy`, `layout`, `feedback`, `other`), a severity
(`high`, `medium`, `low`), what was seen, why it matters, and the element it
is about. Code rebuilds the answer field by field:

- a finding about a screen the reviewer was not given is dropped;
- the criterion and the screenshot are attached from the screen, so a finding
  names only a screenshot the harness saved (rule 4), and none when it saved
  none;
- text is cut to one bounded line and redacted with the run's rules, and at
  most 12 findings are kept, the most severe first;
- nothing else the model wrote is carried. The answer schema has no field
  for a criterion, an outcome or a file.

The boundary with the verdict is structural, and a test holds it:

- The findings live under `advisory` in `judged-result.json`. The judge
  builds its result from named fields that do not include that key, so a
  result judges the same with and without it, whatever the findings say.
- The check run and judge's verdict line are written from the judged result
  before the review is added. The comment shows the findings in a section of
  its own, "Advisory UX review", below everything the verdict rests on, saying
  that they are a model's opinion, not evidence, and that the verdict was
  decided without them.
- A reviewer that throws, stops, answers something that is not a findings
  list, or has not answered within five minutes (its process is then killed)
  is `unavailable`, with the reason and no findings. The verdict, the
  exit code and the check run are what they were. This is the one place a
  model failure does not stop anything, because nothing rests on it.
- `qare replay` compares a stored verdict without its `advisory` key: the
  recompute calls no model, and the review is no part of the verdict.

A person acts on a finding with a reply on the pull request, written as the
first line of a comment and naming the finding by its id:

- `/qa-dismiss <id>`: the finding is not raised again on that pull request.
  A finding's identity is its screen, its category and the element it names
  (what it saw, when it names none), hashed to eight characters. The next
  run's reviewer is handed what was dismissed and told not to report it
  again, and a finding with a dismissed identity is dropped in code and
  counted. A model that rewords a dismissed finding and names its element
  differently is caught by the first half or not at all; that half is
  advisory too.
- `/qa-promote <id>`: the finding becomes an issue, carrying what was seen,
  why it matters, the screen, the screenshot (the link it was pushed to on
  `qa-assets`, or its name when it was not pushed), and a link back to the
  pull request. qare files no issue unless asked: a model's opinion does not
  interrupt anyone.

`qare-action advisory-replies` carries the replies out, as a sweep of the
pull request's comments that is safe to repeat: each reply is answered once,
in a comment that is also the record, so nothing is dismissed, filed or said
twice, and a finding promoted a second time is pointed at its issue. The
issue carries a marker naming the pull request and the finding, so a sweep
that died after filing it and before recording it finds the issue again
instead of filing another. The
findings ride qare's evidence comment as data, and both they and the records
are read only from comments the posting identity wrote; a reply counts only
from an owner, a member or a collaborator of the repository. The pipeline
runs the sweep in judge before the model is asked, and again the moment a
reply is made when the caller listens for `issue_comment`
([pipeline.md](./pipeline.md)).

### Mail checks

A `mail` check waits for one message at an address and reads it. The address
and every matcher (`from`, `subject`, `body`) are literal substrings, may carry
`{{run.<name>}}` values, and all matchers must match the same message. The
harness considers only messages the source received after the criterion's
checks began, so a rerun waits for a new message instead of matching the
previous run's mail. The window opens with the criterion, not with the mail
check, because the check that makes an app send runs before the mail check: a
message sent while it ran has already arrived by the time the wait begins. So
the check that causes a message sits before the mail check, in the same
criterion.

A mail check may declare `code: {}` when its message carries a one-time code
(#64): the harness extracts the code from the body — by default the first run
of six to eight digits, or the first capture group of a declared `code.pattern`
— publishes it as `{{mail.<name>.code}}` for later checks, and sweeps it from
the evidence like any other secret. A message with no code in it is
`unverified`, naming the mail check and the pattern it looked for.

Where the messages come from is the profile's business, not the plan's, so the
same check text reads from whatever source the profile declares (#65). Every
source sits behind one interface with four reads: list by address, list by
arrival time, read a message, delete an address's messages. The profile's
optional `mail` section names one source:

- `mail.source: { kind: mailpit, url }` reads a Mailpit catcher in the stack
  over its HTTP API. `url` is where its web interface answers, webroot
  included. Mailpit's search matches a substring of an address, so the adapter
  filters recipients exactly and deletes by message id.
- `mail.source: { kind: inbox, url }`, or the older `mail.inbox: <url>`, is the
  listing contract any sink can implement: a GET of the URL with `address` and
  `after` query parameters answers `{ "messages": [...] }`, each with `from`,
  `subject`, `body` and `received_at`; a DELETE of it with `address` removes
  that address's messages and answers `{ "deleted": <count> }`.

A source URL may carry `{{run.<name>}}` values, so a stack can serve its
catcher behind the one port a run mints. The runner polls until a message
matches or the check's timeout passes.

`mail.domain` is the domain the run's address is minted on, for a source that
only receives mail for a domain the project controls. Use the minted address
wherever the app is asked to send: one address per run means two concurrent
runs never read each other's mail, whatever source they share. A dedicated
subdomain for test mail keeps it apart from mail people read, and a person's
mailbox is never a mail source.

When a run finishes it deletes the mail at the address it minted, so an address
is never found again with stale mail behind it, and writes what it deleted to
`mail-cleanup.json` in the evidence. Only the minted address is cleaned: a
literal address may be shared with a run still waiting at it, so it is left
alone and the record says so. Cleanup decides nothing: a source that cannot
delete is named in the record and the verdict stands.

Adapters for a real provider on a deployed environment (a hosted inbound
endpoint with a credential, IMAP or a mailbox API) are not built yet, and
neither are assertions on a message's authentication results; #217 and #218 track
them. Until then a profile declares a sink.

A message that matches is proven, and the evidence records what the harness
actually observed: the sender, the subject, an excerpt of the body, the wait,
and links extracted from the body, marked as harness-produced data rather than
claims. The criterion's result carries the same record (`mail`), and the
comment shows it under "Mail", so the message that proved a criterion is read
where the verdict is. Before any of it is written, every mail address and
every run of digits shaped like a one-time code is swept from the subject and
the body, whether or not the check declared a code; the sender stays, because
it is the app's own sending identity; and the body is never stored whole, only
the excerpt. The first link, which a later check may follow, is swept as the
secret it is (single-use artefacts, below). A message that never arrives, and a mailbox that cannot be reached, are
both `unverified` with the reason naming the mailbox — neither is a product
failure, and neither may be reported as one.

### Single-use artefacts

A confirmation link, a password-setup link and a one-time code are all spent the
moment they are used. A mail check may declare `singleUse: true`: the links in
the message it waits for are artefacts, and the harness follows each at most
once per run.

A later check reads the artefact with a `{{mail.<name>.link}}` reference, which
resolves at run time to the first link of the message `<name>` read. Plan time
enforces the ordering before anything boots: a reference must name a mail check
that runs earlier in the job, must read a field the mail check exposes (`link`
and `code`, the latter only when the check declares `code`), and cannot be
ambiguous, so a name shared by two earlier mail checks is refused. The seed
command and a mail check's own matchers carry `{{run.*}}` values only — a mail
artefact does not exist before a run starts.

The first consumer to substitute a single-use artefact consumes it; a later
check that would substitute the same value is skipped `unverified`, naming the
spent artefact and the criterion that consumed it, and its command never runs. A
retry requires a fresh message: the same value is not used twice inside a run,
and a mail check without a message, without its artefact, or with its artefact
spent is `unverified` with the reason naming the artefact — never failed. A mail
check that does not declare `singleUse` may be read by every consumer.

The consumer's evidence records the consumption in `consumed.json`: the artefact
and the mail check it came from, the criterion and check that consumed it, and
the response — the consuming command's status and its stdout and stderr paths.
Flow checks read artefacts the same way (#64): an `open` action's URL and a
`type` action's value may carry `{{mail.<name>.link}}` or `{{mail.<name>.code}}`,
resolved at run time from the message the run observed, and every value that
landed on the page is swept from the action log like the codes the harness
generates itself.

### The second factor

An app that signs its users in through a second factor is checked through that
factor, not around it (#64). The profile's `app.login.totp` carries a test-only
secret the profile's own seed step plants in the QA database — RFC 6238
settings, with sane defaults: six digits, a 30-second period, SHA-1, and
`backupCode` for an app that accepts a recovery code instead. The secret is
swept from every piece of evidence the run writes, alongside the profile's own
redaction rules. The guidance to repos is to seed a known secret and let the
harness log in the way a person does, rather than to disable the second factor
for QA: a login that skips the factor skips whatever the factor protects.

The plan asks for the second factor with two actions: `{"action":"totp",
"element":{...}}`, which types the code the harness generates from the seeded
secret at the moment the flow runs, and `{"action":"backupCode","element":{...}}`,
which types the seeded recovery value. No plan, and no model, ever carries the
secret or a code: the plan names an element, the harness does the math. A flow
that asks for a second factor the profile does not seed is `unverified` with
the gap named before anything runs.

A code typed against a window that ends before the app reads it is born stale:
the harness waits out a boundary that is about to cross, and a code that
straddles a window while the flow is moving is retried once in the window it
lands in (RFC 6238 §5.2). A factor type that fails is `unverified`, never a
failed criterion: the login did not complete, and the change under test is not
what refused it. A step after the factor was typed reports what it observed —
an assertion that fails once the factor was accepted is a product failure,
`failed`, with the capture still withheld, because page visibility alone is not
a rejection signal (#64). And because redaction cannot read pixels, every
screenshot of a flow whose page carries a code — generated, or read from mail —
is withheld, and the evidence says so. The same sweep follows the code: a
command that echoes a mail-borne link or code publishes it redacted, and a flow
failure whose reason quotes a value the flow put on the page publishes the
reason redacted.

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
`qare ledger migrate` moves a ledger between them without losing history. A
migration carries the document whole, so ids and the hash-chained history
arrive exactly as they left; `--dry-run` reports what would move, and a
migration onto a backend that already holds a ledger is refused unless the run
passes `--force`. A source that holds no ledger is refused too, because a typo
in the flags would otherwise look like a migration of nothing, and the write
onto the destination is checked against the state the migration observed, so a
ledger that changes while the migration runs is never clobbered.

| Backend | Where | Good for |
| --- | --- | --- |
| `branch` (default) | an orphan `qa-ledger` branch in the same repo | keeping criteria out of the working tree while staying versioned, diffable and reviewable, with nothing to host |
| `files` | `.qa/criteria/*.yml` on the working branch | small repos and teams that want criteria in front of them next to the code |

A separate store only earns its keep if it stays legible, so transparency is a
requirement of the backend, not a feature on top:

- Every change records who made it, when, and why, and the records are chained,
  so editing, dropping or reordering any of them makes the ledger refuse to
  load: history is never rewritten. Deleting the last records is the one thing
  a chain cannot see from inside the document, so a rollback is checked
  against an external copy of the chain's head, such as the published history
  file.
- `qare ledger` reads either backend the same way.
- `qare ledger export` writes the whole ledger, entries and history, as plain
  files at any time, so nobody is locked in, and `qare ledger import` reads an
  export back through the same strict loader, records the import itself with
  who and why, and refuses an import that does not carry the target's own
  history forward, so an export loses nothing and history is never truncated.
- `qare ledger publish` writes the current state where the team already looks,
  as a plain markdown file that names the criteria that are unverified, stale,
  changed after the run that last verified them, or quarantined by an open
  question whose criterion is still held. Publishing is explicit, and the
  import that brings a ledger home refreshes the view it publishes.

Lifecycle:

- **Ingest.** QARE reads acceptance criteria from an issue or PR and proposes
  ledger entries. `qare ingest` turns what the sources state into a payload:
  criteria the ledger already carries are kept back as duplicates, wording no
  check can prove is kept back with a single comment on the source that stated
  it, and the rest is proposed with its source named. The payload is delivered
  by `qare-action ingest-deliver`, which opens the pull request a human applies
  and posts each comment at most once. Proposals arrive as a pull request,
  never as a silent edit.
- **Verify.** Every run records its verdict against the criteria it covered, so
  the ledger always knows when each statement was last proven and by what.
- **Contradict.** A change can put a new criterion at odds with an old one, or
  make an old one fail on purpose. QARE separates the two: a criterion the diff
  intends to replace is proposed as `superseded` with the replacement linked; a
  criterion that fails without any intent to change it is a regression. The
  classification reads executed evidence first, so a rule the run failed and the
  replacement the run proved settle it without a word from the model, and the
  classifier comes second, proposing the pairing where the evidence cannot
  settle one. What the model proposes lands only as a proposal a review
  applies; nothing supersedes anything on its own.
- **Ask, rarely.** When evidence cannot settle whether a conflict is intended,
  QARE asks one question in one place, with its own recommendation attached.
  The resolution order is fixed: executed evidence settles first, the ledger's
  own recorded answers settle second, and a question is asked last. The
  question goes where the person who can answer it will see it: a conflict a
  pull request introduces is asked in that PR's evidence comment, which already
  notifies its author; a conflict in the criteria themselves is asked on the
  linked issue, mentioning its author, with the PR comment linking there; a
  conflict a sweep finds is asked on the finding's issue, mentioning the person
  the finding blames. Each question carries an id derived from the pair of
  criteria it is about, never from the run, and the id is written into the
  comment as a marker, so a question already asked is never asked again
  anywhere else. An answer is recorded in the ledger with who decided and why,
  and the next conflict over the same pair settles from that record without a
  word from the model. Only the affected criteria are held as `unverified`
  while a question is open; the rest of the run reports normally, and an
  unanswered question never blocks a whole pull request.
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

### A criterion in a sentence

The smallest request of all is "check that this works". `qare check` takes the
criterion as a sentence and does the rest: it plans it through nare, runs it,
and judges it, with no issue, diff, job file or ledger.

```
qare check "searching Wikipedia for Ada Lovelace shows her article" --profile .qa
qare check "the home page loads" "the sign-in form rejects an empty password"
qare check --file criteria.txt          # one criterion per line; # comments
```

Each sentence becomes a criterion `check-<n>`, and each is reported on its own
line with its outcome, then `verdict <verdict>; evidence <dir>`. The planner is
told there is no diff and, for a target profile, where the app runs; the
verifier is told there is no diff too. A criterion the planner cannot plan is
`unverified` with the planner's reason, and a planner that cannot run at all
leaves every criterion `unverified`, naming why; nothing is dropped. A
criterion one of whose checks could not run is `unverified` saying so, even
when its other checks pass: half a proof is not a proof. A `visual` check here
captures the head only, because a sentence checked against the app as it runs
has no second side; the criterion is proven by the captures, and qare says on
stderr that nothing was compared (#143). What the verifier overturned is reported on stderr, as `qare judge`
reports it. Evidence goes to `--evidence`, or by default to a directory of its
own under `qare-evidence/` where qare runs, never into the repository
checked. The
evidence directory holds `plan.json`, the executed `result.json` and the
`judged-result.json`, and the exit code is `qare run`'s for the judged
verdict. `--runner none` judges from the evidence alone. `qare replay` re-runs
that judgment later from the same artifacts, with no model and nothing to
reach: the verdict is either byte-identical with the one the run judged, or
the difference is printed criterion by criterion. Nothing is written
to the ledger. The MCP server offers the same entry as its `check` tool, which
returns the judged result and the evidence directory.

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
  `qare run --criteria BIL-014,BIL-021` (and the MCP `run_criteria` tool the
  same way) resolves each id against the ledger, all-or-nothing: an id the
  ledger does not carry, and one that is retired or superseded, are refused in
  one message naming every offender and its state, never skipped. What runs is
  what the ledger says verifies each criterion — the suites its checks name —
  and the result records exactly the named subset, never implying more.
- **The whole ledger.** For a diff, QARE selects the criteria the change could
  affect, plus a standing smoke set, within a time budget. What it did not run
  is reported as not selected, never as passed.
- **A sweep.** On a schedule, QARE works through the ledger to refresh staleness
  and catch drift that no pull request would have touched.
- **Any of the above, twice.** A run that names a cache directory
  (`qare run --cache <dir>`) skips unchanged work. A criterion whose checks as
  authored, plan, profile, and base and head revisions are all unchanged
  replays the result the earlier run published, evidence files included,
  instead of re-running the checks; its result row carries a cached marker,
  and the evidence directory carries a cache summary naming every criterion
  the cache served. Any input that moves (a changed check, a changed profile,
  a different revision) changes the key, so that criterion runs for real. A
  cache entry that cannot be read back is a miss, never a claim: the cache can
  cost a re-run, but it cannot invent a result. The boot is not cached, only
  the criteria are, so a cached run still pays for the app it brings up.
- **Any of the above, against a flake.** A run that says how many times a
  failing check repeats (`qare run --flake-attempts <n>`) judges the check
  from its attempts together: a check that fails every attempt is a failure,
  and a check that passes its first attempt is proven and never repeated. A
  check that fails and then passes is unstable, so it did not decide, and
  the run quarantines it, into the store the caller names
  (`qare run --quarantine <dir>`), with the reason and the date: the
  criterion it belongs to reports unverified, never proven, because
  quarantining can never turn a criterion green. The next run reads the
  same store, so a quarantined check is skipped entirely, its criterion
  still reports unverified naming the record, and `qare ledger status`
  prints the quarantine: which checks are held, why, and since when. A
  store that cannot be read is a miss, never a claim: the checks run for
  real, and nothing is quarantined or written over it.

Selection, caching, sharding and budgets are what make the large case possible;
they never change what a verdict means.

### Selection

Selection reads the ledger's own mapping: an entry names the checks it is
verified by, and each check reference names what the check touches. A reference
is either `suite:<name>`, the screens a suite's checks drive, or a
repository-relative path with an optional `:fragment` after it, the code the
check exercises; the fragment, a line or a test name, is stripped for
matching.

`qare select [--ledger <dir>] (--diff <path> | --paths a,b) [--budget <ms>] [--smoke <suite>] [--out <file>]`
turns a diff into a selection, runs no check and no model, and writes the same
report as JSON to `--out`:

- Criteria whose checks cover a touched path are selected, matched at a path
  segment boundary in either direction, so a change to a directory selects a
  check named under it, and a change to a file selects a check named for the
  directory around it.
- A criterion whose checks name the standing smoke suite (`suite:smoke` by
  default, `--smoke` to rename it) runs on every selection, whatever the diff
  touches.
- A criterion the ledger maps to nothing a diff can be matched against runs
  too: a check that names only suites, or an entry with no checks at all, is
  one nobody can prove unaffected. When the mapping is unavailable, the
  selection falls back to the smoke set plus everything unmapped, so it errs
  toward checking more, never less.
- Selection respects a time budget (`--budget`, a whole number of
  milliseconds): the smoke set stands first and is never cut by it, the
  criteria the diff points at fill what remains, and whatever does not fit is
  reported as not selected because of the budget.

What was not selected is reported with the reason, and only that: a criterion
that was not selected appears as not run, never as passed, and one that is
superseded or retired is reported as such rather than run.

### Sharding

A run shards its criteria across workers (`qare run --workers <n>`, a whole
number of criteria at least one, one by default), and sharding changes only
how long the run takes, never what a verdict means (#48). The criteria that
share no state with their neighbours are dealt round-robin over the workers
in plan order and run side by side against the one booted app, which boots
once for the whole run and is reused by every criterion that can reuse it.
The rest stay sequential, in the plan order the job gave them, one after
another.

Two criteria are sequential whether or not the author says anything. A
criterion that publishes, consumes or reads mail — one that carries a mail
check, or references an artefact a mail check published as
`{{mail.<name>.link}}` or `{{mail.<name>.code}}` — keeps plan order, because
a run that reordered those hand-offs could return different verdicts than a
serial run does. And a criterion that mutates shared state of the app runs
against an app instance of its own instead of the shared one: its own compose
project, its own host port, its own volumes, torn down with the criterion,
recorded in evidence as `isolation-<criterion id>.json` beside the run's own
isolation record.

Mutating shared state is declared, in one of two ways: a criterion carries
`isolated: true`, or a profile suite does, and every criterion the ledger
verifies by that suite runs on its own app. A run against a target has no
app to boot, so there an isolated declaration cannot conjure one: the
criterion is checked against the declared target like its neighbours are.
Whatever a criterion leaves behind stays invisible to the criteria that run
beside it; anything else a check depends on must be declared one of those
two ways, or the author is depending on serial order the sharding does not
promise.

Results come back in plan order whatever the workers did, so a sharded run's
result reads exactly as a serial run's does, and a one-worker run is the
serial run.

### Sweeps

A sweep is a scheduled run over the whole ledger (`qare sweep --ledger
<dir>`, on a schedule with no pull request anywhere in the picture, #49). It
classifies every active or proposed criterion into one of five buckets and
keeps the standing status report — one GitHub issue, found by its hidden
marker and updated in place, never opened twice — current with that
picture: proven (verified within its area's staleness threshold), stale
(nothing has verified it within the threshold, or it changed after its last
verification), unverified (admitted but never proven), quarantined (held for
an open conflict question) and refused (the last run refused it).

Staleness thresholds are per area, in a strict `sweep.json` beside the
ledger: an area names its `staleAfter` as a duration (`30d`, `2w`, `1y`), a
criterion's area comes from the suite or repository-relative path its
verification names, and the strictest threshold among the areas a criterion
touches wins. A criterion with no configured area uses the default
threshold; a repository with no `sweep.json` at all uses the built-in
default, so a sweep works before anyone writes configuration.

A sweep failure is reported as a finding, not as a broken build: a scheduled
sweep has no pull request to turn red, so a ledger or configuration it
cannot read is filed as a sweep finding, one issue per
problem, fingerprinted so the next sweep updates it in place instead of
duplicating it, mentioning the person whose change last touched the ledger.
The ledger, not the report, is the store: the standing report is written for
someone with no QARE installed, exactly as the published view is.

### Findings on main

A run against `main` (a sweep, or a check of a deployment) has no pull
request to comment on, so what it finds becomes GitHub issues (#154), the way
a missing stub does (#31): one issue per problem, found again by a hidden
marker, never a pile of duplicates. `qare-action main-findings` reads the
judged result of such a run, the ledger and the profile, and files.

What is a finding, of which kind, and who it names is decided in code from
the executed result and the ledger. No model has a say in any of it.

- **One issue per problem.** A failed criterion has a fingerprint: its id
  plus a failure signature, the checks that produced the evidence and how the
  criterion failed (its checks, or the verifier overturning them). An open
  issue with that fingerprint gets a comment carrying the new run and its
  evidence; a new issue is opened only for a new fingerprint. An issue is
  qare's own only when the identity qare posts as opened it: a marker anyone
  else wrote finds nothing.
- **What it says.** The criterion's text, the outcome, the verdict, the
  evidence and the run. Text from the run, the ledger and the repository sits
  in code spans, where nothing renders and nothing mentions, and is redacted
  (#52) before it is written. A screenshot is linked only when it was pushed
  to `qa-assets`; every other file is named.
- **Blame.** The ledger records when each criterion last passed, so the
  issue lists the commits on the checked revision since then and the pull
  requests that brought them, and mentions each one's author. When the range
  holds several, the issue says which one the evidence points at most: the
  one that changed the most files the criterion's checks cover. When the
  files cannot tell them apart, it says that instead. A pull request a bot
  opened names the person who merged it, else one who approved it, because a
  bot cannot act on a notification; the profile's `findings.bots` lists the
  logins GitHub does not itself mark as bots. At most ten people are
  mentioned on one issue, and one run opens at most ten new issues: the
  rest are left for the next run, and the step says which.
- **Nobody to blame.** When the ledger has no record of a pass, or nothing
  but direct pushes or bots is in the range, the issue mentions the profile's
  `findings.fallback`, a person or a team, and says why no author is named.
  With no fallback it mentions nobody and says how to name one.
- **Notified once.** Mentions are written on the new issue and nowhere else.
  The comment a later run leaves mentions nobody, so a failure that recurs
  does not notify again. Notification is GitHub's own, web and email.
- **Closing the loop.** When a later run proves the criterion, qare comments
  with that run and closes the issue, and retires its marker: the same
  problem coming back later opens a new issue with a new range. An issue
  that is closed and still carries its marker was closed by a person; while
  the criterion still fails it is reopened, with the evidence.
- **Kinds are kept apart.** A failure of a criterion that passed before is a
  `qa-regression` issue. A run in which no check executed because nothing
  could boot or be reached is one `qa-environment` issue for the whole run,
  for the fallback, closed when a run executes a check again; while it is
  down, nothing is reported as failing or recovered. A criterion held by a
  quarantined check files nothing: a flake goes to quarantine and the
  standing report. A failure nothing shows ever passed is a `qa-failure`
  issue, never called a regression.
- **Hand-off.** The `qa-regression` label is the signal an orchestrator
  picks an issue up by. qare itself never fixes and never merges.

Only the judge side files: the step holds the GitHub identity and runs
nothing from the repository (rule 7). The step that runs code holds no
token, so it cannot.

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
identity only ever exists in the steps that write to GitHub, in the judge,
report and requeue jobs: never in the step that executes pull request code,
and never beside the planner.

The choice is made by the credentials an install configures, never by code.
The posting code is written against one interface with an implementation for
each: an App's id and private key make qare post as the App, a personal access
token makes it post as that user, and with neither it posts as the workflow
run, which serves for verdicts and comments and is refused for a proposal. The
App wins when both are configured, and half an App stops the step by name. The
reusable pipeline takes all of it as secrets passed by name and hands it to
the steps that write to GitHub and to no other. GitHub lets only an App write
a check run, so under a personal access token that one write stays with the
workflow run's own token and does not carry the user's name. Whether an
identity may open a proposal is decided by what the credential is, not by the
name it was handed over under: the workflow run's token is refused under any
name. The permissions each option needs are listed in
[the pipeline guide](./pipeline.md#github-identity).

## Clients

A flow says what a person does: open this, type that, expect to see the other.
Which software performs those actions is a driver's business. Actions are named
for intent rather than for a library, a driver declares which actions and which
evidence kinds it supports, and a plan asking for something its target cannot do
is rejected before anything boots rather than failing halfway through.

The vocabulary is fixed and small: `open` a URL, `type` a value, `click` an
element, `choose` an option by its accessible name, `waitFor` an element to
become visible, `assertText` that a text is visible, `assertElement` that an
element is visible, and `capture` a screenshot as evidence; the two second
factor actions (`totp`, `backupCode`) complete it. A driver declares the actions
and the evidence kinds it supports, the planner is only offered what the driver
declares, and a plan naming anything else is refused naming the action and the
driver, at load time and again before a run boots. The judge reads the same
driver-independent results either way, so swapping the browser for another
driver that declares the same actions changes nothing in a plan.

The browser is the first driver. A desktop shell, a phone and a native
application are the same vocabulary against a different tree, and every one of
those platforms exposes an accessibility tree, so element references stay
semantic on all of them: a role and an accessible name, never a coordinate and
never a label a model invented.

Every driver turns its client's accessibility tree into one normalised snapshot
(#82). A node carries its role from the W3C Core Accessibility API Mappings, its
accessible name, its value, its states and its children, plus a stable path
built from roles, names and landmark ancestry, never from a coordinate or a
generated id. The browser driver maps Playwright's ARIA snapshot onto this
schema. A flow check writes a snapshot to the evidence at every assertion,
trimmed to the subtree the assertion touched, and a control in that subtree
with no accessible name is recorded as a named accessibility finding rather
than a silent pass.

An element reference in a flow action may pin the snapshot path it was authored
against. When the action then misses, the check looks for one element with the
same role, the same accessible name and the same landmark ancestry, and
re-points the reference only when exactly that element is found; anything else
goes to review, named in the reason the check carries. An assertion is never
repaired: if the element an assertion names has moved, the check fails as
itself, because a repair that reached for a different element could otherwise
turn a regression into a pass. Every repair, applied or refused, is recorded
with the reference it came from, the reference it became and the identity
comparison that decided it, written to the run's evidence and named in the
comment the run leaves behind.

Two things do differ by client and belong in the profile rather than in a check.
Getting the application in front of the driver means starting a server for one
client, installing an artefact for another, and launching a binary for a third.
And some clients can only run in certain places, so a target declares what it
requires and a run refuses to start where that is unmet, naming what is missing.

### Provisioning

Getting the application in front of its driver is one lifecycle whatever the
client is (#75), and each side of a comparison goes through it:

| Step | A server (`app`) | A build the run installs (`client.artefact`) |
| --- | --- | --- |
| Obtain | The compose recipe in the side's tree | The artefact the profile names for the side: the file the pipeline already put in the workspace, or, when it is not there, the output of the build command the profile declares |
| Install | `docker compose up`, under the run's own project | Unpacked into a directory of the run's own, outside the checkout and the evidence |
| Health | An HTTP probe of `app.health.http` | The driver launches the build once and waits for its first window, within `client.health.timeout` |
| Teardown | `docker compose down`, by the pipeline when the run ends, so the stack's logs can still be read | Removed by the run when the side's checks are done, on a blocked provisioning, and on a cancelled run |
| When a step fails | `blocked`, with what compose said attached | `blocked`, naming the artefact, with the provisioning log attached |

A provisioning failure is never a failed criterion: nothing was checked, so
every criterion is `unverified` with the reason, and carries `provision.log`
as its evidence. The log is written into the side's evidence directory, swept
by the same redaction as every other file there, and for a build the run
installed it records each step: the artefact's size and SHA-256, the
installer's own output, what the build wrote while the health check launched
it, and the teardown.

A profile names an artefact in its `client` section:

```yaml
client:
  driver: electron
  args: [--no-sandbox]
  artefact:
    kind: archive                          # what the driver's installer takes: archive (a tar) or directory
    executable: my-app/my-app              # inside the installed artefact
    head: { path: qare-artefacts/head.tar }
    base: { path: qare-artefacts/base.tar }   # optional: gives the run its base side
    timeout: 10m                           # optional: the bound on a build or an install; 10m by default
  health: { timeout: 30s }                 # optional; 30s by default
flavour: web
```

Both paths are inside the repository the run checks, held to the rule
`client.executable` has: relative, never climbing out, and what they resolve
to must be inside the checkout, so a profile, which a pull request can edit,
never points the run at another file on the host. The execute step reaches
nothing outside the run and holds no token, so qare downloads nothing: a
prebuilt artefact is a file the project's own pipeline put in the workspace
(the reusable pipeline's `artefacts` input fetches one workflow artifact for
that, see docs/pipeline.md).

`base` is what gives a client a second side. With it the run installs the
base build and runs the plan against it, removes it, then does the same with
the head build, and the comparison is the one a booted profile gets (#147):
`base/` and `head/` evidence, what the base showed for each criterion, and
`regression` on a criterion the base build proved and the head build fails.
A base artefact that is already there is installed as it is: no checkout of
the base is made and nothing is rebuilt. Both paths are read from the head
profile, the one the run was configured with, as the base side's cost limits
are. qare records the hash of each file it installed and cannot tell which
revision a prebuilt file was built from: the pipeline that produced it
vouches for that. A profile's `base` section bounds a client's base side
with `criteria: all | none` and `budget`; `criteria: ledger` reads the ledger
of a base checkout, which a prebuilt base does not have, and is refused.

A base that cannot be provisioned never blocks the head. The base is reported
as not executed, naming the artefact, `base/provision.log` is kept and listed
as each criterion's base evidence, and every criterion is `not-compared`.
Only the head's provisioning can block the run.

`<side>.build` is a command that produces the side's artefact when it is not
there: `head: { path: dist/app.tar, build: node scripts/package.mjs }`. It is
spawned with no shell, split on whitespace like a declared command, in the
tree of its side (the head checkout, or a checkout of the base revision made
as for a booted profile), and it is told where to write in `QARE_ARTEFACT`.
It is pull request code: on a host it gets the minimal environment (#91). An
artefact that already exists is never rebuilt. qare knows nothing about how
to build anything; building in the pipeline is the project's own job.

The installer is the seam a platform plugs into: it is keyed by artefact
kind, puts the artefact where the driver can launch it, says what the driver
launches (a path for a desktop build, an application id on a device), and
says how to remove it. The Electron driver ships `archive` and `directory`.
The Android and iOS drivers (#73, #74) add their package kinds behind the
same seam; that path is exercised by a fake installer in the test suite and
by nothing real, so installing on a device or an emulator, and a health
check there, are not proven. A profile cannot name a kind no shipped driver
installs.

What provisioning does not do: it does not combine a booted stack with a
client build (`app` and `client` stay exclusive, so a desktop application
that needs its own backend booted is not covered), it does not run a client
profile inside a several-app run, and its cache key does not carry the
artefact's hash, so a pipeline that produces two different builds from one
revision should not cache.

### The Electron driver

The second driver, shipped (#72). A desktop shell is a browser in a window, so
the driver declares the browser's whole vocabulary, and a flow written for the
browser runs against a desktop build with nothing edited but the profile it
runs under. `examples/electron-app` holds that proof: one `plan.json`, a
profile that names a URL and a profile that names a build, and a CI job that
runs the plan against both.

A profile names the build in a `client` section, the third shape beside `app`
and `target`, and like a target profile it needs nothing else but `QA.md`:

```yaml
client:
  driver: electron
  executable: dist/linux-unpacked/my-app    # from the repository the run checks
  args: [--no-sandbox]                      # optional; passed to the build as written
  hosts: [api.example.com]                  # optional; the hosts the build may reach
flavour: web
```

The run boots nothing. Before any check runs it holds the build to being
there and the host to being able to show a window, and a run that fails either
is `blocked`, naming the path or the display, with no criterion marked
`failed`. This shape launches a build that is already unpacked in the
checkout, in place, for one side; a profile that declares `client.health`
has it launched once first and held to opening its first window. A build the
run installs, for one side or for both, is named with `client.artefact`
instead (see [Provisioning](#provisioning)); a profile names one or the
other. The build is the repository's own: `executable` is a path inside the repository the run
checks, an absolute path or one that climbs out is refused when the profile
loads, and a path that resolves through a link to somewhere outside the
checkout blocks the run, so a profile can never point the run at another
binary on the host.

Each flow check launches the build fresh, with a user data directory of its
own that is removed afterwards, so one check's state never explains
another's. The driver starts the executable itself and attaches to it over
the DevTools endpoint the build opens, through Playwright, so the locators,
the snapshot, the masked screenshots and the trace are the browser driver's
own. It owns `--remote-debugging-port` and `--user-data-dir`, and a profile
that passes either is refused. On a Linux host with no display the driver
starts a virtual one (Xvfb, which the `web` image ships) for the launch and
stops it afterwards, so a pipeline's execute step needs nothing added. The
build is pull request code, so it is launched inside a cell with no network of
its own ([Containing the build](#containing-the-build)), where the display and
the environment are the cell's. A profile that opts out of the cell launches
the build beside the run: on a host with the minimal environment a command
step gets there (PATH, HOME, and the display), never the host's own; inside
an image with the image's.

An application has windows where a browser flow has one page, and the
vocabulary names no window. An element reference is looked for in every open
window, newest first, and the window that shows it is the one the next
screenshot and snapshot are taken of. A flow written for one page runs
unchanged; one that opens a second window follows the application into it and
comes back when it closes. An action waits for its element as long as an
action is given, so a window that is still opening is waited for like an
element that is still rendering; an assertion asks every open window once,
and waits for nothing.

`open` takes a path inside the application. `/` is the page the application's
first window loaded, and any other path resolves beside it, the way a path on
a target resolves below its URL. A full URL is refused before the run boots:
a desktop shell has no address bar, and a window of the application is not
pointed at a page it never shipped.

Its evidence is the browser's (the action log, screenshots, the snapshot at
each assertion, the trace kept outside the published evidence) plus the
application's own console output, as `console.log` in each flow check's
directory: both streams of the main process by line from its first byte,
every window's console messages and page errors, and each window opening and
closing, in the order they happened. It is read once the application has
exited, so what it wrote on the way out is in it, and it is swept by the same
redaction as the action log. The build is pull request code, so its output is
bounded: the log keeps the last 5,000 lines and says how many it dropped, and
a line is cut at 8,192 characters and says so, whether or not it ever ends.

What the driver cannot do it declares, and a plan that asks for it is refused
when it loads and again before a run boots, naming the check and the driver:

| It cannot | Because | So |
| --- | --- | --- |
| Run a `visual` check | A capture is taken at named widths and themes, and a desktop window is sized by its window manager, not a viewport | The plan is refused; a client profile that names widths or themes is refused when it loads; the planner is not offered the kind |
| Run an `a11y` check | The audit resizes and re-themes the page the same way | The plan is refused; a client profile with an `a11y` section is refused when it loads |
| Open a full URL | A desktop shell has no address bar | The plan is refused naming the action |
| Compare with a base revision without a build of it | A build launched in place (`client.executable`), or a `client.artefact` with no `base`, is one build | The run has one side: the result carries `client: { driver, executable, comparison: "none" }` and the comment says so. A profile that names `client.artefact.base` has two (#75): `comparison: "base"`, with the artefact each side was installed from. A run over several apps refuses a client profile, which runs on its own |
| See what the build reaches from its windows | The main process reaches the network without a page seeing it | The whole process is contained instead, and its gate keeps the record ([Containing the build](#containing-the-build)) |
| Seed a second factor | A client profile has no `app.login` | A flow that types a `totp` or `backupCode` is `unverified` before it runs, naming the gap |
| Drive a build that turns remote debugging off | The driver attaches over the endpoint `--remote-debugging-port` opens | The flow is `unverified`, naming it, with the application's output |
| Run where no window can be shown | It opens real windows | The run is `blocked`, naming the display |

It is proven on Linux. Nothing in the driver is Linux's alone, but macOS and
Windows hosts are their own issue (#90), and the cell a build is contained in
is a Linux container.

### Containing the build

The build a client profile launches is pull request code that qare starts and
cannot see into: its main process opens sockets no window ever shows. So the
run does not watch it, it contains it (#223,
[ADR-0006](./decisions/adr-0006-client-egress-cell.md)). Each launch gets a
**cell**: a container the runner's docker daemon starts from the image the
run is in, with no network but loopback (`--network none`), no capability,
no docker socket, and the repository mounted read-only at its own path.

The cell's one way out is a socket to a **gate**, a second container holding
`client.hosts`. Inside the cell a launcher answers DNS on loopback: it asks
the gate about each name, answers a declared one with loopback, and answers
any other with no such name, so no query leaves the cell. It listens there on
ports 80 and 443, reads the host each connection is for (the `Host` header,
or the server name in the TLS client hello) and has the gate connect it. TLS
is carried, never opened. A build needs no proxy setting and honours none:
there is no other route to take.

`client.hosts` reads the way `target.hosts` does: a name, or `*.` before a
name for one label below it. Nothing declared is nothing reachable.

Every launch of the build is contained: each flow check's, and the one the
health check makes before any check runs (#75). A build launched in place is
read from the repository, mounted into the cell. A build the run installed
from an artefact is not in the repository, and its install directory is the
run's own, which the docker daemon cannot see when the run is itself in a
container: the install is copied into the cell over the daemon's API, at the
path it was installed to, and the repository is not in the cell at all. Both
sides of a comparison are contained alike, and each side's flow checks carry
their own `outbound.json`. A build command (`client.artefact.*.build`) is a
command, not the build: it runs with the step's network, as a command check
does.

| The build reaches for | Inside the cell | In the evidence |
| --- | --- | --- |
| A declared host, on port 80 or 443 | It answers | `outbound.json` lists the host, port, protocol and count, `declared: true` |
| A name the profile does not declare | It does not resolve | Listed with `declared: false`; the flow is `unverified` with `refused: undeclared host: <host>:<port> (<protocol>)` and the run is `refused`, as an undeclared host refuses a target run |
| A declared host on another port | The connection is refused | Not listed: nothing left the cell to be named |
| A bare address | No route | Not listed, for the same reason |

`outbound.json` is written into every flow check of a client run, after the
build has exited and whatever the flow's outcome, a timeout included:

```json
{
  "client": "dist/linux-unpacked/my-app",
  "containment": "cell",
  "declared": ["api.example.com"],
  "reached": [{ "host": "api.example.com", "port": 443, "protocol": "https", "declared": true, "count": 3 }]
}
```

It fails closed. Before any check runs, the run is held to being able to make
a cell: a docker daemon it can reach, and the image it runs in
(`QARE_IMAGE_REF`, which the pipeline's execute step sets). Without either
the run is `blocked`, naming what is missing, and the build is never launched
with the step's network instead. A gate whose record does not come back
leaves the flow `unverified`, never passed on an empty list.

A profile opts out in as many words:

```yaml
client:
  driver: electron
  executable: dist/linux-unpacked/my-app
  egress: uncontained
```

The build is then launched beside the run, with the network its step has.
The result carries `client.egress: "uncontained"`, the comment says the build
was not contained, and each flow check's `outbound.json` carries
`"containment": "none"` and the reason nothing is listed. A profile cannot
both opt out and declare hosts.

What the cell does not do:

- It contains the build, not the step. A command check, a suite and a
  compose service still run with the network the step has
  ([ADR-0005](./decisions/adr-0005-execute-docker-access.md)). Containing
  them is the same decision applied to a process that needs the repository's
  toolchain and the booted stack, and is not done yet (#224).
- The profile is a file in the repository, so a pull request can add a host
  to it. The addition is in the diff and in `outbound.json`.
- A runtime's own background traffic becomes a host nobody declared.
  Electron's spellchecker downloads its dictionary from
  `redirector.gvt1.com` as soon as the application starts: an application
  gives the spellchecker no language, as the example does, or its profile
  declares the host.
- The build runs in the image rather than beside the run, with the checkout
  read-only. The docker daemon has to be on the machine the run is on.

`examples/electron-app` proves it in CI on a hosted runner, from the build's
main process, through Node and through Chromium's own network stack: a
declared host answers and is recorded, an undeclared name is refused by name,
a bare address has no route, and the opted-out profile says it was not
contained. The provisioned profile's two installed builds run contained
too, their health checks included.

## Installing and running QARE

QARE runs the same way installed on a host or inside a container. Neither is
the real one and the other a convenience: the same command, the same profile
and the same evidence come out of both, and the evidence records which it was.

### Images

The image family is layered. The base image is the smallest thing that runs
QARE at all: the CLI, the ledger, the judge, command and mail checks, and a
pinned nare, with no client driver. Every other image is built from it and adds
one driver family, so nothing is installed twice and a project that needs
something unusual starts from the base and adds only that. Paths, the entry
point and the user are a stable contract, so a derived image keeps working
across QARE releases.

The shipped flavours are `core` (the base) and `web` (built from the core,
adding the browser engine, its browsers, a virtual display, and the one
library a desktop shell needs beside the browser's, so the Electron driver
runs in it too). A profile
names the flavour its checks need, and the run refuses a name the family does
not ship before anything boots: the family is the pipeline's, and a name
outside it can only be a misspelling or a wish the family has not grown yet.
Absent means the base is enough, which a profile of command and mail checks
is.

Every image pins the versions it ships and stamps them where a run reads them
into its evidence, so a containerised run names the image ref and digest that
produced it, the flavour it ran as, and the qare, nare and driver versions
inside, rather than asking the registry. The base image holds a size budget
the pipeline enforces, because the budget is what keeps the base the smallest
thing that runs QARE; and no derived image reinstalls anything the base
already ships, which CI checks by comparing the bytes of the base's files
between a base image and a derived one.

The pipeline runs on the family: plan and judge run qare in the core image,
execute runs the flavour the profile targets, and a release publishes the
images for amd64 and arm64 to the registry. A pull of the image is what a run
of the pipeline is, so no job builds qare from source to plan, execute or
judge; and until a release publishes the images, those pulls fail naming
exactly that, because a quiet fallback to a source build is the failure mode
the family exists to remove.

### In a repository's pipeline

The pipeline is a reusable workflow, shipped (#145). A repository does not
copy it: it calls `ViviDynamics/qare/.github/workflows/pipeline.yml` at a
release tag from a workflow of about ten lines, and passes what is its own to
choose: the profile path, the model and its endpoint, the runners, and the
model key and the identity qare posts as, each by the name of the secret that
holds it. The triggers, the
concurrency group and the permission ceiling stay with the caller, because a
called workflow can hold no permission its calling job does not grant.
[docs/pipeline.md](pipeline.md) is the caller's guide.

A release tag is the pin. Each release's pipeline names that release as the
qare it runs (a called workflow cannot learn its own ref, so the release is
written into the file and stamped with the version), so the tag in `uses:`
moves the pipeline, the qare its token-only jobs build and the images its
other jobs pull together, and upgrading is that one line.

The secret boundaries are the ones the jobs have always had: the caller
passes its secrets by name and never inherits them into the pipeline, the
planner and the verifier steps are the only ones that see the model key, the
steps that write to GitHub are the only ones that see the identity, and the
job that runs pull request code holds nothing. No step or job is allowed to
fail without failing the run, and a missing model key stops the plan by name
rather than reading as a pass.

qare's own pull requests run through the same file: its QARE workflow is a
caller that names the file in its own tree, so a change to the pipeline is
checked by its own pull request, and pins the base commit where another
repository pins a release, so the qare a token-holding job runs is still a
revision the pull request cannot change.

### On a host

The host install is the same package the image ships: `@qare/cli` at a pinned
version, with the pinned nare installed beside it (the wheel from nare's
release, `python3 -m pip install --user`), and nothing else added by hand.
The pinned nare needs Python 3.12 or newer, the python the core image is built
on, so a host whose `python3` is older (a self-hosted CI runner, say) installs
a newer one first: on GitHub Actions, `actions/setup-python` with
`python-version: '3.12'` before the step that installs nare. Otherwise pip
refuses the wheel with "requires a different Python".
Drivers are added on demand, one per client family the profile's suites
actually target: `playwright-core` and `npx playwright install chromium` for a
suite that drives a browser, a container runtime only for a profile that boots
an app.

`qare doctor` names what the host has, what the profile needs, and how to
install what is missing. It checks node, the pinned nare, the docker daemon
for a profile that boots an app, and the chromium driver for a profile whose
suites drive a browser. While nare is missing it also checks that `python3` is
new enough to install it, so a too-old interpreter is named before pip refuses
the wheel; once nare is installed the interpreter is only reported, because
nare may run under its own. A display is required only by a profile that names
a desktop client (#72), which opens real windows: a running one, or an Xvfb
the driver can start. A profile that installs an archive (`client.artefact`,
#75) requires `tar`, which unpacks it. The browser driver runs headless. Devices are reported
but never required: they arrive through the profile's registered MCP servers. A profile that is there but broken is a caller
mistake, named on the error stream.

A run on a host obeys the same rules a container run does, and the one rule
the image cannot enforce for itself the harness imposes: a command step (the
step that runs pull request code) runs with the minimal deterministic
environment (PATH, HOME and the entries the profile gives it), so a host's
tokens and other secrets never reach pull request code. Inside a container the
step keeps the inherit contract, because the image controls that environment.
Either way the result and its evidence are the same shape, and the result
records where the run executed: `environment.execution` is `native` or
`containerised`, with the qare version, the node version and the nare contract
it ran with. A containerised run adds the image that produced it: the ref and
digest the runner that pulled the image passed, the flavour the image sets,
the driver versions it ships, and the pinned versions the image stamps (#88).

### Tools QARE did not ship

A host that installs QARE will have tools QARE has never heard of: an in-house
device rig, a proprietary simulator, a test data service. Rather than a plug-in
system per tool, QARE speaks one generic protocol to them: MCP. A profile
registers a host's MCP servers by saying how to start or reach each one
(`command` or `url` — start splits on whitespace and spawns with no shell, reach
speaks JSON-RPC over HTTP), which of each server's tools are allowed, and which
steps the server may run in:

- **For the planner to look through (`steps: [plan]`), shipped (#93).** The plan
  step starts the servers its profile registers, speaks the MCP handshake, and
  serves the allowed tools to the model session over one channel, the way the
  exploration channel (#87) serves its four: only tool calls and their results
  cross, each tool addressed as `server.tool` so two servers' tools cannot
  collide, and every result treated as untrusted data. A server that cannot be
  started or reached is reported, never silently skipped; the calls the planner
  made, their arguments and their results are recorded with the run's evidence
  as `mcp-calls.jsonl`.
- **As a driver or a check, shipped (#94).** QARE's code calls the tools
  directly, with no model in between, by mapping its action vocabulary onto
  them. The rules do not change: references stay semantic, the harness records
  what the tool returned, and code decides the verdict. A tool that can only
  act on coordinates is not a driver.

A registered server declares which steps it may run in. A server that needs a
credential says so by name, and the profile refuses to place it in the execute
step — the step that runs pull request code — so the refusal is a profile
mistake named when the profile loads, not a leak found later.

### The MCP adapter

The generic protocol is Model Context Protocol (JSON-RPC 2.0, no model in the
loop). A profile registers host servers in an `mcp` list, one entry per server,
each saying how to reach it (`command` or `url`), which of its tools are
allowed, and which steps it may run in (#93). One entry at most may also carry
a `driver` mapping — the mapping is what makes that server a driver.

The `driver` mapping is the driver-capability declaration: it maps each flow
intent (`open`, `click`, `type`, `choose`, `waitFor`, `assertText`,
`assertElement`, `capture`, `snapshot`) onto a tool on that entry's allowlist
and binds every argument the intent carries. A plan that names an intent the
mapping does not bind is refused at plan time, before a job runs — the mapping,
not a string in the check, is what makes the server a driver, so a plan cannot
ask a driver for a step the host never mapped. The mapping is also checked
against the server's own tool schemas at connect time: a tool whose bound
argument is a number takes coordinates, not element references, and the
connect refuses it with that named ("only acts on coordinates"), so a
coordinate-only tool can never be a driver.

```yaml
mcp:
  - name: device rig
    url: http://127.0.0.1:9/mcp
    tools: [navigate, click_ref, page_text]
    steps: [execute]
    driver:
      open: { tool: navigate, args: { url: url } }
      click: { tool: click_ref, args: { ref: element } }
```

A plan can also name a `tool` check: one call to a tool on a registered
entry's allowlist, with arguments the plan substitutes, and an `assert` list
naming explicit matchers (`equals`, `contains`, `matches`, or a path into the
tool's structured result). A tool check with no assertions does not parse — a
free-text result is never judged by a model; code decides from the matchers the
plan names. Every call is evidence: the runner writes the tool name, the
substituted arguments, the redacted result and the assertion outcomes to the
check's `tool.json`, and a driven flow records each mapped call in the flow
directory's `tool-calls.json`, swept with the profile's redaction rules.

A run can prove a criterion through a sample MCP server this repository
ships for tests: a plain loopback server with element-reference tools,
proving the done-when with no model call and no outside network.

## Running against a deployed environment

Most runs use a stack QARE boots itself, where every dependency is a stub. A run
can instead point at a deployed environment such as staging, where the
dependencies are real. The checks are the same checks; only the profile's target
and its sources change.

Such a profile names a `target` in place of `app`, and it needs nothing else
but `QA.md`: no compose file, seed, login fixture, stubs, or `fixtures/` and
`stubs/` directories. `visual` and `suites` stay optional.

```yaml
target:
  url: https://staging.example.com
  health: { http: /up, timeout: 30s }       # a path on the target, or a full URL
  hosts: ["*.cdn.example.com"]              # other hosts its checks may reach
```

The run boots nothing. It proves the target is up with the health check, which
must answer 200 (redirects are not followed, so name the page that answers),
and a target that never answers is `blocked`, naming the URL, with no criterion
marked `failed`. Command checks, the command of a suite a flow names, and a
flow's strings (a URL to open, a value to type, a text to assert) reach the
target through `{{run.target_url}}`. A flow's `open` action also takes a path
on the target (`/wiki/Ada_Lovelace`), which resolves below its URL, so a target
served under a sub-path keeps it; a health path resolves the same way, and a
path that climbs out of the target (`/../admin`) is refused. In a flow's
strings and a suite's command only `{{run.<name>}}` is a reference: other
braces are the page's or the command's own and pass through untouched. A
profile that boots its own stack does not mint `{{run.target_url}}`, so a
reference to it there fails closed at plan time.

Every host a flow's browser reaches, WebSockets included, is recorded in the
check's `outbound.json`, however the flow ended, a timeout included. A browser
backend that cannot report what it reached leaves the flow `unverified`. The target's own host is always allowed, and `target.hosts`
names the rest, with the same `*.` wildcards as a stub's hosts. A host that is
neither refuses the run, as a missing stub does in a booted run, except that no
stub issue is filed: a target has no stubs. Command checks and suites are not intercepted:
a suite drives its own browser, which QARE cannot see. Only the traffic of the
browser QARE drives is recorded. A process the run starts is contained rather
than watched; that is done for the build a client profile launches
([Containing the build](#containing-the-build)) and not yet for command
checks and suites (#224).

There is only one side, so nothing runs at a base revision and no regression is
looked for. The result carries `target: { url, comparison: "none" }` and the
PR comment says so, rather than implying a base comparison that never ran.
`qare readiness` reports a target profile as ready: without a boot, a compose
file and stub coverage are not gaps. A client profile (#72) is the same there:
it launches a build, so it boots and stubs nothing.

The one part that differs in kind is anything QARE has to observe from outside
the app. Mail is the usual case: locally a sink in the stack catches it, and on a
deployed environment QARE reads a real mailbox instead. Credentials for those
sources exist only in this mode, never in the sandboxed step that executes pull
request code, and anything that cannot be reached is reported as `unverified`
with the reason named, never as a failed criterion.

## Triggers

- CI completes green on a PR (`workflow_run`), once per head SHA.
- A `/qa` comment on the PR.
- A `/qa-dismiss <id>` or `/qa-promote <id>` comment on the PR, which runs no
  checks: it dismisses an advisory UX finding or files it as an issue (#150).
- A `qa` label.
- Locally: `qare run` from the CLI or the Claude Code skill.

Fork PRs are refused outright in the Action.

## Output

- One sticky PR comment, regenerated per push: criterion, check, result,
  before/after/diff images, trace link, preview URL if any, verifier notes.
- A `qare` check run with the state from the table above.
- Artifacts: screenshots, traces, logs, `plan.json`, `result.json`.
- Screenshots also land on the orphan `qa-assets` branch, under a path naming
  the run (date, head SHA and Actions run id), append-only, so the comment's
  screenshot links keep resolving after the artifacts expire. The posted
  comment links each screenshot to its branch path; everything else links to
  the artifact.
  ([ADR-0002](./decisions/adr-0002-screenshot-storage.md))
- Everything above is redacted before it is published: known token shapes
  (the same rules nare applies to its own events, plus a few more), key and
  password assignments, passwords in URLs, and the profile's `redact` values
  and patterns. A run redacts what it writes; the pipeline sweeps the evidence
  directory again before uploading it, and a file the sweep cannot vouch for (a
  binary that is not an image, a symlink) stops the upload.
- Screenshots are masked at capture (#119): the profile's `redact.masks`
  selectors name page regions the browser blacks out while it takes the
  screenshot, so fixture data never reaches the pixels text rules cannot read.
  The same masks apply to base and head screenshots alike, so masking never
  shows as a visual difference, and the evidence names the masks that applied
  to each screenshot: a flow's action log, and a visual check's `visual.json`. What a mask cannot cover, text redaction still covers.
- Advisory UX findings (#150), when the run was reviewed: a section of the
  comment marked advisory, and the `advisory` key of `judged-result.json`.
  They are never in the verdict or the check run.
- `result.json` is the machine contract other harnesses consume.
- Both artifact schemas are documented in [schemas.md](./schemas.md); the
  orchestrator contract (invocation, exit codes and reaction per verdict) in
  [orchestrator.md](./orchestrator.md).

## Readiness report

The first run on a repo with no `.qa/` does not QA anything. It inventories how
the app boots, which outbound services it reaches, which are stubbed, and which
are not, then posts a readiness report and files one issue per missing stub.

`qare init [path]` turns that inventory into a starting point (#146). It
writes `.qa/` and the workflow that calls the pipeline
([pipeline.md](./pipeline.md)), and never overwrites: an existing `.qa/` or
caller workflow is left alone, and init prints what it would have written.

- A repository with a compose file gets a profile that boots it: the compose
  file, the service that is the application (the one built from the
  repository, or `--service <name>`), the health URL its healthcheck and
  published port give, one stub per outbound origin the scan read, and the
  suites init recognises by their files (Cucumber, Playwright, RSpec system
  tests).
- A repository with no compose file gets a target profile for
  `--target <url>`. With neither, init writes nothing and names the flag.
  The health check passes on a 200 alone, so `--health <path>` names a page
  that answers one; without it the path is `/` and a placeholder asks for it
  to be confirmed.

What init cannot know it leaves as `TODO(qare init):` lines in `QA.md` and
`config.yml`. The profile loads with them in place, so readiness reports each
one as a gap until a person replaces it, along with a compose file or service
the profile names that is not there, and a stub whose compose service nothing
defines. init ends with that list as its next steps: it is the list
`qare readiness` prints, so the two cannot disagree. Loopback hosts and the
compose file's own service names are not outbound origins.

Each stub gap is named as the issue it becomes, under the key a refused run
files with (`qare-stub: <host>`), so the issue a run would file later is the
same one. `--file-issues <owner/name>` files them, with `GITHUB_TOKEN` or
`GH_TOKEN`; without it nothing is filed, because the scan reads every URL in
the tree and a person prunes the stub list first.

## Surfaces

One TypeScript codebase, one core, thin adapters:

| Package | Purpose |
| --- | --- |
| `@qare/core` | plan, execute, judge, report; provider interface; `result.json` schema |
| `@qare/cli` | `qare init`, `qare readiness`, `qare doctor`, `qare run`, `qare run --job`, `qare judge`, `qare replay`, `qare ledger`, `qare ingest`, `qare redact`, `qare reap`, `qare sweep` |
| `@qare/action` | GitHub Action wrapping the three jobs |
| `@qare/mcp` | MCP server so orchestrators, Codex, OpenCode and others can call it |
| `plugin/claude-code` | skill, verifier subagent, Stop hook for local runs |

Model access: qare shells out to `nare run` and consumes its typed JSONL
events and session files. Model, provider and sampling flags are nare's
concern. Claude only at first, because model variance is what makes verdicts
unstable.

Capabilities qare needs from nare, each an issue on nare when it is missing:
schema-constrained output for `plan.json`, a read-only tool set for the
verifier step and the advisory UX reviewer, a per-step token budget with a
retry on truncation, and a read-only way to look at an image file
(ViviDynamics/nare#48), without which the UX reviewer reads snapshots and
logs and no screenshot.

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
