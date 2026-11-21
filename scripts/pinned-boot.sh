#!/usr/bin/env bash
# Run the pipeline's execute steps against examples/pinned-app (#408), and
# hold the result to a contained stack that kept its pinned addresses: the
# app, which declares no network, stayed on the default network beside the
# database and the stub pinned to it, booted healthy, was seeded, and every
# check passed. Before the teardown the live stack is read to show the
# relay was handed an address, not a service name, and the resolver was
# handed the stub's address. The steps are the ones
# .github/workflows/pipeline.yml ships, run as the scripts they are.
#
#   scripts/pinned-boot.sh <image>
#
# <image> is the qare image the run executes in. CI passes the core image it
# built from this tree. The base side is the commit before HEAD, which the
# checkout must carry (fetch-depth: 2 in a workflow).
set -euo pipefail

image="${1:?usage: scripts/pinned-boot.sh <image>}"
example=examples/pinned-app
db_address=198.18.89.10
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-$RUNNER_TEMP/pinned-boot-summary.md}"
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
# One running container of a service of the head's project, which outlives the run until the teardown step.
container() {
  local name
  for name in $project; do
    docker ps -q --filter "label=com.docker.compose.project=$name" --filter "label=com.docker.compose.service=$1" || true
  done | sed -n 1p
}
up_after_run="$(running)"

# The live stack, read before the teardown. Each value is printed, then held.
problems=""
web="$(container web)"
relay="$(container qare-egress-relay)"
sink="$(container qare-egress-dns)"
web_networks="$( [ -n "$web" ] && docker inspect -f '{{json .NetworkSettings.Networks}}' "$web" | jq -c 'keys' || echo '[]')"
db_on_default="$( [ -n "$(container db)" ] && docker inspect -f '{{json .NetworkSettings.Networks}}' "$(container db)" | jq -r 'to_entries[] | select(.key | endswith("_default")) | .value.IPAddress' || true)"
relay_command="$( [ -n "$relay" ] && docker inspect -f '{{json .Config.Cmd}}' "$relay" || echo 'null')"
sink_map="$( [ -n "$sink" ] && docker exec "$sink" cat /run/qare-egress/services.json || echo '{}')"
echo "web is on: $web_networks"
echo "db's address on the default network: ${db_on_default:-none}"
echo "the relay runs: $relay_command"
echo "the resolver was handed: $sink_map"
# The app kept its implicit default network beside the contained one (#408).
jq -e 'any(.[]; endswith("_default")) and any(.[]; endswith("_qare-contained"))' <<< "$web_networks" > /dev/null || problems="$problems web is not on both the default and the contained network;"
[ "$db_on_default" = "$db_address" ] || problems="$problems db is not at its pinned address $db_address;"
# Each forward names an address the run read from the daemon, never a service name.
jq -e '. as $cmd | [range(0; length) | select($cmd[.] == "--forward") | $cmd[. + 1]] as $forwards | ($forwards | length) > 0 and ($forwards | all(test("^[0-9]+=[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+:[0-9]+$")))' <<< "$relay_command" > /dev/null || problems="$problems the relay was not handed an address for every forward;"
jq -e '.["billing-stub"] | length > 0 and all(test("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$"))' <<< "$sink_map" > /dev/null || problems="$problems the resolver was not handed the stub's address;"

IMAGE_REF="$image" step 'Tear down what the run booted'

if [ ! -f evidence/result.json ]; then
  echo "the execute step exited $code and recorded no evidence/result.json" >&2
  exit 1
fi
jq '{verdict, egress, base: .base.status, criteria: [.criteria[] | {id, outcome, reason}]}' evidence/result.json

# Passed, with every check proven against the seeded app: a boot that lost
# the default network leaves the database unreached, and a blocked boot
# leaves every criterion unverified. Contained, with only the stub's host
# looked up.
if [ "$code" -ne 0 ] || ! jq -e --argjson criteria "$criteria" '
  .verdict == "passed" and
  (.criteria | length) == $criteria and
  ([.criteria[] | .outcome == "proven"] | all) and
  .egress.containment == "contained" and
  .egress.undeclared == [] and
  (.egress.declared | index("api.billing-vendor.example")) != null
' evidence/result.json > /dev/null; then
  echo "the execute step exited $code: the $example stack did not boot contained and healthy, or a check against it did not pass" >&2
  exit 1
fi
if [ -n "$problems" ]; then
  echo "the $example stack was contained, but not by address:$problems" >&2
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
echo "pinned boot: $example booted contained with its pinned addresses, was seeded, and passed; the relay and the resolver were handed addresses; the teardown took everything down"
