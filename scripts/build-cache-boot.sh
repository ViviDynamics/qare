#!/usr/bin/env bash
# Run the pipeline's own steps for the opt-in build cache (#381) against
# examples/compose-app, for real: the main lane's run writes the cache, and a
# pull request's run reads it and writes none. The steps are the ones
# .github/workflows/pipeline.yml ships, run as the scripts they are, as
# scripts/compose-boot.sh runs execute's.
#
#   scripts/build-cache-boot.sh <image>
#
# <image> is the qare image the run executes in. CI passes the core image it
# built from this tree. actions/cache is not run here: between the two runs
# this script moves the directory main_execute saves to where execute
# restores it, which is what the save and the restore do between two runs.
set -euo pipefail

image="${1:?usage: scripts/build-cache-boot.sh <image>}"
example=examples/compose-app
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-$RUNNER_TEMP/build-cache-summary.md}"
export RUNNER_TEMP GITHUB_STEP_SUMMARY
export GITHUB_RUN_ID="${GITHUB_RUN_ID:-0}" GITHUB_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
mkdir -p "$RUNNER_TEMP"
cache="$RUNNER_TEMP/qare-build-cache"
written="$RUNNER_TEMP/qare-build-cache-new"
rm -rf "$cache" "$written" evidence

cleanup() {
  rm -f plan.json
  git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
  GITHUB_JOB=main_execute step main_execute "Remove the build cache's builder" > /dev/null 2>&1 || true
}
trap cleanup EXIT

step() {
  node scripts/run-pipeline-step.mjs "$1" "$2"
}

passed() {
  jq -e '.verdict == "passed" and ([.criteria[] | .outcome == "proven"] | all)' evidence/result.json > /dev/null
}

# The main lane's run: the builder, then the run, which exports the layers
# of every service that builds.
export GITHUB_JOB=main_execute
step main_execute "Find the runner's docker"
step main_execute "Make the build cache's builder"
if [ ! -f "$RUNNER_TEMP/qare-buildx-builder" ]; then
  echo "the builder step made no builder, so the cache was never exercised" >&2
  exit 1
fi
cp "$example/plan.json" plan.json
code=0
IMAGE_REF="$image" IMAGE_TAG_REF="$image" IMAGE_DIGEST="${image}@local" \
HEAD_SHA="$(git rev-parse HEAD)" RUN_ID=0 RUN_ATTEMPT=1 PROFILE="$example/.qa" \
FLAKE_ATTEMPTS=1 QUARANTINE= BUILD_CACHE=true \
  step main_execute 'Run the plan on main' || code=$?
IMAGE_REF="$image" step main_execute 'Tear down what the run booted'
if [ "$code" -ne 0 ] || ! passed; then
  echo "the main lane's run with the build cache exited $code and did not pass" >&2
  [ -f evidence/result.json ] && jq '{verdict, criteria: [.criteria[] | {id, outcome, reason}]}' evidence/result.json >&2
  exit 1
fi
if [ ! -f "$written/web/index.json" ]; then
  echo "the main lane's run passed but wrote no cache for the web service in $written" >&2
  ls -R "$written" >&2 || true
  exit 1
fi
echo "build cache: the main lane's run wrote the web service's layers ($(du -sh "$written/web" | cut -f1))"

# What the save and the next restore do: the written cache becomes the one
# restored. The builder's own cache and the built image are cleared, so the
# next build has only the restored cache to go on.
mv "$written" "$cache"
BUILDX_CONFIG="$RUNNER_TEMP/qare-buildx" docker buildx prune --builder "$(cat "$RUNNER_TEMP/qare-buildx-builder")" --all --force > /dev/null
rm -rf evidence

# A pull request's run: it reads the cache and writes none.
export GITHUB_JOB=execute
code=0
cp "$example/plan.json" plan.json
IMAGE_REF="$image" IMAGE_TAG_REF="$image" IMAGE_DIGEST="${image}@local" \
BASE_SHA="$(git rev-parse 'HEAD^1')" HEAD_SHA="$(git rev-parse HEAD)" PR_NUMBER=0 PROFILE="$example/.qa" \
FLAKE_ATTEMPTS=1 QUARANTINE= BUILD_CACHE=true \
  step execute 'Run the plan' || code=$?
IMAGE_REF="$image" step execute 'Tear down what the run booted'
if [ "$code" -ne 0 ] || ! passed; then
  echo "the pull request's run with the build cache exited $code and did not pass" >&2
  [ -f evidence/result.json ] && jq '{verdict, criteria: [.criteria[] | {id, outcome, reason}]}' evidence/result.json >&2
  exit 1
fi
if [ -d "$written" ] && [ -n "$(ls -A "$written")" ]; then
  echo "the pull request's run wrote a cache to $written: only the main lane may write one" >&2
  exit 1
fi
echo "build cache: the pull request's run read the cache, passed, and wrote none"
