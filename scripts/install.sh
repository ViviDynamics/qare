#!/bin/sh
# The release job stamps this file and publishes it as install.sh.
set -eu
release='2026.10.53'
image="ghcr.io/vividynamics/qare-web:$release"

if ! command -v docker >/dev/null 2>&1; then
  echo 'Install Docker, start it, and run setup again.' >&2
  exit 1
fi
if ! docker info >/dev/null; then
  echo 'Start the Docker daemon or select a working Docker context, then run setup again.' >&2
  exit 1
fi
if ! root=$(git rev-parse --show-toplevel); then
  echo 'Run setup from the Git checkout of the app you want to check.' >&2
  exit 1
fi
cd "$root"
qare() {
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" "$image" qare "$@"
}

printf 'Setting up QAre %s in %s\n' "$release" "$root"
qare init "$@"
qare readiness
cat <<'NEXT'

Review the app-specific decisions in the readiness report and fill in the profile.
For the generated caller, set the model key privately with gh secret set OPENAI_API_KEY.
If you maintain a custom caller, check the repository secret it maps to model-key.
Commit the profile and workflow, then open a PR whose body says Closes #<issue>
for an issue with acceptance criteria. QAre posts its evidence comment on that PR.
NEXT
