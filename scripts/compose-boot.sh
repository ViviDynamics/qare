#!/usr/bin/env bash
# Run the pipeline's execute steps against the example profile that boots a
# compose app (examples/compose-app), and hold the result to a real boot
# (#209). The steps are the ones .github/workflows/pipeline.yml ships, run as
# the scripts they are: a caller's pipeline and this check cannot drift apart.
#
#   scripts/compose-boot.sh <image>
#
# <image> is the qare image the run executes in. CI passes the core image it
# built from this tree. The base side is the commit before HEAD, which the
# checkout must carry (fetch-depth: 2 in a workflow).
set -euo pipefail

image="${1:?usage: scripts/compose-boot.sh <image>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-$RUNNER_TEMP/compose-boot-summary.md}"
export RUNNER_TEMP GITHUB_STEP_SUMMARY
mkdir -p "$RUNNER_TEMP"

rm -rf evidence
cp examples/compose-app/plan.json plan.json
# A base worktree an earlier run left behind would refuse the new one.
git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
cleanup() {
  rm -f plan.json
  git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
}
trap cleanup EXIT

step() {
  node scripts/run-pipeline-step.mjs execute "$1"
}

step "Find the runner's docker"
code=0
IMAGE_REF="$image" \
IMAGE_DIGEST="${image}@local" \
BASE_SHA="$(git rev-parse 'HEAD^1')" \
HEAD_SHA="$(git rev-parse HEAD)" \
PR_NUMBER=0 \
PROFILE=examples/compose-app/.qa \
  step 'Run the plan' || code=$?

if [ ! -f evidence/result.json ]; then
  echo "the execute step exited $code and recorded no evidence/result.json" >&2
  exit 1
fi
project="$(find evidence -name isolation.json -exec jq -r '.project // empty' {} + | sort -u)"
running() {
  docker ps -q --filter "label=com.docker.compose.project=$project"
}
# The head's stack outlives the run: taking it down is the pipeline's step.
up_after_run="$(running)"
IMAGE_REF="$image" step 'Tear down what the run booted'

jq '{verdict, base: .base.status, criteria: [.criteria[] | {id, outcome, reason}]}' evidence/result.json
# Passed, with every criterion proven by a check that really ran: a blocked
# boot leaves them unverified, and that is the failure this exists to catch.
if [ "$code" -ne 0 ] || ! jq -e '
  .verdict == "passed" and
  (.criteria | length) == 2 and
  ([.criteria[] | .outcome == "proven"] | all)
' evidence/result.json > /dev/null; then
  echo "the execute step exited $code: the compose app did not boot, or a check against it did not pass" >&2
  exit 1
fi
if [ -z "$project" ] || [ -z "$up_after_run" ]; then
  echo "the run named no compose project that was up when it finished, so the teardown step had nothing to prove" >&2
  exit 1
fi
left="$(running)"
if [ -n "$left" ]; then
  echo "the teardown step left the run's compose project $project running: $left" >&2
  exit 1
fi
echo "compose boot: the execute step booted the app, both checks reached it, and the teardown step took the stack down"
