#!/usr/bin/env bash
# Run the pipeline's execute steps against examples/egress-app (#382), and
# hold the result to a contained stack: the app reached its declared stub
# by the vendor's own host name, could not reach a vendor no stub declares
# nor a literal address, and the run was refused with that vendor listed in
# the result and in the comment. The steps are the ones
# .github/workflows/pipeline.yml ships, run as the scripts they are.
#
#   scripts/egress-boot.sh <image>
#
# <image> is the qare image the run executes in. CI passes the core image it
# built from this tree. The base side is the commit before HEAD, which the
# checkout must carry (fetch-depth: 2 in a workflow).
set -euo pipefail

image="${1:?usage: scripts/egress-boot.sh <image>}"
example=examples/egress-app
undeclared=api.undeclared-vendor.example
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-$RUNNER_TEMP/egress-boot-summary.md}"
export RUNNER_TEMP GITHUB_STEP_SUMMARY
mkdir -p "$RUNNER_TEMP"

rm -rf evidence
cp "$example/plan.json" plan.json
criteria="$(jq '.criteria | length' "$example/plan.json")"
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
IMAGE_TAG_REF="$image" \
IMAGE_DIGEST="${image}@local" \
BASE_SHA="$(git rev-parse 'HEAD^1')" \
HEAD_SHA="$(git rev-parse HEAD)" \
PR_NUMBER=0 \
PROFILE="$example/.qa" \
FLAKE_ATTEMPTS=1 \
QUARANTINE= \
BUILD_CACHE= \
  step 'Run the plan' || code=$?

project=""
if [ -d evidence ]; then
  project="$(find evidence -name 'isolation*.json' -exec jq -r '.project // empty' {} + | sort -u | tr '\n' ' ')"
fi
running() {
  local name
  for name in $project; do
    docker ps -q --filter "label=com.docker.compose.project=$name"
  done
}
networks() {
  local name
  for name in $project; do
    docker network ls -q --filter "label=com.docker.compose.project=$name"
  done
}
up_after_run="$(running)"
IMAGE_REF="$image" step 'Tear down what the run booted'

if [ ! -f evidence/result.json ]; then
  echo "the execute step exited $code and recorded no evidence/result.json" >&2
  exit 1
fi
jq '{verdict, egress, base: .base.status, criteria: [.criteria[] | {id, outcome, reason}]}' evidence/result.json

# Every check ran and passed: the stub answered by the vendor's host name,
# and the undeclared vendor and the literal address were out of reach. The
# run is refused for the vendor no stub declares, which the record names,
# and no other name: the stub's host is recorded as declared.
if [ "$code" -ne 0 ] || ! jq -e --argjson criteria "$criteria" --arg host "$undeclared" '
  .verdict == "refused" and
  (.criteria | length) == $criteria and
  ([.criteria[] | .outcome == "proven"] | all) and
  .egress.containment == "contained" and
  .egress.undeclared == [$host] and
  (.egress.declared | index("api.billing-vendor.example")) != null
' evidence/result.json > /dev/null; then
  echo "the execute step exited $code: the $example stack was not contained, or the run did not refuse on $undeclared alone" >&2
  exit 1
fi

# The comment lists the host as the missing stub it is, rendered from the
# result by the image's own code, as the publish step renders it.
comment="$(docker run --rm -v "$root/evidence:/evidence:ro" -w /opt/qare/lib/packages/core --entrypoint node "$image" --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { loadResult, renderComment } from './dist/index.js'
  process.stdout.write(renderComment(loadResult(readFileSync('/evidence/result.json', 'utf8'))))
")"
if ! grep -qF "refused: missing stub: $undeclared:unknown (dns)" <<< "$comment"; then
  echo "the comment does not list $undeclared as a missing stub:" >&2
  echo "$comment" >&2
  exit 1
fi

if [ -z "${project// /}" ] || [ -z "$up_after_run" ]; then
  echo "the run named no compose project that was up when it finished, so the teardown step had nothing to prove" >&2
  exit 1
fi
left="$(running)$(networks)"
if [ -n "$left" ]; then
  echo "the teardown step left a container or network of the run ($project) behind: $left" >&2
  exit 1
fi
echo "egress boot: $example booted contained, reached its stub by the vendor's host name, and the run was refused listing $undeclared; the teardown took the stack, its resolver, its relay and its networks down"
