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
| **plan** | model key | yes | Reads the criteria, the diff and `.qa/`; writes `plan.json` mapping each criterion to checks tagged `command`, `flow` or `visual`. The planner is also told any flow action kinds the change itself introduces, read from the diff as data. The planner is told the run's declared inputs — the plan file, the profile directory, and every path the diff touches — and a command check reading anything else is corrected against them (#162). The planner is also told that the executing job runs no model, so a criterion whose evidence can only come from a model-driven session is marked unplannable instead of planned as a check for an artifact the pipeline never produces (#168). A plan the loader still rejects after its correction round comes out with every criterion marked `unplannable` naming why (#64), so the pipeline reports the planning gap instead of failing red. Never executes PR code. |
| **execute** | none | stub containers only | Boots the app at the merge base and at the head with stubs, runs the plan, saves artifacts and raw results. |
| **judge** | model key, GitHub token | yes | Computes verdicts in code from raw results, runs the verifier model on the evidence, posts the comment and check. The plan is loaded with the same flow action kinds the plan step was given. |

Execute stages, per side (base, head):

1. Boot from the `.qa/` recipe (compose, command, or preview URL); prove the app is up with a health check the harness runs.
2. Seed fixtures, log in test accounts.
3. Run `command` checks (exit code and output), `flow` checks (a fixed action set driven by a client driver, or existing suites), `visual` checks (named screenshots at named widths and themes), and `mail` checks (a message waited for and read). Each `command` check also writes `command.json` beside its streams: the command as run, its outcome, and the exit code it closed with. A check that passes silently (`test -f`, `grep -q`) saves no output, so the streams alone read as a check that never ran; the record is the evidence that the harness ran it and captured its result.
4. Record every outbound connection attempt. Anything outside the stub map is a `refused: missing stub` finding.

Exploration (#87). When the planner explores a running application, an exploration tool server runs inside the execute sandbox beside the booted app, and the plan step's model session connects to it over the network: the only thing that crosses is tool calls and their results. The server holds no secret — the sandbox environment is built from an allowlist that carries only what an app needs to run, so the model key and every token stay out — and it serves exactly four read-only tools, `observe`, `snapshot`, `navigate` and `capture`; nothing that writes files or runs commands is reachable over the channel, whatever the plan, the profile or a tool result asks for. Every tool result is treated as untrusted input: it is handed to the model fenced as data, and nothing in it can change the plan's schema or the run's policy. Exploring the merge base or a deployed target needs no sandbox split, because there is no PR code beside the app there; the channel is on by default wherever it is available, and off wherever it is not.

Judge:

- Criterion verdicts come from executed results only.
- Visual diffs are advisory evidence for the human, never the sole basis for a pass.
- The verifier model gets the criteria, diff and evidence in a fresh context and reports only criteria the evidence does not actually show. Its findings can downgrade a verdict, never upgrade one. A verifier that gives no readable answer leaves the criteria it was asked about unverified, so the run blocks rather than passing unchecked.
- A blocked run whose every unverified criterion is one the planner could not plan, whose planned command cannot run without a shell, or whose check could not start at all (the planner named an executable the runner does not have), reports the criteria by name and the check run comes out neutral: the gap is in the planning vocabulary, and nothing was disproven. Any other blocked run — a check that could not reach the app, an environment that would not boot — is a fault and stays red.
- A planner whose plan the loader rejects through its correction round ends in the same neutral path: the plan command writes every criterion as `unplannable` naming the rejection, and the run reports rather than fails red.
- A command check may read only the declared run inputs: the plan file itself, the profile directory, and the paths the diff touches. The run's own outputs — `result.json`, `judged-result.json`, `comment.md`, the evidence directory — do not exist while a check runs, because the run writes them when it ends, and the harness's own CLI is not on the runner's PATH. The planner is told this up front; a plan that still reads an undeclared path after its correction round marks the criterion unplannable and the run stays neutral (#162).
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
(`{{run.mail_address}}`), and a run id and started-at timestamp come free with
it (`{{run.id}}`, `{{run.started_at}}`). A run against a target also mints
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

- Every change records who made it, when, and why, and the records are chained,
  so editing, dropping or reordering any of them makes the ledger refuse to
  load: history is never rewritten.
- `qare ledger` reads either backend the same way.
- `qare ledger export` writes the whole ledger, entries and history, as plain
  files at any time, so nobody is locked in, and `qare ledger import` reads an
  export back through the same strict loader, so an export loses nothing.
- `qare ledger publish` writes the current state where the team already looks,
  as a plain markdown file that names the criteria that are unverified, stale —
  changed after the run that last verified them — or quarantined by an open
  question, and the published view is refreshed whenever the ledger changes.

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
criterion planned with a check the runner does not execute yet (visual) is
`unverified` saying so, even when its other checks pass: half a proof is not a
proof. What the verifier overturned is reported on stderr, as `qare judge`
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

### On a host

The host install is the same package the image ships: `@qare/cli` at a pinned
version, with the pinned nare installed beside it (the wheel from nare's
release, `python3 -m pip install --user`), and nothing else added by hand.
Drivers are added on demand, one per client family the profile's suites
actually target: `playwright-core` and `npx playwright install chromium` for a
suite that drives a browser, a container runtime only for a profile that boots
an app.

`qare doctor` names what the host has, what the profile needs, and how to
install what is missing. It checks node, the pinned nare, the docker daemon
for a profile that boots an app, and the chromium driver for a profile whose
suites drive a browser. Display and devices are reported but never required:
the browser driver runs headless, and devices arrive through the profile's
registered MCP servers. A profile that is there but broken is a caller
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
it ran with.

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
