#!/usr/bin/env bash
# Prove the Electron driver against a real Electron application (#72).
#
# One plan, two targets. examples/electron-app/plan.json is a flow written for
# the browser; it runs first against the example's page served over HTTP, in
# the browser, and then against the packaged desktop build of the same page,
# through the Electron driver. Nothing is edited in between: the profile, and
# so the target, is the only thing that differs. A second plan then drives
# the desktop build into a window of its own and back.
#
# Each run is the pipeline's own execute step, read out of
# .github/workflows/pipeline.yml as the script it is, as in
# scripts/compose-boot.sh: what runs is what a caller's pipeline runs, in the
# image a profile with `flavour: web` runs in. The driver starts the virtual
# display itself, so the step needs nothing a caller's does not have.
#
#   scripts/electron-driver.sh <image>
#
# <image> is the qare web image the runs execute in. CI passes the one it
# built from this tree. The checkout must carry the commit before HEAD
# (fetch-depth: 2 in a workflow), which the step names as the base.
set -euo pipefail

image="${1:?usage: scripts/electron-driver.sh <image>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-$RUNNER_TEMP/electron-driver-summary.md}"
export RUNNER_TEMP GITHUB_STEP_SUMMARY
mkdir -p "$RUNNER_TEMP"

example=examples/electron-app
collected="$RUNNER_TEMP/electron-driver-evidence"
server="qare-electron-driver-web-$$"
# The trace of a flow is kept beside the evidence directory, never in it.
had_traces=0
[ -d traces ] && had_traces=1

rm -rf evidence "$collected"
mkdir -p "$collected"
git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
cleanup() {
  rm -f plan.json
  docker rm -f "$server" > /dev/null 2>&1 || true
  [ "$had_traces" -eq 1 ] || rm -rf traces
  git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
  # Whatever the runs produced is what a reader of a failure needs.
  if [ -d "$collected" ] && [ -n "$(ls -A "$collected" 2>/dev/null)" ]; then
    rm -rf evidence
    mkdir -p evidence
    cp -R "$collected"/. evidence/
  fi
}
trap cleanup EXIT

# The desktop build: the pinned Electron runtime with the application beside
# it. The runtime is the example's own dev dependency, outside the workspace.
pnpm -C "$example" install --ignore-workspace --frozen-lockfile
node "$example/package.mjs"

# The browser half's target: the same renderer files, over HTTP. The server
# runs in a container on the network the run's container shares, so the
# target is at the same loopback address wherever the docker daemon lives.
# Whether it is up is the profile's health check's to prove.
docker rm -f "$server" > /dev/null 2>&1 || true
docker run -d --rm --name "$server" --network host \
  -v "$PWD:$PWD:ro" -w "$PWD" --entrypoint node \
  "$image" "$example/serve.mjs" 4173 > /dev/null

step() {
  node scripts/run-pipeline-step.mjs execute "$1"
}
step "Find the runner's docker"

# run <name> <plan> <profile>: the execute step, with the evidence set aside.
run() {
  local name="$1" plan="$2" profile="$3" code=0
  rm -rf evidence
  git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
  cp "$plan" plan.json
  IMAGE_REF="$image" \
  IMAGE_DIGEST="${image}@local" \
  BASE_SHA="$(git rev-parse 'HEAD^1')" \
  HEAD_SHA="$(git rev-parse HEAD)" \
  PR_NUMBER=0 \
  PROFILE="$profile" \
    step 'Run the plan' || code=$?
  if [ ! -f evidence/result.json ]; then
    echo "$name: the execute step exited $code and recorded no evidence/result.json" >&2
    exit 1
  fi
  mv evidence "$collected/$name"
  jq '{verdict, target, client, criteria: [.criteria[] | {id, outcome, reason, evidence}]}' "$collected/$name/result.json"
  if [ "$code" -ne 0 ] || ! jq -e '.verdict == "passed" and ([.criteria[] | .outcome == "proven"] | all) and (.criteria | length) > 0' "$collected/$name/result.json" > /dev/null; then
    echo "$name: the execute step exited $code and the plan did not pass against $profile" >&2
    [ -f "$collected/$name/checks/greets/0/console.log" ] && cat "$collected/$name/checks/greets/0/console.log" >&2
    exit 1
  fi
}

# The same file, twice: the flow is not edited between the two targets.
run web "$example/plan.json" "$example/profiles/web"
run desktop "$example/plan.json" "$example/profiles/desktop"
run desktop-windows "$example/plan-windows.json" "$example/profiles/desktop"

fail() {
  echo "$1" >&2
  exit 1
}
is_png() {
  [ -s "$1" ] && [ "$(head -c 8 "$1" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ]
}

web="$collected/web"
desktop="$collected/desktop"
windows="$collected/desktop-windows"
check=checks/greets/0

# Which driver ran which: the browser against a target, the Electron driver
# against the build, each with one side and no base comparison.
jq -e '.target.url == "http://127.0.0.1:4173" and .client == null' "$web/result.json" > /dev/null || fail "the browser run does not name its target"
jq -e '.client == {driver: "electron", executable: "examples/electron-app/dist/qare-example/qare-example", comparison: "none"} and .target == null' "$desktop/result.json" > /dev/null \
  || fail "the desktop run does not name the build it launched"

# The flow both runs drove is the same flow: every action after the open,
# which names its target, reads the same in both action logs.
if ! diff <(grep '^action ' "$web/$check/actions.log" | tail -n +2) <(grep '^action ' "$desktop/$check/actions.log" | tail -n +2); then
  fail "the browser and the desktop build were not driven through the same actions"
fi
[ "$(grep -c '^action ' "$desktop/$check/actions.log")" -eq 8 ] || fail "the desktop run did not drive the eight actions the plan names"

# Evidence from the desktop run: screenshots that are images, and the
# application's own console output from both of its processes.
for shot in capture-7.png final.png; do
  is_png "$desktop/$check/$shot" || fail "the desktop run's $shot is not a PNG"
  jq -e --arg path "$check/$shot" '[.criteria[].evidence[]] | index($path) != null' "$desktop/result.json" > /dev/null || fail "the desktop result does not list $shot as evidence"
done
jq -e --arg path "$check/console.log" '[.criteria[].evidence[]] | index($path) != null' "$desktop/result.json" > /dev/null || fail "the desktop result does not list the console output as evidence"
grep -q '^\[main stdout\] main: ready, user data at ' "$desktop/$check/console.log" || fail "the console output misses what the main process wrote while starting"
grep -q '^\[window 1 console.log\] renderer: greeted Ada$' "$desktop/$check/console.log" || fail "the console output misses what the window logged"
grep -q '^\[main exited\] ' "$desktop/$check/console.log" || fail "the console output does not say the application exited"
# Each launch has a user data directory of its own, not the user's.
grep -q 'user data at .*qare-electron-' "$desktop/$check/console.log" || fail "the build was not launched with a user data directory of its own"
# The browser driver produces no console evidence: this is the desktop run's.
[ ! -e "$web/$check/console.log" ] || fail "the browser run wrote a console.log nobody declared"

# The second window: opened by the application, driven, pictured and closed.
wcheck=checks/details-window/0
grep -q '^\[window 2 opened\] ' "$windows/$wcheck/console.log" || fail "the application's second window was never attached"
grep -q '^\[window 2 console.log\] renderer: details window ready$' "$windows/$wcheck/console.log" || fail "the second window's console output is missing"
grep -q '^\[window 2 closed\]$' "$windows/$wcheck/console.log" || fail "the second window never closed"
is_png "$windows/$wcheck/capture-4.png" || fail "the capture of the second window is not a PNG"
is_png "$windows/$wcheck/capture-8.png" || fail "the capture of the first window is not a PNG"
# Two windows of different sizes: the two captures cannot be the same picture.
if cmp -s "$windows/$wcheck/capture-4.png" "$windows/$wcheck/capture-8.png"; then
  fail "the captures of the two windows are the same picture"
fi

{
  echo "### Electron driver"
  echo
  echo "One plan (\`$example/plan.json\`) passed against the browser and against the packaged desktop build, in \`$image\`."
  echo
  echo '```'
  cat "$desktop/$check/console.log"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
echo "electron driver: one plan passed against the browser and the desktop build, the desktop evidence carries screenshots and the console output, and a second window was driven and closed"
