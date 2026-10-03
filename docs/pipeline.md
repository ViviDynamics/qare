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
    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.10.3
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
concurrency:
  group: qare-${{ github.ref }}
  cancel-in-progress: true
jobs:
  qare:
    permissions:
      actions: read
      checks: write
      contents: write
      issues: write
      pull-requests: write
    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.10.3
    with:
      runs-on: '["self-hosted", "linux", "x64"]'
      profile: services/web/qa
      nare-base-url: https://llm.example.com/v1
      nare-model: claude-haiku
    secrets:
      model-key: ${{ secrets.QARE_MODEL_KEY }}
```

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
| `planner-diff-exclude` | empty | Space-separated git pathspecs left out of the planner's copy of the diff, for a diff too large to plan from whole. execute and judge still read the full diff. |
| `qare-ref` | the release | The qare revision the pipeline runs. It defaults to the release the workflow file ships in. Leave it alone and pin the release in `uses:`. |

## The secret

One secret, passed by name:

| Secret | What it is |
| --- | --- |
| `model-key` | The key for the model service. The caller names which of its own secrets holds it: `model-key: ${{ secrets.YOUR_SECRET }}`. |

Pass it by name, as above, and never with `secrets: inherit`: the pipeline
should be handed the one secret it uses, not every secret the repository
holds. Only two steps ever see the key, the planner in plan and the verifier
in judge, and neither holds a GitHub token. execute, the job that runs the
pull request's code, holds no secret at all. That map is at the top of
`pipeline.yml` and a test holds the file to it.

A pull request from a fork has no secrets, so plan skips and collect says
why. A repository that never set the secret gets a failed plan step that
names `model-key`, not a pass.

## Permissions

A called workflow can hold no permission its calling job does not grant, so
the calling job grants the ceiling and each pipeline job declares only what
it needs under it:

| Permission | Which job uses it |
| --- | --- |
| `contents: write` | judge, to push the run's screenshots to the `qa-assets` branch. Every other job reads. |
| `checks: write` | judge and report, for the check run on the head commit. |
| `pull-requests: write`, `issues: write` | judge, report and requeue, for the comment and the stub issues. collect reads issues. |
| `actions: read` | report, to name the job and step that failed when no verdict was published. |

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

## Triggers

The triggers are yours. `pull_request` runs the pipeline. A `push` to your
default branch, filtered to the profile's path, runs requeue alone: it posts
`/qa` on pull requests that were refused for want of a stub the push just
merged. Leave the push trigger out if you do not use stubs. Filter pushes to
the default branch, so the `qa-assets` pushes judge makes do not start a run.

Call the pipeline once per workflow run. Its artifacts have fixed names, so
two calls in one run would overwrite each other.

## Upgrading

Change the tag in `uses:`. That one line moves the pipeline, the qare the
token-only jobs build, and the images plan, execute and judge pull, to the
same release, because each release's `pipeline.yml` pins that release.

Pin a release tag, never `main` and never a commit: `main` carries a
pipeline that is ahead of the qare its pin names.
