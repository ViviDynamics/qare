# Quickstart

From your app's Git checkout to the first evidence comment on a pull request.
You need Docker running locally. Set the model key privately in GitHub before
the first PR run; local setup works without credentials.

## 1. Set up the checkout

```sh
bootstrap=$(curl -fsSL https://github.com/ViviDynamics/qare/releases/latest/download/install.sh) && sh -c "$bootstrap" qare-install
```

The download selects one release. Its installer runs `qare init` and then
`qare readiness` using that release's Docker image. Init detects a Compose
service or a package.json start script and writes the following files:

- `.qa/config.yml` with the boot settings, health check, seed and recognised suites.
- `.qa/QA.md` for what the app does and what matters to QA.
- `.github/workflows/qare.yml` pinned to the concrete release in the image.

Repeat setup to see what still needs attention. Init keeps existing profiles
and caller workflows. Append `--service <name>` to the setup command to select
a Compose service, `--health <path>` to specify its health path, or
`--target <url>` to check an already running app when there is no boot recipe.

**Setup prompt for a coding agent**

> In my app checkout, download https://github.com/ViviDynamics/qare/releases/latest/download/install.sh
> and run the downloaded file with `sh` and standard input closed (`</dev/null`).
> Keep existing QA files, summarize any app-specific decisions from readiness,
> and tell me how to set the model key privately and get the first PR evidence comment.

**Direct Docker setup**

From the checkout root, this pulls the current image and starts the same init:

```sh
docker run --pull=always --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/vividynamics/qare-web:latest qare init
```

To reproduce a run, use the tag after `pipeline.yml@` in its generated workflow
in place of `latest`, for example `ghcr.io/vividynamics/qare-web:2026.11.33`.
Run that same image with `qare readiness` to review open items. To repeat a
specific bootstrap, use `releases/download/<tag>/install.sh` in the setup URL.

## 2. Finish the profile and set the model key

Fill in each `TODO(qare init)` from the readiness report, including the QA
account, health path or seed command where needed. The generated workflow
defaults to `gpt-4.1-mini`. Set its repository secret privately at the prompt:

```sh
gh secret set OPENAI_API_KEY
```

Pass `--model <name>` to setup to select another model. The model is reached
through [nare](https://github.com/ViviDynamics/nare). Chat Completions services
use `nare-base-url`, and Anthropic's API uses `nare-provider: anthropic` and
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
