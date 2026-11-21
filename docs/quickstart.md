# Quickstart

From a web app that boots with docker compose to qare's first evidence comment
on a pull request. You need docker and the GitHub CLI, and a model key.

## 1. Run the CLI

The CLI ships inside every release's images, so there is nothing to install.
Pick the newest release from [the releases page](https://github.com/ViviDynamics/qare/releases)
and run it from the root of your repository:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/vividynamics/qare-web:<release> qare --version
```

The commands below keep the image in a variable to stay short:
`QARE=ghcr.io/vividynamics/qare-web:<release>`. The image's working directory
is `/work`, so every `qare` command reads and writes the repository you
mounted there. `--user` keeps the files it writes
owned by you. `qare` is on the image's `PATH`; the image contract is in
[images.md](images.md).

## 2. Write the profile and the workflow

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" "$QARE" qare init
```

`qare init` finds the compose file and the service that serves HTTP (or,
with no compose file, the package.json start script, which it boots by
command in an image you confirm), and writes:

- `.qa/config.yml`, the profile: how the app boots, its health URL on the
  port each run allocates (`{{run.app_port}}`), the seed command, and any test
  suites it recognised, run inside the service with `docker compose exec`;
- `.qa/QA.md`, what the app is and what matters, in your words;
- `.github/workflows/qare.yml`, the caller workflow, pinned to the release you
  ran, with a concurrency group so a newer push cancels the older run.

Pass `--service <name>` when the compose file has more than one candidate,
`--health <path>` for a health path other than `/`, and `--model <name>` for a
model other than the default `gpt-4.1-mini`.

It ends with a list of what only you know, and the last line is the command
for the model key the workflow reads:

```sh
gh secret set OPENAI_API_KEY
```

Fill in each `TODO(qare init)` line, then ask what is still open:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" "$QARE" qare readiness
```

The model is reached through [nare](https://github.com/ViviDynamics/nare).
The default is an OpenAI model; any service that speaks Chat Completions works
with `nare-base-url`, and Anthropic's API with `nare-provider: anthropic` and
`model-key-env: ANTHROPIC_API_KEY`. See [Inputs](pipeline.md#inputs).

## 3. Open a pull request against an issue with criteria

qare checks the acceptance criteria of the issue a pull request closes. Write
the issue with a heading and one behavior per bullet:

```markdown
## Acceptance criteria

- [ ] The sign-in page shows "Wrong password" after a wrong password is submitted
```

Commit `.qa/` and the workflow, then open a pull request whose body says
`Closes #<issue>`. The pipeline boots the app at the base and at the head,
plans a check per criterion, runs it with no secrets on the machine, and
judges the results in code.

## 4. Read the evidence comment

The run posts one comment on the pull request and a check run. The comment
counts the criteria proven, failed and unverified, gives the model tokens the
plan and the judge spent, and lists each criterion's text beside its outcome,
the reason, and links to its evidence. A pull request that closes no issue,
or an issue with no criteria, has nothing to check and stays green.

## Next

- [writing-criteria.md](writing-criteria.md): wording criteria a check can carry.
- [pipeline.md](pipeline.md): every input and secret, the GitHub identity qare
  posts as, your own runners, stubs, and upgrading.
