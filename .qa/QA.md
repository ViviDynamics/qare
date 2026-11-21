Executable mail self-checks (#290): these criteria describe qare's source,
not the Wikipedia application. Never substitute a Wikipedia password-reset
flow or a real mailbox for a check of the harness's parser or evidence writer.
The profile declares two checks that run the changed checkout in the published
Node image, without a build, test runner, network, model or credentials:

- Quoted Authentication-Results values: `node -- .qa/checks/mail-evidence.mjs quoted-auth`.
  It invokes the checkout's parser and asserts that spaces around equals signs
  in quoted reason and selector values survive. Its output contains the actual
  parsed values.
- A mail check whose message carries no code: `node -- .qa/checks/mail-evidence.mjs missing-code`.
  It invokes the checkout's runJob with a controlled message and boot adapters,
  asserts that the criterion is unverified naming the missing code, reads the
  message.json the run wrote, and asserts its delivery and the mail proof.
  Its output contains the observed outcome, message record and proof.

Choose the declared mail-self-check command with the matching check name for
these behaviours. The source loader uses Node's TypeScript transformer and the
image's shipped production YAML dependency; it does not use the image's built
qare as the thing under test. Scratch is restricted to .qa/checks/scratch.
The profile has no mailbox for mail checks against its target.

Executable pipeline default checks (#380): the pipeline's flake retries and
quarantine, its default planner diff exclusion and its blocked-check opt-in are
proven by `node -- .qa/checks/pipeline-defaults.mjs <check>`, the declared
pipeline-defaults-check command, with check `flake`, `exclude` or `blocked`.
They run the workflow's own step scripts with docker and git stubbed and the
checkout's core source, without a build. Choose them for those criteria; the
repository's vitest and node --test files import built packages and cannot run
in the image.

Executable http check checks (#378): the http check kind's plan shape and
bounds, its evidence, its code-decided verdict and its place in the planner's
prompt are proven by `node -- .qa/checks/http-check.mjs <check>`, the declared
http-check command, with check `plan`, `record`, `judge` or `planner` (`record` is the one that
prints the http.json evidence an http check writes). They
run the checkout's core source without a build, with the app under test
standing in for fetch in the same process, so they need no network, model or
credentials. Choose them for those criteria, never a grep of the source or a
Wikipedia page: the target has no API of its own to send an http check to.

Executable pinned stack checks (#408): a contained service keeping every
network it had (the implicit `default` included, `ipv4_address` kept), the
unit test that covers it, the relay and the resolver reaching services by
the addresses the run reads from the daemon and not by name, and a stack
the run cannot finish containing booting uncontained with the reason are
proven by `node -- .qa/checks/pinned-stack.mjs <check>`, the declared
pinned-stack-check command, with check `merge`, `unit`, `boot`, `sink`,
`uncontained` or `ci`. They run the checkout's core source without a build,
with compose and docker standing in and every service name lookup failing,
so they need no daemon, network, model or credentials. Choose them for
those criteria, never a grep of the source. The real docker boot of
examples/pinned-app is CI's compose-boot job (`ci` prints that step).

Executable boot failure checks (#407): a booted stack that did not come up
(compose up exited, health, watchdog, containment, seed) read before any
down, each service's last 200 log lines saved redacted at
`<side>/services/<service>.log`, result.json `boot` and `base.boot` naming
each service, its exit code and its last 20 lines, the names a contained
stack looked up before it failed recorded in `egress`, and the comment
naming the service, its exit code and its last lines are proven by
`node -- .qa/checks/boot-failure.mjs <check>`, the declared
boot-failure-check command, with check `boot`, `run`, `base`, `seed` or
`ci`. They run the checkout's core source without a build, with compose
standing in, so they need no daemon, network, model or credentials. Choose
them for those criteria, never a grep of the source. The real docker boot of
examples/crash-app, whose service prints a known line and exits 1, is CI's
compose-boot job (`ci` prints that step).

Executable command boot checks (#379): booting an app by `app.boot: { command,
image, port }`, its run against health, seed, checks and suites, isolation of
concurrent runs with reap, and `qare init` offering the command form are proven
by `node -- .qa/checks/command-boot.mjs <check>`, the declared
command-boot-check command, with check `boot`, `run`, `isolation` or `init`.
They run the checkout's core source without a build, with compose standing in
for docker and reading the project file the run writes, so they need no daemon,
network, model or credentials. Choose them for those criteria, never a grep of
the source: a grep shows that a string exists, not that the boot works. The
real docker boot of examples/command-app is CI's compose-boot job.

Executable faster booted run checks (#381): each job's wall clock in the
metrics record and the standing report, collect running the published image,
a prebuilt base image, `base.criteria` defaulting to `ledger`, and the opt-in
build cache are proven by `node -- .qa/checks/faster-runs.mjs <check>`, the
declared faster-runs-check command, with check `jobs`, `collect`,
`base-image`, `ledger-default` or `build-cache`. They run the workflow's own
step scripts and the checkout's core source without a build, with curl,
docker and compose standing in, so they need no daemon, network, model or
credentials. Choose them for those criteria, never a grep of the source: a
grep shows that a string exists, not that the base side or the cache works.

qare repository QA profile (self-run target).

What this is: the profile qare's own self-run executes, so a pull request
that links flow criteria runs them for real instead of being refused for
want of a profile (#128). The repository has no app of its own to boot, so
the profile names a target (#122): the public site the examples use, checked
in place. qare boots nothing, stubs nothing, and compares nothing with a
base revision, because there is none.

What a check looks like: a flow's `open` takes a path on the target, which
resolves against the target URL, and the typed actions drive the browser.
Searching for an article and reading the results page, where the top entry's
snippet opens with the names that prove it is hers:

    - { action: open, url: /wiki/Main_Page }
    - { action: type, element: { role: searchbox, name: Search Wikipedia }, value: Ada Lovelace }
    - { action: click, element: { role: button, name: Search } }
    - { action: assert, text: Augusta Ada King }
    - { action: assert, text: Countess of Lovelace }

Search the way the example does: click the Search button rather than a
suggestion under the search box, because the suggestions are several links
with overlapping names and the run refuses an element it cannot resolve to
one.

Boundary: the target is the live site, so the run needs the network, and a
page that cannot be reached is reported unverified or blocked, never failed.
The checks drive a browser, so the run executes in the published web image
(#88): the profile names `flavour: web`, and the pipeline's execute step pulls
the flavour the profile names.

What qare is: a harness a repository points at its own pull requests. The
pipeline collects the criteria from the issue, the planner turns each one
into checks, the runner executes the plan, and the judge reads the evidence
against the criterion. The planner is a model: it plans well only when the
profile tells it the truth about what a check can do here.

What qare's own criteria are usually about, and how each is shown in real
development:

- A package's behaviour: its executable source self-check when declared, otherwise its vitest tests, filtered to the behaviour.
- The CLI's behaviour: the built CLI driven with fixtures.
- The pipeline contract: the workflow's structural tests.
- A flow against a running site: the kind this profile's target covers.

What a self-run can and cannot show. The executing job runs the published
image against a raw checkout of the pull request: it installs and builds
nothing, and the image carries no test runner, no npm, no git and no jq.
Because of that:

- Other criteria shown only by a test suite are out of reach: the checkout has no
  node_modules and there is no test runner to invoke. Mark it unplannable
  naming the missing test runner instead of guessing an invocation that
  cannot start.
- The CLI's behaviour through this pull request's own build is out of reach
  for the same reason: nothing builds the checkout, and the image's own qare
  binary is the base revision's, which says nothing about the change.
- Evidence only a model-driven session can produce is out of reach: the
  executing job runs no model.
- A behaviour that needs Docker the check drives itself, several concurrent
  runners, or a clock the check controls is out of reach: the image has no
  Docker CLI, the job runs one runner, with its own clock.
- Beyond the declared source checks, a check script that would need writing
  is out of reach: the image runs only files the checkout already carries. A criterion whose check would be a new script is unplannable
  naming the missing script, never a path that does not exist. The checkout
  carries no `checks/` directory and no `selection-verdict` or similar
  helper anywhere: a plan naming one is a fiction that turns red at
  execution, so do not write such a path into a plan.
- A criterion that describes what the harness itself does with evidence
  files is still checked against the checkout the change really touches:
  grep the files that changed with the declared `source` command, or mark
  the criterion unplannable naming the missing vocabulary, rather than
  planning a script the repository does not carry.

What a command check can genuinely show: structure on the paths the change
touches, read with the tools the image really has. The profile declares those
commands; prefer them over inventing invocations, fill every placeholder from
the criterion, and keep the check inside the declared run inputs.
