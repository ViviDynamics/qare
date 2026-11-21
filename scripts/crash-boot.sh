#!/usr/bin/env bash
# Run the pipeline's execute steps against examples/crash-app (#407), and
# hold the evidence to explaining a boot that failed: the run is blocked,
# the service's log is saved redacted at <side>/services/web.log, the result
# names the service, its exit code and its last lines, the name the
# contained stack looked up before it failed is recorded, and the comment,
# rendered by the image's own code, shows the line the service printed. The
# steps are the ones .github/workflows/pipeline.yml ships, run as the
# scripts they are.
#
#   scripts/crash-boot.sh <image>
#
# <image> is the qare image the run executes in. CI passes the core image it
# built from this tree. The base side is the commit before HEAD, which the
# checkout must carry (fetch-depth: 2 in a workflow).
set -euo pipefail

image="${1:?usage: scripts/crash-boot.sh <image>}"
example=examples/crash-app
said="crash-app: cannot reach db.crash-app.example, giving up"
looked_up=db.crash-app.example
secret=crash-app-secret-407
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-$RUNNER_TEMP/crash-boot-summary.md}"
export RUNNER_TEMP GITHUB_STEP_SUMMARY
mkdir -p "$RUNNER_TEMP"

rm -rf evidence
cp "$example/plan.json" plan.json
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
    docker ps -aq --filter "label=com.docker.compose.project=$name"
  done
}
networks() {
  local name
  for name in $project; do
    docker network ls -q --filter "label=com.docker.compose.project=$name"
  done
}
IMAGE_REF="$image" step 'Tear down what the run booted'

if [ ! -f evidence/result.json ]; then
  echo "the execute step exited $code and recorded no evidence/result.json" >&2
  exit 1
fi
jq '{verdict, boot, egress, base: {status: .base.status, reason: .base.reason}, criteria: [.criteria[] | {id, outcome, reason}]}' evidence/result.json

# The head's side of the evidence: head/ on a two-sided run.
side=evidence
if [ -d evidence/head ]; then side=evidence/head; fi
log="$side/services/web.log"

# The run is blocked by the boot, and the result names the service that
# exited, its exit code, its log and its last lines, the line it printed
# among them, and the name the contained stack looked up before it failed.
if ! jq -e --arg said "$said" --arg host "$looked_up" '
  .verdict == "blocked" and
  ([.criteria[] | .outcome == "unverified"] | all) and
  (.boot.services | map(select(.service == "web")) | length) == 1 and
  (.boot.services[] | select(.service == "web") |
    .state == "exited" and .exitCode == 1 and .log == "services/web.log" and
    (.tail | length) <= 20 and (.tail | index($said)) != null) and
  .egress.containment == "contained" and
  (.egress.undeclared | index($host)) != null
' evidence/result.json > /dev/null; then
  echo "the result does not name web, its exit code 1 and its last lines with \"$said\", or the lookup of $looked_up" >&2
  exit 1
fi

# The service's log is in the evidence, with the line it printed, and the
# password it printed is not.
if [ ! -f "$log" ] || ! grep -qF "$said" "$log"; then
  echo "$log is missing, or does not hold the line the service printed" >&2
  exit 1
fi
if grep -rqF "$secret" evidence; then
  echo "the evidence carries the password the service printed: it was not redacted" >&2
  exit 1
fi

# The comment, rendered from the result by the image's own code as the
# publish step renders it, names the service and its exit code and shows
# the line it printed.
comment="$(docker run --rm -v "$root/evidence:/evidence:ro" -w /opt/qare/lib/packages/core --entrypoint node "$image" --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { loadResult, renderComment } from './dist/index.js'
  process.stdout.write(renderComment(loadResult(readFileSync('/evidence/result.json', 'utf8'))))
")"
for expected in "\`web\` exited with code 1" "$said" "refused: missing stub: $looked_up:unknown (dns)"; do
  if ! grep -qF "$expected" <<< "$comment"; then
    echo "the comment does not show: $expected" >&2
    echo "$comment" >&2
    exit 1
  fi
done
if grep -qF "$secret" <<< "$comment"; then
  echo "the comment carries the password the service printed" >&2
  exit 1
fi

if [ -z "${project// /}" ]; then
  echo "the run named no compose project, so the teardown step had nothing to prove" >&2
  exit 1
fi
left="$(running)$(networks)"
if [ -n "$left" ]; then
  echo "the teardown step left a container or network of the run ($project) behind: $left" >&2
  exit 1
fi
echo "crash boot: $example was blocked by web exiting 1, its redacted log is at $log, and the comment shows \"$said\" beside the lookup of $looked_up"
