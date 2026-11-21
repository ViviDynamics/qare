#!/usr/bin/env bash
# Run the plan job's exploration steps (#377) against examples/compose-app
# under a profile that explores, and hold them to a real boot, a real
# browser and a real channel. The steps are the ones
# .github/workflows/pipeline.yml ships, run as the scripts they are, so a
# caller's pipeline and this check cannot drift apart.
#
#   scripts/explore-boot.sh <web image>
#
# <web image> is the qare web image the steps run in; CI passes the one it
# built from this tree. No model is called: the planner is a nare stand-in
# that speaks MCP to the channel the way nare's client does, and answers with
# a plan built from what the channel showed.
set -euo pipefail

image="${1:?usage: scripts/explore-boot.sh <web image>}"
profile="examples/compose-app/explore"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-$RUNNER_TEMP/explore-boot-summary.md}"
GITHUB_RUN_ID="${GITHUB_RUN_ID:-0}"
GITHUB_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
export RUNNER_TEMP GITHUB_STEP_SUMMARY GITHUB_RUN_ID GITHUB_RUN_ATTEMPT
mkdir -p "$RUNNER_TEMP"
work=".qare-explore-check"
rm -rf .qare-explore "$work"
mkdir -p "$work"

outputs="$RUNNER_TEMP/explore-boot-outputs"
step() {
  : > "$outputs"
  GITHUB_OUTPUT="$outputs" node scripts/run-pipeline-step.mjs plan "$1"
}
output() {
  sed -n "s/^$1=//p" "$outputs" | tail -1
}

container=""
teardown() {
  IMAGE_REF="$image" CONTAINER="$container" step 'Tear down the explored app' || true
  rm -rf "$work"
}
trap teardown EXIT

PROFILE="$profile" step 'Read whether the profile explores'
[ "$(output explore)" = "base" ] || { echo "the profile switch did not turn exploration on for $profile" >&2; exit 1; }
step "Find the runner's docker for exploration"
IMAGE_REF="$image" PROFILE="$profile" step 'Boot the base app for the planner'
IMAGE_REF="$image" step 'Serve the base app to the planner'
container="$(output container)"
endpoint="$(output endpoint)"
[ -n "$endpoint" ] || { echo "the serve step named no endpoint" >&2; exit 1; }
origin="$(jq -er '.origin' .qare-explore/app.json)"
project="$(jq -er '.project' .qare-explore/isolation.json)"
echo "explore boot: the base app is up at $origin (project $project), served to the planner at $endpoint"

# The serve container holds no docker access: no socket, no daemon endpoint.
mounts="$(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$container")"
case "$mounts" in *docker.sock*) echo "the serve container was handed the docker socket: $mounts" >&2; exit 1 ;; esac
# Its environment is the image's own and HOME, and nothing the step was given.
added="$(comm -13 <(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image" | cut -d= -f1 | sort -u) \
  <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" | cut -d= -f1 | sort -u) | tr '\n' ' ')"
if [ "$added" != "HOME " ]; then
  echo "the serve container was handed more than HOME beyond its image's environment: $added" >&2
  exit 1
fi

# What the real browser saw on the real page, straight from the channel.
snapshot="$(curl -fsS -X POST "$endpoint/snapshot")"
at="$(printf '%s' "$snapshot" | jq -er '[.. | objects | select(.role == "heading" and .name == "Hello-from-compose") | .path][0]')"
echo "explore boot: the page's heading is at $at"
# Navigation stays on the app.
if curl -fsS -X POST "$endpoint/navigate" -d '{"url":"http://169.254.169.254/"}' > /dev/null 2>&1; then
  echo "the channel navigated the browser off the app" >&2
  exit 1
fi

# The planner, through the plan step's own container shape: the runner's
# loopback and --explore, with a nare stand-in that explores / and answers.
printf '[{"id":"c1","text":"the page greets the visitor"}]\n' > "$work/criteria.json"
: > "$work/change.diff"
plan_for() {
  jq -n --arg at "$1" --arg name "$2" '{schemaVersion: "1", criteria: [{id: "c1", text: "the page greets the visitor", checks: [{kind: "flow", name: "greeting", actions: [{action: "open", url: "/"}, {action: "assertElement", element: {role: "heading", name: $name, at: $at, page: "/"}}]}]}]}'
}
plan() {
  local answer="$1" out="$2"
  printf '#!/bin/sh\nexec node %s %s %s "$@"\n' "$root/packages/cli/test/fixtures/fake-nare-explore.mjs" "$root/$work/seen-$out.json" "'$answer'" > "$work/nare"
  chmod +x "$work/nare"
  docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e FAKE_NARE_PAGE=/ \
    -v "$root:$root" -w "$root" \
    "$image" qare plan --criteria "$work/criteria.json" --diff "$work/change.diff" --out "$work/$out.json" \
    --nare "$root/$work/nare" --profile "$profile" --explore "$endpoint"
}
plan "$(plan_for "$at" Hello-from-compose | jq -c .)" seen
jq -e --arg at "$at" '.criteria[0].checks[0].actions[1].element == {role: "heading", name: "Hello-from-compose", at: $at, page: "/"}' "$work/seen.json" > /dev/null || {
  echo "the plan did not keep the element read from the explored page, with its page" >&2
  cat "$work/seen.json" >&2
  exit 1
}
jq -e '.argv as $a | ($a | index("--tools")) as $t | $a[$t + 1] == "explore__observe,explore__snapshot,explore__navigate" and ($a | index("--mcp-config")) != null' "$work/seen-seen.json" > /dev/null || {
  echo "the planner was not handed the channel through --mcp-config and its tools alone" >&2
  exit 1
}
echo "explore boot: a plan naming the heading the page showed was kept, with page / and its snapshot path"
plan "$(plan_for 'document/heading "Not-on-the-page"' Not-on-the-page | jq -c .)" unseen
jq -e '.criteria[0].unplannable | test("is not in the snapshot of /")' "$work/unseen.json" > /dev/null || {
  echo "a plan naming an element the page did not show was not refused" >&2
  cat "$work/unseen.json" >&2
  exit 1
}
echo "explore boot: a plan naming an element the page did not show was refused"

trap - EXIT
teardown
if [ -n "$(docker ps -aq --filter "name=^${container}$")" ]; then
  echo "the teardown step left the serve container $container" >&2
  exit 1
fi
if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$project")" ]; then
  echo "the teardown step left the explored app's project $project running" >&2
  exit 1
fi
echo "explore boot: the teardown step removed the browser and took the base app down"
