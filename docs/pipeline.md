# Running the QARE pipeline in your repository

qare ships its pull request pipeline as a reusable workflow,
[`.github/workflows/pipeline.yml`](../.github/workflows/pipeline.yml). A
repository calls it from a workflow of about ten lines and pins a qare
release tag. There is nothing to copy and nothing to keep in step by hand:
qare's own pull requests run through the same file
([`qare.yml`](../.github/workflows/qare.yml) is a caller like yours).

The pipeline is collect, plan, execute, judge. collect reads the acceptance
criteria from the issue the pull request promises to close, plan asks a model
for a check plan, execute runs the plan against the pull request with no
secrets on the machine, and judge posts the verdict as one comment and a
check run. A pull request that closes no issue, or an issue that states no
criteria, has nothing to check and stays green.

## The caller workflow

Save this as `.github/workflows/qare.yml`:

```yaml
name: QARE
on:
  pull_request:
jobs:
  qare:
    permissions:
      actions: read
      checks: write
      contents: write
      issues: write
      pull-requests: write
    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.10.4
    with:
      nare-model: gpt-4.1-mini
    secrets:
      model-key: ${{ secrets.OPENAI_API_KEY }}
```

That is the whole installation, beside the profile in `.qa/` that says how
your application boots and what its suites are. `qare init` writes both: this
workflow, pinned to the release of the qare that ran it, and a starting
profile, and it lists what is left for you to fill in. It adds the push
trigger described under "Triggers" when the profile boots an application.

A repository with its own runners, a model behind an OpenAI-compatible
endpoint, a profile somewhere other than `.qa`, and stubs that should
re-queue refused pull requests when they merge, says so in the same place:

```yaml
name: QARE
on:
  pull_request:
  push:
    branches: [main]
    paths: ['services/web/qa/**']
  issue_comment:
    types: [created]
concurrency:
  group: qare-${{ github.event.comment.id || github.ref }}
  cancel-in-progress: true
jobs:
  qare:
    permissions:
      actions: read
      checks: write
      contents: write
      issues: write
      pull-requests: write
    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.10.4
    with:
      runs-on: '["self-hosted", "linux", "x64"]'
      profile: services/web/qa
      nare-base-url: https://llm.example.com/v1
      nare-model: claude-haiku
    secrets:
      model-key: ${{ secrets.QARE_MODEL_KEY }}
      app-id: ${{ secrets.QARE_APP_ID }}
      app-private-key: ${{ secrets.QARE_APP_PRIVATE_KEY }}
      personal-access-token: ${{ secrets.QARE_GITHUB_TOKEN }}
```

The last three lines are who qare posts as, and all three are optional: see
"GitHub identity". The `issue_comment` trigger is optional too: see "Advisory
UX review".

## Inputs

| Input | Default | What it is |
| --- | --- | --- |
| `nare-model` | required | The model the planner and the verifier ask, as the provider names it. |
| `nare-provider` | `openai` | The nare provider that reaches the model. `openai` is any service that speaks Chat Completions (OpenAI, a LiteLLM proxy, vLLM, Ollama); `anthropic` is Anthropic's API. |
| `nare-base-url` | empty | The endpoint of an OpenAI-compatible service. Empty means the provider's own. |
| `model-key-env` | `OPENAI_API_KEY` | The environment variable the provider reads its key from. Set it to `ANTHROPIC_API_KEY` with `nare-provider: anthropic`. |
| `profile` | `.qa` | The directory that holds the QA profile. |
| `runs-on` | `"ubuntu-latest"` | Where every job runs, as JSON: one label, or a list of labels for your own runners. |
| `execute-runs-on` | empty | Where execute runs, in the same JSON form, when it should not share runners with the jobs that hold secrets. Empty means `runs-on`. See "Your own runners". |
| `self-hosted` | empty | `allow` lets a public repository's pipeline run on self-hosted runners. Empty, collect, plan and execute stop there by name, before any checkout. It changes nothing for a private repository or on hosted runners. See "Your own runners". |
| `planner-diff-exclude` | empty | Space-separated git pathspecs left out of the planner's copy of the diff, for a diff too large to plan from whole. execute and judge still read the full diff. |
| `artefacts` | empty | The name of a workflow artifact that holds the builds a client profile installs, uploaded by an earlier job of your workflow. execute downloads it into `qare-artefacts/` at the repository root before the run. See "Profiles that install a build". |
| `qare-ref` | the release | The qare revision the pipeline runs. It defaults to the release the workflow file ships in. Leave it alone and pin the release in `uses:`. |

## Secrets

Each is passed by name. Only the model key is needed for a run:

| Secret | What it is |
| --- | --- |
| `model-key` | The key for the model service. The caller names which of its own secrets holds it: `model-key: ${{ secrets.YOUR_SECRET }}`. |
| `app-id` | The id (or client id) of the GitHub App qare posts as. Optional. It is declared as a secret so that you can hand it over from a secret or from a variable (`${{ vars.QARE_APP_ID }}`). |
| `app-private-key` | A private key of that App, the whole `.pem` file. Optional, and passed together with `app-id`. |
| `personal-access-token` | A personal access token qare posts with when no App is passed. Optional. |

Pass them by name, as above, and never with `secrets: inherit`: the pipeline
should be handed the secrets it uses, not every secret the repository holds.
Only two steps ever see the model key, the planner in plan and the verifier
in judge, and neither holds a GitHub token or the identity. The advisory UX
review is asked in that same judge step, after the verdict is computed, so it
adds no holder of the key. The identity reaches only the steps that write to
GitHub, in judge, report, advisory and requeue.
execute, the job that runs the pull request's code, holds no secret at all.
That map is at the top of `pipeline.yml` and a test holds the file to it.

A pull request from a fork has no secrets, so plan skips and collect says
why. A repository that never set the secret gets a failed plan step that
names `model-key`, not a pass.

## GitHub identity

qare writes to GitHub: one comment and a check run on the pull request,
issues for missing stubs, the `qa-assets` branch, and pull requests that
propose criteria. Who it writes as is your choice, and you make it by which
secrets the caller passes. Nothing else changes, in your workflow or in qare:

| You pass | qare posts as | Notes |
| --- | --- | --- |
| `app-id` and `app-private-key` | your GitHub App, `<app name>[bot]` | Preferred for an organisation: its own actor, installed per repository, scoped permissions, a far higher rate limit. |
| `personal-access-token` | the user the token belongs to | One secret and nothing to register. The rate limit is shared with everything else that user runs. |
| neither | `github-actions[bot]`, with the run's own token | Nothing to set up. Good for verdicts and comments; it cannot open a criteria proposal that gets checked (below). |

When more than one is passed, the App wins over the token, and either wins
over the run's own token. Passing `app-id` without `app-private-key`, or the
reverse, stops the posting step with a message that names the missing one:
half an App never falls back to a weaker identity without saying so.

Two constraints decide between them:

- **A pull request opened with the run's own token triggers no workflows.**
  GitHub does this so workflows cannot start each other without end. A
  criteria proposal opened that way would reach its reviewer with no checks
  on it, so `qare-action ingest-deliver` refuses to open one with the run's
  own token, under whatever name it was handed over, and names the two
  identities that can. Verdicts, comments and
  stub issues do not have this constraint.
- **Only a GitHub App may write a check run.** A personal access token
  cannot, whatever its scopes. With a token, the check run is still written
  by the run's own token, which GitHub counts as an App, and everything else
  is written as the user. This needs nothing from you: the pipeline hands the
  posting steps both.

What each needs:

The GitHub App, as repository permissions, installed on every repository
that calls the pipeline:

| Permission | Access | What it is for |
| --- | --- | --- |
| Contents | Read and write | The `qa-assets` branch, and the branch a criteria proposal is opened from. |
| Issues | Read and write | Stub issues, sweep findings, findings on `main`, questions on issues, an advisory finding a person promoted. |
| Pull requests | Read and write | The evidence comment, the `/qa` comments of requeue, the answers to advisory replies, criteria proposals. |
| Checks | Read and write | The `QARE verdict` check run. |
| Metadata | Read | Required by GitHub for every App. |

It needs no webhook, no organisation permission and no account permission.
qare signs in as the App with the private key, asks for the installation on
the calling repository, and is given a token for that one repository that
expires within the hour. The key itself is only ever used to sign in.

A personal access token, fine-grained, limited to the repositories that call
the pipeline: Contents, Issues and Pull requests at Read and write, Metadata
at Read. A fine-grained token has no Checks permission to grant, for the
reason above. A classic token needs the `repo` scope (`public_repo` is enough
for a public repository). Neither needs the `workflow` scope: qare never
writes a workflow file.

The run's own token needs only the permissions the calling job grants, which
is the next section. Keep granting them whichever identity you choose: the
check run under a personal access token is written with them, and collect
reads the linked issues with them.

Two things change on the pull requests that are open when you switch:

- The comment is found again by its author. The new identity posts a comment
  of its own, and the one the old identity left stays as it was, naming the
  commit it checked.
- The `QARE verdict` check run comes from a different App. If a branch
  protection rule requires that check from a named source, choose the new
  source there.

## Permissions

A called workflow can hold no permission its calling job does not grant, so
the calling job grants the ceiling and each pipeline job declares only what
it needs under it:

| Permission | Which job uses it |
| --- | --- |
| `contents: write` | judge, to push the run's screenshots to the `qa-assets` branch. Every other job reads. |
| `checks: write` | judge and report, for the check run on the head commit. |
| `pull-requests: write`, `issues: write` | judge, report, advisory and requeue, for the comment, the stub issues and the replies to advisory findings. collect reads issues. |
| `actions: read` | report, to name the job and step that failed when no verdict was published. |

These are the permissions of the run's own token. A GitHub App or a personal
access token carries its own (see "GitHub identity"), and the calling job
grants these all the same.

Granting less stops the run before any job starts, with an error that names
the job and the permission.

## What the runner needs

A GitHub-hosted runner has all of it. Your own runner needs `docker`, `git`,
`jq` and the `gh` CLI. It does not need node, pnpm or Python set up by hand:
plan, execute and judge run qare and nare inside the published images
(`ghcr.io/vividynamics/qare-core` and the flavour the profile names), and
the three jobs that hold only the GitHub token set up node themselves.

A profile that boots its application (`app.boot`) also needs, on the runner
execute lands on, the docker compose v2 plugin, and the buildx plugin if the
compose file builds an image. The runner's user must be able to run
`docker compose` itself: execute hands the run exactly the docker that user
has. A runner with no compose plugin says so in the job summary.

## Profiles that boot an application

execute runs `qare run` inside the image, and the run boots the profile's
compose file against the runner's docker daemon. The containers compose
starts are siblings of the run's container, not children of it, so three
things hold:

- **The app is at `localhost`.** The run shares the runner's network. qare
  picks a free port and hands it to compose as `QARE_APP_PORT`, so the compose
  file publishes on it, `ports: ["127.0.0.1:${QARE_APP_PORT:-3000}:3000"]`,
  and the profile's health URL and every check name the app at
  `http://localhost:{{run.app_port}}`.
- **Paths are the runner's.** The workspace is mounted at its own path, so a
  bind mount or a build context a compose file names resolves for the daemon
  exactly as it does for the run.
- **A suite can run inside the booted service.** The run's compose project is
  `qare-<run id>`, so a suite that needs the stack's own hostnames (a
  database, a stub) names it:

  ```yaml
  suites:
    - name: sign-in
      command: "docker compose -p qare-{{run.id}} -f compose.qa.yaml exec -T web bundle exec cucumber features/sign_in.feature"
      kind: flow
  ```

When the run ends, the pipeline takes its compose projects down, volumes
included. Images the stack built stay in the runner's cache.

[`examples/compose-app`](../examples/compose-app) is a small profile of this
shape. qare's CI runs the pipeline's own execute steps against it on every
change, so this path is exercised and not only described.

## Profiles that install a build

A desktop application is not booted: it is a build that qare installs,
launches and removes again. The profile names the build as an artefact, for
the head and, when you want regressions found, for the base:

```yaml
# .qa/config.yml
client:
  driver: electron
  args: [--no-sandbox]
  artefact:
    kind: archive                           # a tar; or `directory` for an unpacked build
    executable: my-app/my-app               # inside the installed artefact
    head: { path: qare-artefacts/head.tar } # from the repository root
    base: { path: qare-artefacts/base.tar } # optional: gives the run its base side
  health: { timeout: 30s }                  # how long the first window may take
flavour: web
```

Building is your pipeline's step, not qare's: execute runs in the qare image,
which carries no toolchain of yours, and it reaches nothing outside the run.
So a job of your workflow builds the artefacts and uploads them as one
artifact, and the pipeline is told its name. execute downloads the artifact
into `qare-artefacts/` at the repository root, whatever the artifact is named (the checkout must not carry a path of that name), which is where the
profile's paths above find it:

```yaml
name: QARE
on:
  pull_request:
jobs:
  qare:
    needs: build
    permissions:
      actions: read
      checks: write
      contents: write
      issues: write
      pull-requests: write
    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.10.4
    with:
      nare-model: gpt-4.1-mini
      artefacts: qare-artefacts
    secrets:
      model-key: ${{ secrets.OPENAI_API_KEY }}
  build:
    runs-on: ubuntu-latest
    # This job runs pull request code: give it no secret.
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - run: make package && mkdir -p qare-artefacts && cp out/my-app.tar qare-artefacts/head.tar
      # The build of the base: whatever your pipeline already keeps for the
      # default branch, fetched here, or built here from the base commit.
      - run: make fetch-base-build && cp out/base/my-app.tar qare-artefacts/base.tar
      - uses: actions/upload-artifact@v4
        with:
          name: qare-artefacts
          path: qare-artefacts/
```

The run then provisions each side: it takes the artefact that is there (a
base build that already exists is installed as it is, with no checkout of the
base and nothing rebuilt), installs it into a directory of its own, launches
it once to prove it comes up, runs the plan against it, and removes it. Each
side's `provision.log` in the evidence says what was installed, by the hash
of the file, and that it was removed. qare cannot tell which revision a
prebuilt file was built from: the job that produced it vouches for that.

A provisioning that fails is `blocked`, never a failed criterion: an artefact
that is not there, will not install, or does not come up stops the run with a
reason that names the artefact, and the log is attached. A base artefact that
cannot be provisioned never blocks the head: the base is reported as not
checked, naming the artefact, and every criterion as not compared.

`client.artefact.<side>.build` names a command that produces a side's
artefact when it is not there. It is spawned with no shell, in the tree of
its side, and told where to write in `QARE_ARTEFACT`. It runs where the run
does, so it is of use to `qare run` on a host that has your toolchain, and
rarely inside the pipeline's image.

`client.executable`, the earlier shape, still names a build that is already
unpacked in the checkout and is launched in place, one side only.

[`examples/electron-app`](../examples/electron-app) carries a profile of this
shape (`profiles/desktop-provisioned`). qare's CI packages a base and a head
build of it and runs the pipeline's own execute step against them on every
change (`scripts/client-provision.sh`). The `artefacts` input itself is a
plain artifact download and is not exercised there.

## Profiles whose application sends mail

A mail check reads from the source the profile declares, and locally that is
a catcher in the stack. The stack provides it, like any other stub:

```yaml
# compose.qa.yaml
services:
  web:
    ports: ["127.0.0.1:${QARE_APP_PORT:-3000}:3000"]
    environment: { SMTP_HOST: mailpit, SMTP_PORT: "1025" }
  mailpit:
    image: axllent/mailpit:v1.27
    environment: { MP_WEBROOT: mailpit }
```

```yaml
# .qa/config.yml
mail:
  source: { kind: mailpit, url: "http://localhost:{{run.app_port}}/mailpit" }
```

The compose fragment starts the catcher; it does not route to it. The profile
above reads the catcher under `/mailpit` on the app's port, so something on
that port has to pass `/mailpit` on to `mailpit:8025`: a rule in the reverse
proxy in front of the app, or a few lines in the app's QA build.
[`examples/mail-app/server.mjs`](../examples/mail-app/server.mjs) does it in
one function. Without that rule `/mailpit` reaches the application, and every
mail check is `unverified`, naming the catcher it could not read.

- **One port per run.** qare mints one host port for a run. Serve the catcher's
  web interface behind the app's own port, with the proxy rule described
  above, and every run has a catcher of its own. A catcher
  published on a fixed port of its own is shared by every run on the runner,
  the base side included.
- **Mint the address.** Sign up, invite and reset with `{{run.mail_address}}`.
  Each run waits at its own address, so runs that do share a source never read
  each other's mail, and the run deletes what it was sent when it finishes.
  One shared inbox cannot offer either.
- **A domain for test mail.** A source that only receives for a real domain
  takes `mail.domain`, and addresses are minted on it. Give test mail a
  subdomain of its own (`qa-mail.example.com`), apart from the mail people
  read.
- **Never a person's mailbox.** A mail source is read, searched and deleted
  from by a machine. Point it at nothing a person depends on.
- **The sending check goes first.** In a criterion, the check that makes the
  app send comes before the mail check. Only a message that arrives after the
  criterion started is read.

[`examples/mail-app`](../examples/mail-app) is a profile of this shape, with
an app that sends over SMTP. qare's CI runs the pipeline's own execute steps
against it, reads the message from a real Mailpit, and then runs two waits at
once on one catcher.

Reading a real provider's mailbox on a deployed environment is not built yet
(#217). Its credentials could not live in execute, which runs pull request
code and holds no secret.

## Your own runners

qare's rule is that secrets never share a machine with pull request code.
On GitHub-hosted runners every job gets a fresh machine, so the rule holds
by construction. A runner that outlives its job is different: execute runs
the pull request's code with the runner's docker daemon in reach, and
whoever can ask a docker daemon for a container owns the machine it runs on.
The container the run executes in is not a sandbox. Whatever the pull
request leaves behind, as root, is still there when a later plan or judge
job, holding the model key or a token that can write, lands on the same
machine. Why execute is handed the daemon anyway, and what was weighed, is
recorded in
[ADR-0005](./decisions/adr-0005-execute-docker-access.md).

So with your own runners, do one of these:

- use runners that are created for one job and destroyed after it, or
- give execute a pool of its own with `execute-runs-on`, one that never
  runs plan, judge or any other job that holds a secret:

  ```yaml
      runs-on: '["self-hosted", "linux", "x64"]'
      execute-runs-on: '["self-hosted", "linux", "x64", "untrusted"]'
  ```

One pool of long-lived runners for every job works, and is what a single
`runs-on` gives you, but it is weaker than the rule: treat it as trusting
every pull request author in the repository with the model key.

Inside each job the boundary holds either way: execute's checkout leaves no
token on disk, plan's checkout leaves none either, and the model key is
handed to the planner and the verifier in a file outside the workspace that
is removed when the step ends.

### A public repository stays on hosted runners

A public repository's pull requests are written by people you have not met,
and a runner that outlives its job keeps whatever one of them left on it. So
for a public repository the pipeline does not run on a self-hosted runner:
collect, plan and execute each stop at their first step, before anything of
the pull request is checked out onto the machine. The job fails, its summary
gives the reason, and the report job posts that the run was not evaluated,
naming the step:

> this repository is public and the run landed on a self-hosted runner: a
> public repository keeps its runs on GitHub-hosted runners, because a runner
> that outlives its job keeps whatever a pull request left on it; to use your
> own capacity anyway, opt in with the pipeline input self-hosted: allow

Self-hosted capacity is opt in. If your runners are made for one job and
destroyed after it, or you accept the risk, say so beside the labels:

```yaml
    with:
      runs-on: '["self-hosted", "linux", "x64"]'
      self-hosted: allow
```

The rule reads three facts: what GitHub Actions says the runner is
(`RUNNER_ENVIRONMENT`), the repository's visibility, and this input. A
private repository chooses its own runners and is asked nothing.

`qare run` holds the same rule itself, in the same words, and execute hands
it the same three facts. So a `qare run` you start in a workflow of your own
is covered when you tell it them: `QARE_REPOSITORY_VISIBILITY=public` on a
self-hosted runner ends `refused` (`refused: placement: ...`), with nothing
provisioned, unless `QARE_SELF_HOSTED=allow`. By then your workflow has
already checked the pull request out, which is why the pipeline's own guard
comes before its checkout.

## Where a run can execute

Some applications cannot run anywhere. A simulator needs macOS, an emulator
needs hardware virtualisation, a phone needs to be attached. A profile says
what it requires of the host, and a run on a host that does not have it is
refused before anything is provisioned, naming what is missing:

```yaml
# .qa/config.yml
requires:
  os: macos              # linux, macos or windows
  virtualisation: true   # hardware virtualisation, which an emulator needs
  devices: [android]     # an attached device of each kind
```

Every key is optional, and a profile that says nothing requires nothing
beyond what its shape implies: a client build that runs contained requires a
host that can make its cell, and one that opts out
(`client.egress: uncontained`) requires a display. Those two are the same
requirement table, so they are refused the same way.

On a host that is short, the run's verdict is `refused` and every criterion
is `unverified` with the reason, for example:

> refused: unmet requirement: a macos host (requires.os): this host is linux.
> Nothing was provisioned.

Everything that is missing is named at once. `refused` is not a fault in the
change, so the check run is neutral and execute stays green; the fix is where
the run is placed. `qare doctor --profile .qa` holds a host to the same table
before a run does.

What this does and does not cover today:

- The pipeline's execute job runs in the qare image, which is a Linux
  container. Inside it the host is Linux whatever the runner is, so in the
  pipeline a profile that requires macOS or Windows is always refused, by
  name, and no choice of `runs-on` changes that yet. Such a profile runs
  where `qare run` is started on that host itself. Prepared macOS and Windows
  hosts for the pipeline are their own work (#90).
- Hardware virtualisation is detected on Linux, as a `/dev/kvm` the run's
  user can open. The pipeline does not hand `/dev/kvm` to the run's container
  yet, because no driver uses it (#73), so `requires.virtualisation` is unmet
  there.
- An attached device is a physical Android device that `adb devices` lists as
  `device`. An emulator is not counted: it is what `virtualisation` is for.
  iOS devices arrive with their driver (#74), and until then `ios` is refused
  when the profile loads.
- Nothing here claims, resets or shares a device between runs (#77).

The evidence says where a result came from. `result.json` records the host
kind under `environment.host` (operating system, architecture, whether
hardware virtualisation is usable, and `github-hosted` or `self-hosted` when
the run was on a runner), on each side of a two-sided run, and what the
profile required under `requirements`. The comment says both:

> Executed in a container on a linux x64 host, a GitHub-hosted runner, with
> qare (its version), node (its version), nare contract 1.

## Advisory UX review

Some problems a change introduces are judgement calls no criterion states: a
field with no label, an error message that helps nobody, wording that does
not match the screens around it. When a run's flows drove pages, judge asks a
model to read what the run saw of them (the action logs, the accessibility
snapshots and the audit records, not the pixels) and to say what a person
might trip over. What it reports is advisory: it appears in a section of its
own in the comment and under `advisory` in `judged-result.json`, and it is
never part of the verdict. The verdict, the check run and the exit codes are
computed before the reviewer is asked, and a reviewer that fails to answer
changes nothing but that section.

It is on by default and costs one more model call on a run that has screens;
a run with none makes no call. The profile turns it off, or gives it the
rules your screens are held to:

```yaml
ux:
  review: false
  rules:
    - Buttons are sentence case.
    - An error message says what went wrong and what to do next.
```

Each finding has an id. Two replies on the pull request act on one, each
written as the first line of a comment:

- `/qa-dismiss <id>` records that the finding is not to be raised again on
  that pull request. The next run's reviewer is told what was dismissed, and
  a finding with the same identity (the same screen, category and element)
  is dropped in code.
- `/qa-promote <id>` files the finding as an issue: what was seen, why it
  matters, the screen, its screenshot, and a link back to the pull request.
  qare files no issue unless asked.

qare answers each reply once, in a comment that is also its record. It acts
only on a reply from an owner, a member or a collaborator of the repository,
and reads findings only from its own comment.

A reply is carried out by the next run of the pipeline on that pull request.
To have it carried out at once, let the caller listen for comments:

```yaml
on:
  pull_request:
  issue_comment:
    types: [created]
```

With that trigger a new comment starts a run in which only the `advisory`
job can run, and only when the comment opens with one of the two commands on
a pull request; every other comment starts a run whose jobs all skip. If
your caller sets a `concurrency` group on `github.ref`, give a comment's run
a group of its own, as the larger caller above does: on a comment the ref is
the default branch, and a shared group would let one comment cancel another
run.

## Findings on main

A run against `main` has no pull request to comment on. `qare-action
main-findings` files what it found as issues instead: one per problem,
commented on while it still fails, closed when a run proves the criterion
again. See "Findings on main" in [SPEC.md](./SPEC.md) for what an issue says
and whom it mentions.

Nothing in the pipeline calls it. It opens issues and mentions people, so
it is a step you add, in a job that already has a judged result of a run on
your default branch:

```yaml
      - name: File what the run on main found
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          QARE_APP_ID: ${{ secrets.QARE_APP_ID }}
          QARE_APP_PRIVATE_KEY: ${{ secrets.QARE_APP_PRIVATE_KEY }}
          QARE_GITHUB_TOKEN: ${{ secrets.QARE_GITHUB_TOKEN }}
        run: |
          node qare/packages/action/dist/index.js main-findings \
            --result judged-result.json --ledger .qa --profile .qa \
            --sha "${{ github.sha }}" --repository "${{ github.repository }}" \
            --run-url "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

| Flag | What it is |
| --- | --- |
| `--result` | The judged result of the run on `main`. Required. |
| `--ledger` | The ledger directory: when each criterion last passed, its text and its checks. Required. |
| `--sha` | The 40 character commit the run checked. Required. |
| `--profile` | The profile directory: `findings.fallback`, `findings.bots` and the `redact` rules. Without it nobody is a fallback and only the built-in rules redact. |
| `--evidence` | The run's evidence directory. Given, the failing criteria's screenshots are pushed to `qa-assets` and linked. |
| `--run-url`, `--artifact-url` | Links the issue carries. Each must be an https URL. |
| `--dry-run true` | Reads, writes nothing, and prints what a real run would open, comment on, reopen or close, and whom it would mention. Run it first. |

The job needs `issues: write` to file, `pull-requests: read` and `contents:
read` to read the range, and `contents: write` only when `--evidence` pushes
screenshots. It is a judge-side step: give it the identity and nothing that
runs repository code (rule 7).

The profile says who hears of a finding nobody can be blamed for:

```yaml
findings:
  fallback: acme/qa-leads   # a person or a team
  bots: [release-robot]     # an orchestrator that opens pull requests with a person's token
```

The labels `qa-regression`, `qa-environment` and `qa-failure` are created by
GitHub the first time an issue carries one.

## Triggers

The triggers are yours. `pull_request` runs the pipeline. A `push` to your
default branch, filtered to the profile's path, runs requeue alone: it posts
`/qa` on pull requests that were refused for want of a stub the push just
merged. Leave the push trigger out if you do not use stubs. Filter pushes to
the default branch, so the `qa-assets` pushes judge makes do not start a run.
An `issue_comment` trigger runs the advisory job alone, on a reply to an
advisory finding: see "Advisory UX review".

Call the pipeline once per workflow run. Its artifacts have fixed names, so
two calls in one run would overwrite each other.

## Upgrading

Change the tag in `uses:`. That one line moves the pipeline, the qare the
token-only jobs build, and the images plan, execute and judge pull, to the
same release, because each release's `pipeline.yml` pins that release.

Pin a release tag, never `main` and never a commit: `main` carries a
pipeline that is ahead of the qare its pin names.
