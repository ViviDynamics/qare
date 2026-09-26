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

Four jobs, so the model and the GitHub token never share a machine with PR
code. Every secret-holding job builds and runs qare from the base commit, a
revision the pull request cannot change; the pull request contributes data
only: its body, the linked issues, the diff, its `.qa/` profile read as YAML,
and the artifacts execute uploaded.

| Job | Secrets | Network | Does |
| --- | --- | --- | --- |
| **collect** | GitHub token | yes | Reads the pull request body, linked issues and diff from the base commit's checkout; writes `criteria.json`. Never executes PR code. |
| **plan** | model key | yes | Reads the criteria, the diff and `.qa/`; writes `plan.json` mapping each criterion to checks tagged `command`, `flow` or `visual`. The planner is also told any flow action kinds the change itself introduces, read from the diff as data. Never executes PR code. |
| **execute** | none | stub containers only | Boots the app at the merge base and at the head with stubs, runs the plan, saves artifacts and raw results. |
| **judge** | model key, GitHub token | yes | Computes verdicts in code from raw results, runs the verifier model on the evidence, posts the comment and check. The plan is loaded with the same flow action kinds the plan step was given. |

Execute stages, per side (base, head):

1. Boot from the `.qa/` recipe (compose, command, or preview URL); prove the app is up with a health check the harness runs.
2. Seed fixtures, log in test accounts.
3. Run `command` checks (exit code and output), `flow` checks (a fixed action set driven by a client driver, or existing suites), `visual` checks (named screenshots at named widths and themes), and `mail` checks (a message waited for and read).
4. Record every outbound connection attempt. Anything outside the stub map is a `refused: missing stub` finding.

Judge:

- Criterion verdicts come from executed results only.
- Visual diffs are advisory evidence for the human, never the sole basis for a pass.
- The verifier model gets the criteria, diff and evidence in a fresh context and reports only criteria the evidence does not actually show. Its findings can downgrade a verdict, never upgrade one. A verifier that gives no readable answer leaves the criteria it was asked about unverified, so the run blocks rather than passing unchecked.
- A blocked run whose every unverified criterion is one the planner could not plan, or whose planned command cannot run without a shell, reports the criteria by name and the check run comes out neutral: the gap is in the planning vocabulary, and nothing was disproven. Any other blocked run — a check that could not reach the app, an environment that would not boot — is a fault and stays red.

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

### Run-scoped values

Strings in the profile, the seed step, commands, flows and checks may carry
`{{run.<name>}}` references, which the harness substitutes with values minted
fresh for each run. The first minted value is a per-run mail address
(`{{run.mail_address}}`), and a run id and started-at timestamp come free with
it (`{{run.id}}`, `{{run.started_at}}`). A run against a target also mints
`{{run.target_url}}`, the URL its checks point at. Checks may also carry
`{{mail.<name>.link}}` references, which the harness substitutes at run time
with artefacts the run has observed (single-use artefacts, below). This is
substitution, not a language: no expressions, no conditionals, no nesting. A
reference to a name the harness does not mint, to an artefact from a mail check
that has not run yet, or an unterminated `{{`, fails the run closed at plan time
and nothing boots. The minted values are written to the run's evidence, so a
reader can see which address a run used, and two concurrent runs never collide.
Flow definitions substitute with the flow runner.

### Mail checks

A `mail` check waits for one message at an address and reads it. The address
and every matcher (`from`, `subject`, `body`) are literal substrings, may carry
`{{run.<name>}}` values, and all matchers must match the same message. The
harness considers only messages the source reports after the check's own start,
so a rerun waits for a new message instead of matching the previous run's mail.

A mail check may declare `code: {}` when its message carries a one-time code
(#64): the harness extracts the code from the body — by default the first run
of six to eight digits, or the first capture group of a declared `code.pattern`
— publishes it as `{{mail.<name>.code}}` for later checks, and sweeps it from
the evidence like any other secret. A message with no code in it is
`unverified`, naming the mail check and the pattern it looked for.

Where the messages come from is the profile's business, not the plan's: the
optional `mail.inbox` setting names a sink that lists what it caught — a GET of
the inbox URL with `address` and `after` query parameters answers with the
messages sent to that address, along with what it observed (`from`, `subject`,
`body`, `received_at`). The runner polls until a message matches or the check's
timeout passes.

A message that matches is proven, and the evidence records what the harness
actually observed: the sender, the subject, an excerpt of the body, the wait,
and links extracted from the body, marked as harness-produced data rather than
claims. A message that never arrives, and a mailbox that cannot be reached, are
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
criterion planned with a check the runner does not execute yet (visual) is
`unverified` saying so, even when its other checks pass: half a proof is not a
proof. What the verifier overturned is reported on stderr, as `qare judge`
reports it. Evidence goes to `--evidence`, or by default to a directory of its
own under `qare-evidence/` where qare runs, never into the repository
checked. The
evidence directory holds `plan.json`, the executed `result.json` and the
`judged-result.json`, and the exit code is `qare run`'s for the judged
verdict. `--runner none` judges from the evidence alone. Nothing is written
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

## Clients

A flow says what a person does: open this, type that, expect to see the other.
Which software performs those actions is a driver's business. Actions are named
for intent rather than for a library, a driver declares which actions and which
evidence kinds it supports, and a plan asking for something its target cannot do
is rejected before anything boots rather than failing halfway through.

The browser is the first driver. A desktop shell, a phone and a native
application are the same vocabulary against a different tree, and every one of
those platforms exposes an accessibility tree, so element references stay
semantic on all of them: a role and an accessible name, never a coordinate and
never a label a model invented.

Two things do differ by client and belong in the profile rather than in a check.
Getting the application in front of the driver means starting a server for one
client, installing an artefact for another, and launching a binary for a third.
And some clients can only run in certain places, so a target declares what it
requires and a run refuses to start where that is unmet, naming what is missing.

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

### Tools QARE did not ship

A host that installs QARE will have tools QARE has never heard of: an in-house
device rig, a proprietary simulator, a test data service. Rather than a plug-in
system per tool, QARE speaks one generic protocol to them. A profile can
register a host's MCP servers in two ways:

- **For the planner to look through.** They reach the model through nare, like
  every other model tool.
- **As a driver or a check.** QARE's code calls the tools directly, with no model
  in between, by mapping its action vocabulary onto them. The rules do not
  change: references stay semantic, the harness records what the tool returned,
  and code decides the verdict. A tool that can only act on coordinates is not a
  driver.

A registered tool declares which steps it may run in, so a tool that needs a
credential can never be placed in the step that runs pull request code.

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
browser QARE drives is recorded.

There is only one side, so nothing runs at a base revision and no regression is
looked for. The result carries `target: { url, comparison: "none" }` and the
PR comment says so, rather than implying a base comparison that never ran.
`qare readiness` reports a target profile as ready: without a boot, a compose
file and stub coverage are not gaps.

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
  to each screenshot. What a mask cannot cover, text redaction still covers.
- `result.json` is the machine contract other harnesses consume.
- Both artifact schemas are documented in [schemas.md](./schemas.md); the
  orchestrator contract (invocation, exit codes and reaction per verdict) in
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
