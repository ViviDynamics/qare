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
    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.10.46
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
On GitHub-hosted runners, no extra runner setup is needed.

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
    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.10.46
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
| `nare-stream` | empty | Set to `true` to stream the planner's and the verifier's model turns, so an edge proxy that cuts idle connections before a turn completes is not the failure. Empty keeps the default, non-streaming; the output is the same either way. |
| `max-output-tokens` | empty | The most the planner, the verifier and the UX review may write in one model turn, in tokens. Empty keeps qare's default of 16384. A reasoning model spends this budget thinking before it answers: raise it when a turn is cut off at `max_tokens` (the plan step says so, with the budget it ran on), and lower it for a model that allows less, knowing a lower budget can cut the UX review short too. Outside the pipeline the same setting is the `QARE_MAX_OUTPUT_TOKENS` environment variable. |
| `plan-batch-size` | empty | How many criteria the planner is asked to plan in one model turn. Empty keeps qare's default of 1: each criterion is its own turn, with its own `max-output-tokens` budget, and the turns' plans are merged into one plan that holds every criterion once. A turn that is cut off, errors or is refused costs only its own criteria, which come back unplannable with the reason, and the plan's recorded usage is the sum over every turn. One is the default because it is what keeps a slow reasoning model inside the default budget; every turn carries the diff again, so raise it for a model that answers fast and bills for input. Outside the pipeline the same setting is the `QARE_PLAN_BATCH_SIZE` environment variable. |
| `plan-concurrency` | empty | How many plan batches may be with the model at the same time. Empty keeps qare's default of 1: the batches run one after another, which is what every endpoint can take. The batches are independent, so the plan is the same at any setting: every criterion once, in the order asked, with the usage summed over every batch, and a batch that fails while others are in flight still costs only its own criteria. It helps when the endpoint serves several requests side by side (a hosted model, or a self-hosted server with spare parallel slots) and the plan has more than one batch: the wall clock of the plan step falls towards that of its slowest batch. It does not help when the endpoint serves one request at a time or shares one GPU between them (the turns queue or each runs slower, and a turn that waits long enough can be cut by a proxy's timeout or refused with a rate limit, which costs that batch's criteria), when the plan is a single batch, or for cost: the same turns are sent, and the tokens are the same. The number of batches comes from `plan-batch-size`; this setting only says how many of them wait on the model at once. Set it to what the endpoint is known to take, not higher. A plan whose turns are given a tool channel runs one batch at a time whatever this says: the exploration channel serves one page that every turn would steer, and the profile's registered MCP servers (`mcp:`) are started once for the whole plan and may hold state that one turn would move under another. Outside the pipeline the same setting is the `QARE_PLAN_CONCURRENCY` environment variable. |
| `verify-batch-size` | empty | How many proven criteria the verifier is asked about in one model turn. Empty keeps qare's default of 1: each proven criterion is its own turn, with its own `max-output-tokens` budget, and the turns' findings are merged. A turn that is cut off, errors or cannot be read leaves only its own criteria unverified, with the reason, and the verifier's recorded usage is the sum over every turn. It is a setting of its own and not `plan-batch-size`: the planner writes checks and the verifier reads evidence, so the size that suits one says nothing about the other. Every turn carries the diff again, so raise it for a model that answers fast and bills for input. The verifier is pointed at the last 16 KiB of a long suite stream (`stdout.tail.txt`), not at the whole file, so a suite's output cannot by its size push a turn past the budget. Outside the pipeline the same setting is the `QARE_VERIFY_BATCH_SIZE` environment variable. |
| `model-key-env` | `OPENAI_API_KEY` | The environment variable the provider reads its key from. Set it to `ANTHROPIC_API_KEY` with `nare-provider: anthropic`. |
| `profile` | `.qa` | The directory that holds the QA profile. |
| `runs-on` | `"ubuntu-latest"` | Where every job runs, as JSON: one label, or a list of labels for your own runners. |
| `execute-runs-on` | empty | Where execute and main_execute run, in the same JSON form. Self-hosted execution requires a pool different from `runs-on`, unless `ephemeral-runners` is `true`. Empty still means `runs-on` on GitHub-hosted runners. See "Your own runners". |
| `ephemeral-runners` | empty | `true` declares that each job gets a fresh machine destroyed afterwards, with no docker daemon, volume or cache shared between jobs. This caller declaration is recorded in `result.json` and posted evidence; qare cannot verify the lifecycle. See "Your own runners". |
| `self-hosted` | empty | `allow` lets a public repository's pipeline run on self-hosted runners. Empty, collect, plan and execute stop there by name, before any checkout. It changes nothing for a private repository or on hosted runners. See "Your own runners". |
| `planner-diff-exclude` | empty | Space-separated git pathspecs left out of the planner's copy of the diff, for a diff too large to plan from whole. execute and judge still read the full diff. |
| `artefacts` | empty | The name of a workflow artifact that holds the builds a client profile installs, uploaded by an earlier job of your workflow. execute downloads it into `qare-artefacts/` at the repository root before the run. See "Profiles that install a build". |
| `main-lane` | empty | `true` runs the main lane: on a push to your default branch, on a schedule or on a manual run, the pipeline boots the app, runs the suites the ledger records for its active criteria, judges them, and hands the result to `main-findings`. Empty, none of it runs. See "Findings on main". |
| `main-lane-dry-run` | `true` | Whether the main lane only says what it would file. Anything but `false` is a dry run: it reads, prints the issues it would open and whom it would mention, and writes nothing. |
| `main-lane-record-passes` | empty | `true` has the main lane record what each run proved, in `passes/main.json` on the `qa-assets` branch, so that a later failure is a `qa-regression` traced to the changes since. Anything else records nothing, and so does a dry run. See "Regressions" under "Findings on main". |
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

Where the private key goes: one step of each job that posts, and nowhere
else. That step, "Mint the App token for this job", runs
`scripts/mint-app-token.mjs` of the pinned qare with node on the runner,
before any dependency is installed, any artifact downloaded or any container
run. The script imports node's own modules alone. It signs in as the App with the private
key, asks for the installation on the calling repository, and is given a
token for that one repository, with the permissions that job declares and no
others, that expires within the hour. The steps that post are handed that
token and the App's slug. The key never enters a container, and no step that
holds it reads anything the run produced. A job tries to give its token back
when it ends, whether it passed or failed (with `curl` 7.55 or later; a
revocation that fails is a warning, and the token expires within the hour
either way).

What this does not change: the key is still a secret of the job. GitHub
hands a job's runner every secret the job's steps name, so what runs on the
runner later in the same job (the build of the pinned qare in report,
advisory and requeue, by its lockfile and with no cache, and the step that
enables pnpm with corepack) runs on a machine that was given the key, though never
in its own environment. A container is not that machine. And "before
anything else of the run" is a statement about one job: a runner that
outlives its jobs keeps what earlier jobs left on it, so on your own runners
give execute a pool of its own with `execute-runs-on`.

Before judge and main_judge post from the image with a minted token, they
check that the image reads one, and stop by name if it does not: an image
older than this would otherwise find no App and post as something weaker.

Three things follow from that:

- **The App must hold each permission in the table.** A job asks for exactly
  what it declares (judge: Contents, Checks, Issues and Pull requests at
  write; report: Checks, Issues and Pull requests at write and Contents at
  read; advisory and requeue: Issues and Pull requests at write and Contents
  at read; main_judge: Contents and Issues at write and Pull requests at
  read). An App that lacks one is refused the token, and the minting step
  fails with a message that names what was asked for. report mints the same
  way, so nothing is posted on the pull request: the red job is the notice.
- **A token cannot be renewed without the key, so it lasts an hour.** The
  steps of a job that post must all run within an hour of the job's first
  steps. In judge and main_judge the verifier's model turns sit between the
  minting step and the posting steps, so a verifier that takes most of an
  hour leaves a verdict the job cannot post. The posting step then stops
  with a message that names the expiry, having sent nothing, and the report
  job, which mints a token of its own, says on the pull request that the
  verdict went unpublished. A larger `verify-batch-size` asks the model
  fewer times.
- **The run's own jobs are read with the run's own token.** report lists the
  jobs of the run to name the one that failed, with `actions: read` of the
  Actions token, so the App needs no Actions permission. Only when that
  token is refused is the identity asked instead.

`qare-action` run outside the pipeline still takes `QARE_APP_ID` and
`QARE_APP_PRIVATE_KEY` and mints the token itself, as the examples further
down do. A job of your own that would rather not hand it the key can run the
same script first and pass `QARE_APP_TOKEN` and `QARE_APP_SLUG` instead.

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
| `issues: write`, `pull-requests: read`, `contents: write` | main_judge, when the main lane is on: to file what a run on the default branch found, to read the changes a finding blames, and, with `main-lane-record-passes`, to push the record of passes to the `qa-assets` branch. |

These are the permissions of the run's own token. A GitHub App or a personal
access token carries its own (see "GitHub identity"), and the calling job
grants these all the same.

Granting less stops the run before any job starts, with an error that names
the job and the permission.

## What the pipeline trusts

Every action the pipeline uses is named by its full commit, with the version
beside it as a comment, so a tag that moves changes nothing a run executes;
a test holds every workflow file to that. pnpm is the one qare's
`package.json` names, by version and hash, enabled with corepack: no action
installs it. Each job uses a fresh corepack directory, carried to later
steps, so a previous job's cached pnpm cannot replace the hash-checked
download. This covers workflow installs; the container's pnpm bootstrap
currently installs by version and is tracked separately. No job restores a
dependency cache.

The examples in this guide name actions the same way. Name the actions of
your own jobs by commit too: a job that holds a secret runs whatever its
actions' tags point at on the day.

## What the runner needs

A GitHub-hosted runner has all of it. Your own runner needs `docker`, `git`,
`curl` and `jq`. It does not need the GitHub CLI, nor node, pnpm or Python set up by hand:
plan, execute and judge run qare and nare inside the published images
(`ghcr.io/vividynamics/qare-core` and the flavour the profile names), and
the jobs that run anything outside an image (collect, main_collect, report,
advisory, requeue, and the one step of judge and main_judge that mints the
App's token) set up node themselves with `actions/setup-node`.

A profile that boots its application (`app.boot`) also needs, on the runner
execute lands on, the docker compose v2 plugin, and the buildx plugin if the
compose file builds an image. The runner's user must be able to run
`docker compose` itself: execute hands the run exactly the docker that user
has. A runner with no compose plugin says so in the job summary.

The runner and its docker daemon must share the workspace and the runner's
temporary directory (`RUNNER_TEMP`), at the same paths. On a runner that is a
machine they do. On a runner that is a pod with the daemon in a sidecar, mount
the work directory into both containers. Nothing else has to be shared:
execute copies the docker client and its plugins under `RUNNER_TEMP` and
mounts them into the run's container from there, because a daemon that does
not see the runner's `/usr/bin` cannot mount the client from it.

## Self-hosted runner checklist

An operator of self-hosted runners verifies this checklist before allowing
repository code onto them. These are requirements of the infrastructure,
including the runner controller, its image and network, rather than settings
inside the application profile. GitHub-hosted runners need no extra setup.

| Item | Requirement and why | How to check it |
| --- | --- | --- |
| `ephemeral` | Each runner accepts one job and is then destroyed, so repository code cannot leave a process or file for a later job. | Inspect the controller's ephemeral or just-in-time registration and its destruction logs; submit two jobs and verify they get different runner instances and disks, with the first destroyed after its job. |
| `docker` | Each job has a Docker daemon and storage no other job shares, because Docker access can control every container on that daemon and reach its files. | Inspect the daemon endpoint, controller mounts and volumes; each job needs its own daemon and storage, never the node's Docker socket or a daemon shared with another runner, and its containers must disappear with the job. |
| `execute-pool` | The job that executes repository code runs in a pool of its own on a sandboxed runtime, so a breakout cannot reach machines used by jobs holding secrets. | Compare `execute-runs-on` with `runs-on` and runner group membership, then inspect the controller's runtime class or VM boundary and its enforcement; labels alone and a regular Docker container around a mounted daemon socket do not provide this boundary. |
| `network` | The execute pool can reach the internet and its own services and nothing internal, so repository code cannot reach a cluster API, another workload or cloud metadata. | Inspect egress firewall or network policies and routing, then test from an execute job that an internet destination and its own services work while the cluster API, other internal subnets, node services and metadata endpoints are denied. |
| `credentials` | No registry, cluster, cloud, model or GitHub credential is readable from the execute job's environment or mounts, because repository code inherits that machine's access. | Audit the runner's exported variable names, mounted volumes and HOME configuration; disable automatic service account token mounts and remove registry login files, kubeconfigs, cloud credentials and identity token files from the job, keeping image-pull credentials with the controller. |
| `image-digest` | The runner image is pulled by an immutable digest, so an image tag cannot silently change the machine that receives repository code. | Inspect the controller's runner image specification for `@sha256:<digest>` and compare it with the actual image identifier of the launched pod or VM; a mutable tag or a digest of only the qare flavour image does not verify the runner image. |

The checklist recommends both destruction after one job and a separate execute
pool. The placement gate's recorded allowance for an explicitly declared
ephemeral pool is an alternative admission rule; passing that gate does not
verify the runtime, daemon, credentials or network items above.

Run `qare doctor --json` inside a self-hosted job to see the observations it
can make. Each finding names its `checklist` item and a `status` of `finding`
or `unobservable`; ordinary text output uses those same words. The checks
look for known credential variable names and readable credential paths,
including Kubernetes service account tokens, Docker login configuration,
AWS credentials, kubeconfigs and cloud identity files. They also check the
cluster API address named by `KUBERNETES_SERVICE_HOST` and a remote Docker
endpoint with bounded, unauthenticated probes. Credential values and file
contents are never recorded. A remote daemon is a warning to verify
ownership, since it may be dedicated or shared.

Doctor says plainly that it cannot observe one-job destruction, exclusive
daemon ownership, pool membership, sandbox enforcement, the complete network
boundary, credentials outside its environment and known paths, or the runner
controller's image pull. Containerized doctor has only the container's view;
run it on the runner itself to inspect the runner's environment and mounts.
Its readiness result describes whether qare can run, and these warnings do
not certify that a runner is safe or change criterion verdicts.

The pipeline inspects self-hosted execute and main execute runners before
checkout and writes visible findings and these limitations straight to the
job summary. It forwards a snapshot containing only credential names, known
file labels and reachability observations into the run, where the same
findings appear under `environment.runnerSafety` in `evidence/result.json`
and in the evidence comment. This also exposes findings the run container
would otherwise hide, without forwarding the credentials themselves.

## Which checks each flavour runs

execute runs in the image the profile's `flavour` names, and a profile that
names none runs in `core`. The flavour decides which checks can run at all,
because only one of them ships a browser:

| Check | `core` (the default) | `web` |
| --- | --- | --- |
| `command` | yes | yes |
| `mail` | yes | yes |
| `flow` that names a suite | yes: the suite's command brings whatever it drives | yes |
| `flow` of actions (open, click, assertText, and the rest) | no: there is no browser to launch | yes |
| `visual` | no | yes |
| `a11y` | no | yes |

```yaml
# .qa/config.yml
flavour: web   # the checks need a browser
```

The plan step reads the flavour before it asks the model. For a profile whose
flavour ships no browser, the planner is told so and is offered only suites,
commands and mail: it is handed the profile's suites with the command each
one runs, so a criterion a suite already covers is planned as that suite. A
criterion that only a browser could show comes back unplannable, saying that
`flavour: web` is what changes it. A plan that still holds an action flow, a
visual check or an a11y check is corrected once and then refused at the plan
step, naming the flavour and the setting, rather than left to end unverified
when the browser fails to launch.

Two kinds of profile are not held to this, because their flows do not run on
the image's browser: one that names a `client` (see "Profiles that install a
build") plans against that client's driver, and one that maps an MCP driver
plans against the mapping. Each declares what it can do for itself.

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
- **Images are built before the health deadline starts.** A compose file
  that builds its images is built first, as its own step, bounded by
  `app.boot.build.timeout` (15m by default). `app.health.timeout` times only
  the boot, so a runner with no layer cache needs no separate
  `docker compose build` step in your workflow and no inflated health timeout:

  ```yaml
  app:
    boot: { compose: compose.qa.yaml, service: web, build: { timeout: 25m } }
    health: { http: "http://localhost:{{run.app_port}}/up", timeout: 120s }
  ```

  A build that fails or outlives its bound ends the run `blocked`, naming the
  build, with the build's output in `provision.log`.
- **A suite can run inside the booted service.** The run's compose project is
  `qare-<run id>`, so a suite that needs the stack's own hostnames (a
  database, a stub) names it:

  ```yaml
  suites:
    - name: sign-in
      command: "docker compose -p qare-{{run.id}} -f compose.qa.yaml exec -T web bundle exec cucumber features/sign_in.feature"
      kind: flow
  ```

- **The seed runs inside the booted service the same way.** The run executes
  `app.seed.command` once the app is healthy and before any check. It runs
  inside the run image, where your application's runtime is not, so a seed
  that needs the app's own code names the service:

  ```yaml
  app:
    seed: { command: "docker compose -p qare-{{run.id}} -f compose.qa.yaml exec -T web bin/rails db:seed:qa" }
  ```

  A seed that exits non-zero ends the run `blocked`, naming the command and
  its exit code, with `seed.log` in the evidence. `app.seed.timeout` bounds it
  (5m by default).

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
    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.10.46
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
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - run: make package && mkdir -p qare-artefacts && cp out/my-app.tar qare-artefacts/head.tar
      # The build of the base: whatever your pipeline already keeps for the
      # default branch, fetched here, or built here from the base commit.
      - run: make fetch-base-build && cp out/base/my-app.tar qare-artefacts/base.tar
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
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

On a self-hosted runner, execute and main_execute stop before any checkout
unless you choose one of these two options. This applies to private
repositories too; `self-hosted: allow` only supplies the independent public
repository opt-in. The refusal names `execute-runs-on` and
`ephemeral-runners`. GitHub-hosted runs are unchanged.

- **A dedicated execute pool.** Set `execute-runs-on` to labels different
  from `runs-on`. No other qare job, and no other workflow that holds
  secrets, may schedule onto that pool. Use disjoint pool labels on both
  sides, not a broad selector that also matches execute's runners:

  ```yaml
      runs-on: '["self-hosted", "qare-trusted"]'
      execute-runs-on: '["self-hosted", "qare-execute"]'
  ```

  On Kubernetes this is a separate runner scale set, with its own docker
  daemon and no volume shared with the trusted pool. A docker-in-docker
  sidecar per pod gives the daemon that lifetime; a mounted node docker
  socket does not. qare compares selectors as case-insensitive label sets,
  so whitespace, ordering, duplicate labels and single-label array syntax
  cannot disguise the same pool. Different labels are a declaration of
  isolation, not proof that infrastructure keeps the pools disjoint.

- **Fresh runners for every job.** Set `ephemeral-runners: 'true'` alongside
  `runs-on`. The declaration means one job per runner (`--ephemeral`, or
  ARC's one-job-per-runner-pod lifecycle), the machine or pod deleted after
  that job, and a docker daemon that lives and dies with it. No persistent
  volume, host path, shared build cache, or node docker socket may be
  mounted. The pod's service account must reach nothing in the cluster.

  ```yaml
      runs-on: '["self-hosted", "qare-ephemeral"]'
      ephemeral-runners: 'true'
  ```

  qare records `environment.host.ephemeralRunners: true` in `result.json`
  and names it as a caller declaration in posted evidence. It has not
  inspected whether the runner was fresh or destroyed afterwards. Only
  the exact string `true` declares this; empty or `false` still requires
  a separate execute pool.

A single pool of long-lived runners for all jobs now refuses execution.
Consumers must supply one of these inputs before upgrading. A pod that
mounts the node's docker socket or storage shared with trusted jobs meets
neither option, even when the runner process itself is ephemeral.

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
      ephemeral-runners: 'true'
```

The rule reads three facts: what GitHub Actions says the runner is
(`RUNNER_ENVIRONMENT`), the repository's visibility, and this input. A
private repository needs no public-repository opt-in, but self-hosted
execute still requires an isolated pool or the ephemeral declaration.

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

A run against your default branch has no pull request to comment on. With the
main lane on, the pipeline makes that run and `qare-action main-findings`
files what it found as issues instead: one per problem, commented on while it
still fails, closed when a run proves the criterion again. See "Findings on
main" in [SPEC.md](./SPEC.md) for what an issue says and whom it mentions.

The lane is off until you turn it on, and when you turn it on it is a dry
run: it reads, prints the issues it would open and whom it would mention, and
writes nothing. Start there:

```yaml
name: QARE
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '23 5 * * *'
  workflow_dispatch:
jobs:
  qare:
    permissions:
      actions: read
      checks: write
      contents: write
      issues: write
      pull-requests: write
    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.10.46
    with:
      nare-model: gpt-4.1-mini
      main-lane: 'true'
    secrets:
      model-key: ${{ secrets.OPENAI_API_KEY }}
```

The triggers are yours: a `push` to the default branch checks every merge, a
`schedule` checks at a fixed hour whatever merged, and `workflow_dispatch`
lets you start one by hand. Any of the three starts the lane, and only for
the default branch: a pull request, a comment, a tag or another branch starts
none of it. A push trigger with no `paths` filter also runs requeue (see
"Triggers"), which is harmless without stubs. If your workflow has a
`concurrency` group that cancels in progress, a second merge cancels the run
of the first; the newer revision is the one worth checking.

### What the lane does

| Job | Holds | What it does |
| --- | --- | --- |
| main_collect | the GitHub token | Reads the ledger at the revision and writes the plan from the checks the ledger records. No model is asked. |
| main_execute | nothing | Boots the app and runs the plan, as execute does. It is the only job that runs your repository's code. |
| main_judge | the model key, then the identity, in separate steps | The verifier reads the evidence, told that no change is under review. Then `main-findings` files, or on a dry run prints. |

There is no planning step and no model plans on main. The ledger already
says which suite proves each criterion, so the plan is read out of it by
`qare ledger plan`, and what ran on Tuesday is what runs on Wednesday.

A failed verdict leaves main_execute red, as it does on a pull request, and
main_judge still reports it. What a dry run would have filed is in
main_judge's job summary and in `main-findings.txt` in the
`main-judge-artifacts` artifact: for each issue it would open, the title, the
labels and the body, mentions and all. It opens with what the run amounted
to (the verdict, and how many criteria were proven, failed and left
unverified) and names each unverified criterion with its reason, so "nothing
to file" never reads as "everything passed".

### What your ledger must hold

The lane runs what the ledger records and nothing else. For it to have
something to run:

- `<profile>/ledger.json` exists on the default branch (`.qa/ledger.json`
  with the default profile). It is the ledger's own file, with its integrity
  digest and its history: write it with `qare ingest` and `qare-action
  ingest-deliver`, which open a pull request, or with `qare ledger import`
  from a draft, never by hand. A ledger that fails its integrity check stops
  the lane red.
- At least one entry has `status` `active`. `proposed` entries are not run:
  nothing has proven them, so a failure of one is not a finding on main.
- Each of those entries has a `checks` reference of the form `suite:<name>`,
  naming a suite in the profile's `suites`. That suite's command is what
  runs. An entry whose checks name no suite is reported unverified with that
  reason, and files nothing.
- Each entry has a `text`: it is what the verifier is asked about and what
  an issue quotes.

A ledger with no `active` entry, or no ledger, is not an error: main_collect
says there is nothing to run and the other two jobs skip.

The lane never writes the ledger. For an issue to say when a criterion last
passed and blame the changes since, a pass has to be recorded somewhere: see
"Regressions" below. Without a recorded pass a failure is filed as
`qa-failure`, for the profile's fallback, and never called a regression.

### Regressions: recording what a run proved

Pass `main-lane-record-passes: 'true'` and each run of the lane records what
it proved. From then on a failure of a criterion that has a recorded pass is
a `qa-regression` issue: it names the run, the revision and the time the
criterion last passed, lists the commits and pull requests since, and
mentions their authors.

```yaml
    with:
      main-lane: 'true'
      main-lane-dry-run: 'false'
      main-lane-record-passes: 'true'
```

What is recorded, where, and by what:

- **Where.** One file, `passes/main.json`, on the orphan `qa-assets` branch,
  beside the screenshots and the run metrics. A repository with several
  profiles has one record for each, so one profile's run never drops
  another's passes: a profile other than `.qa` keeps its own at
  `passes/profiles/<its directory>/main.json`. Each run that proves something
  adds one commit carrying the whole record, so the branch's history is the
  record's history. The ledger and your default branch are never written,
  and nothing lands as a commit your build would react to: filter your
  `push` triggers to your default branch, as "Triggers" says.
- **What.** For each `active` criterion the judged result proved: the
  revision, when it was committed, the run, and a digest of the ledger entry
  that was proven. A criterion that failed keeps the pass it had, which is
  the revision the changes are counted from: the commits your default
  branch has that the passing revision does not, as the history has them,
  whatever their dates. Runs do not always finish in the order their
  revisions landed, so both sides ask the history. A run leaves untouched
  every recorded pass of a revision that is ahead of its own (it neither
  replaces nor drops it, and says so), and a failure is a regression only
  against a pass of an earlier revision. A pass recorded for a later
  revision, for the very revision that now fails (the same revision run
  again: nothing landed in between to blame), or for one rewritten out of
  the branch, is no last pass for that run; the next run that proves the criterion replaces a pass of a
  rewritten revision. A pass of a criterion the ledger no longer carries is
  dropped by the next run that is not behind it. The order a criterion's
  checks are listed in is no part of its wording. The issue also says when
  the pass was recorded. If a criterion's text, proof or
  checks change in the ledger, its pass no longer stands until a run proves
  the new wording.
- **By what.** main_judge's filing step, after everything is filed. It holds
  the identity, runs nothing from your repository, and decides a pass in
  code from the judged result and the ledger. main_execute holds no token
  and cannot write it. The verifier can only take a pass away. A pull
  request cannot reach it: the lane does not run on one.
- **On a dry run** nothing is recorded. The dry run says which criteria it
  would record a pass for, and which it would leave because a later
  revision already holds their pass: it asks the history what a real run
  would, and like a real run it stops when GitHub cannot say when the
  checked revision was committed.
- **Permissions.** main_judge declares `contents: write` for this one push.
  The calling job already grants it in the ceiling above, so a caller adds
  nothing. A caller that had narrowed its ceiling to `contents: read` must
  grant `contents: write` again, or no run of the workflow starts.
- **If the record cannot be read** the filing step stops by name before it
  files or writes anything. Restore the file from the branch's history, or
  remove it to start the record again. The same holds when no record is
  found and the identity qare posts as cannot read the revision the run
  checked: GitHub answers alike for a file that is not there and for
  contents an identity may not read, so "no record" is believed only from an
  identity that can read the repository. An App or a token you pass needs
  read access to Contents (see "GitHub identity").

The record is as trustworthy as the `qa-assets` branch: whoever can push to
it can write a pass. A false pass cannot make a criterion pass or close an
issue; it can make a failure read as a regression and name the authors of
the changes since. Protect the branch if that matters to you.

The first failure after you turn this on is a regression only if a run
recorded a pass before it. Turn it on while the lane is green.

### Filing for real

When you have read a dry run:

1. Name who hears of a finding nobody can be blamed for, in the profile:

   ```yaml
   findings:
     fallback:                 # people and teams, in any mix; each is mentioned
       - acme/qa-leads
       - acme/platform
     bots: [release-robot]     # an orchestrator that opens pull requests with a person's token
   ```

   One name alone still loads, as a list of one (`fallback: acme/qa-leads`).
   Each entry is a GitHub login or `org/team`, with or without the at sign. A
   profile is refused, naming the entry, for an entry that is neither, an
   empty list, the same handle twice, or more than ten names. A dry run
   prints every name it would mention.

2. Pass `main-lane-dry-run: 'false'`. Only that exact word files; anything
   else is a dry run.

3. Pass `main-lane-record-passes: 'true'` if a failure should be traced to
   the change that caused it: see "Regressions" above.

The labels `qa-regression`, `qa-environment` and `qa-failure` are created by
GitHub the first time an issue carries one.

### Not in the lane yet

- Screenshots: an issue links the run's evidence artifact, and nothing is
  pushed to `qa-assets`.
- A client profile's `artefacts`: the lane downloads no build.
- Run metrics: a run on main records none.
- The advisory UX review: its findings ride a pull request's comment, and a
  run on main has none, so main_judge does not ask for it (`qare judge
  --no-advisory`) and spends no model turn on it.

### The command itself

The lane calls `qare-action main-findings` for you. To call it from a job of
your own that already has a judged result of a run on your default branch:

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
| `--dry-run true` | Reads, writes nothing, and prints what a real run would open, comment on, reopen or close, and whom it would mention, with the title, the labels and the body of each issue it would open. Run it first. |
| `--record-passes true` | Records what the run proved, in `passes/main.json` on the `qa-assets` branch, after filing: see "Regressions" above. Only the exact word records, and a dry run only says what it would record. |
| `--branch` | The branch the record of passes is read from and written to, and screenshots are pushed to. `qa-assets` when left out. |
| `--passes-profile` | The profile directory whose record of passes this is, for a repository with several profiles. Left out, or `.qa`, it is `passes/main.json`; any other is `passes/profiles/<directory>/main.json`. |

The command reads the record of passes on every run, whether or not it
records, because that record is what makes a failure a regression. So the
identity it runs as must be able to read the repository's contents: when no
record is found and the identity cannot read the checked revision either,
the command stops rather than file a regression as a plain failure.

The job needs `issues: write` to file, `pull-requests: read` and `contents:
read` to read the record and the range, and `contents: write` only when
`--record-passes` writes the record or `--evidence` pushes screenshots. It
is a judge-side step: give it the identity and nothing that
runs repository code (rule 7).

## Fleet report

With qare in several repositories, `qare-action fleet-report` puts them on one
page (#151). It reads what each repository already publishes, through
GitHub's API, and publishes in the repository it runs in. There is no server
and no state of its own.

What it reads from each listed repository, and writes nothing there:

| Read | From | Becomes |
| --- | --- | --- |
| The ledger | `<ledger>/ledger.json` on the branch the config names, with `<ledger>/sweep.json` for the repository's own stale thresholds | ledger size, how many criteria the ledger records as verified and current (coverage), which are stale, how many were never verified |
| Run records | `metrics/**.json` on the `qa-assets` branch (#51) | the latest runs, newest first: verdict, pull request, how the criteria came out |
| Issues qare filed | open issues labelled `qa-regression`, `qa-environment`, `qa-failure` (#154), read from the issue listing so one filed a moment ago is there | open regressions and the rest, by number and title |

The repositories are listed in a JSON file:

```json
{
  "repositories": ["acme/web", { "repository": "acme/api", "branch": "trunk", "ledger": "qa" }],
  "runs": 5
}
```

`branch` defaults to `main`, `ledger` to `.qa`, and `runs` (how many of each
repository's latest runs the page shows) to 5. Unknown keys are refused: a
misspelt key would leave a repository out without a word.

Nothing in the pipeline calls it. It is a workflow you add, on a schedule, in
the one repository where the team should look:

```yaml
name: QARE fleet
on:
  workflow_dispatch:
  schedule:
    - cron: '41 5 * * *'
permissions:
  contents: write   # the page, committed to the qa-assets branch
  issues: write     # the summary issue
# One report at a time: two at the same instant could each open a summary issue.
concurrency:
  group: qare-fleet
  cancel-in-progress: false
jobs:
  fleet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      # qare at a release, beside the checkout whose .qa/fleet.json it reads.
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          repository: ViviDynamics/qare
          ref: 2026.10.47
          path: qare
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version-file: qare/.nvmrc
      # corepack reads the pnpm qare's package.json names, by version and hash.
      - name: Enable and build the pinned qare
        working-directory: qare
        shell: bash
        run: |
          set -euo pipefail
          export COREPACK_HOME="$(mktemp -d "$RUNNER_TEMP/qare-corepack.XXXXXX")"
          corepack enable
          wanted="$(jq -r '.packageManager // empty' package.json)"
          wanted="${wanted%%+*}"
          found="pnpm@$(pnpm --version)"
          if [ "$found" != "$wanted" ]; then
            echo "::error::corepack resolved $found, expected $wanted"
            exit 1
          fi
          pnpm install --frozen-lockfile
          pnpm build
      - name: Report on the fleet
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          QARE_APP_ID: ${{ secrets.QARE_APP_ID }}
          QARE_APP_PRIVATE_KEY: ${{ secrets.QARE_APP_PRIVATE_KEY }}
          QARE_GITHUB_TOKEN: ${{ secrets.QARE_GITHUB_TOKEN }}
        run: |
          node qare/packages/action/dist/index.js fleet-report \
            --config .qa/fleet.json --repository "${{ github.repository }}"
```

| Flag | What it is |
| --- | --- |
| `--config` | The JSON file that lists the repositories. Required. |
| `--repository` | The repository the report is published in. Defaults to `GITHUB_REPOSITORY`. |
| `--branch`, `--path` | Where the page is committed: `qa-assets` and `fleet/report.md` unless named. |
| `--out` | Also write the page to this file. |
| `--dry-run true` | Reads, publishes nothing, and prints what a real run would. Run it first. |

**The identity decides what can be read.** The Actions token of a workflow
reads its own repository and no other private one, so a fleet of private
repositories needs the qare GitHub App installed on each (#61, #155) or a
personal access token in `QARE_GITHUB_TOKEN` that can read them: `contents:
read` and `issues: read` on every listed repository, and `contents: write`
and `issues: write` on the one it publishes in.

**What it cannot see, it says.** A part of a repository that could not be
read is reported as unread, with the reason, and counts as needing
attention. It is never shown as healthy. That covers a repository the
identity cannot see (GitHub answers "not found" for one, exactly as for a
file that is not there, so the report asks whether it can see the repository
before it reads anything), a ledger branch that does not exist, a ledger that
does not parse, a run record among the newest that is not one (it may be the
latest run, so no older run stands in for it), a listing GitHub cut short,
and a day with more run records than the report reads.

**Coverage is the ledger's record, not the last run's word.** The report
reads the ledger and nothing of a repository's last held result, so it does
not know which criteria are quarantined or refused right now and reports
neither. A criterion the ledger records as verified counts as such even when
its last run refused it; the repository's own standing report (#49) shows
those.

Two things are published:

- The page, `fleet/report.md` on the `qa-assets` branch: one table of every
  repository, then each one's ledger, latest runs and open issues. It is
  rewritten on every run.
- One summary issue, labelled `qa-fleet` and found again by that label and a
  hidden marker (in the issue listing, not the search, whose index lags a new
  issue by minutes; an identity that may not apply labels has the label
  dropped by GitHub, and the issue is then found by its marker through the
  search instead), listing only what needs attention: a part that could not be read, an open regression, environment
  or failure issue, a stale criterion, a latest run that did not pass. It is
  rewritten only when that list changes, so whoever watches it hears from it
  only then.

Everything the report quotes from another repository (a title, a reason, a
criterion id, an issue number) is written as code, so it renders no link,
mentions nobody, and leaves no reference on the other repository's issues.

Not in the report yet: why a run was blocked or refused (the run record
carries the verdict and the counts, not the reasons), advisory findings
awaiting a look (#150), and finding the repositories by where the App is
installed instead of listing them.

## Triggers

The triggers are yours. `pull_request` runs the pipeline. A `push` to your
default branch, filtered to the profile's path, runs requeue alone: it posts
`/qa` on pull requests that were refused for want of a stub the push just
merged. Leave the push trigger out if you do not use stubs. Filter pushes to
the default branch, so the `qa-assets` pushes judge makes do not start a run.
An `issue_comment` trigger runs the advisory job alone, on a reply to an
advisory finding: see "Advisory UX review".

A `push` to your default branch, a `schedule` or a `workflow_dispatch` also
runs the main lane when `main-lane` is `true`: see "Findings on main".

Call the pipeline once per workflow run. Its artifacts have fixed names, so
two calls in one run would overwrite each other.

## Upgrading

Change the tag in `uses:`. That one line moves the pipeline, the qare the
token-only jobs build, and the images plan, execute and judge pull, to the
same release, because each release's `pipeline.yml` pins that release.

Pin a release tag, never `main` and never a commit: `main` carries a
pipeline that is ahead of the qare its pin names.

Not every release tag can pin itself. qare tags every green merge to its
default branch, and when a merge did not bump the version the tag is
computed: its `pipeline.yml` still names the last stamped release as the
default of `qare-ref`. The release notes of a stamped release match the
version in its `package.json`; a computed one's do not. To run a computed
release, name it twice: pin it in `uses:`, and pass the same tag as the
`qare-ref` input.

With `qare-ref` a release tag, the pipeline builds that release's source and
pulls the images published under that tag. Left out on a computed release,
the pipeline runs the stamped release before it.
