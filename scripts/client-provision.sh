#!/usr/bin/env bash
# Prove client provisioning against a real desktop build (#75).
#
# examples/electron-app is packaged twice, as the pipeline of a project would
# before qare runs: a build of the head, and a build of the base revision (the
# same pinned runtime, with the application as the commit before HEAD has it).
# Both are archives in the workspace. Three runs of the example's one plan
# then go through the pipeline's own execute step, read out of
# .github/workflows/pipeline.yml as the script it is, in the image a profile
# with `flavour: web` runs in:
#
#   both        consumes the prebuilt base and head artefacts and provisions
#               both: the plan passes on each side, the result names the
#               artefact each side was installed from, and each side's
#               provisioning log ends with its install removed.
#   regression  the head artefact is a build whose greeting drops the name:
#               the criterion the base build proves fails at the head, and it
#               is named a regression.
#   blocked     the head artefact is not an archive: the install fails, the
#               run is blocked naming the artefact with the log attached, and
#               no criterion is failed.
#
#   scripts/client-provision.sh <image>
#
# <image> is the qare web image the runs execute in. CI passes the one it
# built from this tree. The checkout must carry the commit before HEAD
# (fetch-depth: 2 in a workflow), which is the base.
set -euo pipefail

image="${1:?usage: scripts/client-provision.sh <image>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-$RUNNER_TEMP/client-provision-summary.md}"
export RUNNER_TEMP GITHUB_STEP_SUMMARY
mkdir -p "$RUNNER_TEMP"

example=examples/electron-app
profile="$example/profiles/desktop-provisioned"
artefacts="$example/artefacts"
collected="$RUNNER_TEMP/client-provision-evidence"
prior="$RUNNER_TEMP/client-provision-prior-evidence"
work="$RUNNER_TEMP/client-provision-work"
had_traces=0
[ -d traces ] && had_traces=1

# Evidence an earlier step left (the electron driver's) is kept beside this
# script's: both are what a reader of a failure needs.
rm -rf "$collected" "$prior" "$work"
mkdir -p "$collected" "$work"
[ -d evidence ] && mv evidence "$prior"
git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
cleanup() {
  rm -f plan.json
  rm -rf "$artefacts" "$work"
  [ "$had_traces" -eq 1 ] || rm -rf traces
  git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
  rm -rf evidence
  if [ -d "$prior" ]; then mv "$prior" evidence; else mkdir -p evidence; fi
  if [ -n "$(ls -A "$collected" 2>/dev/null)" ]; then cp -R "$collected"/. evidence/; fi
  rmdir evidence 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "$1" >&2
  exit 1
}

# The project's own pipeline step: package the builds. The base build takes
# the application as the commit before HEAD has it; the head build takes the
# working tree's. A third build is the head with a defect, for the run that
# shows a regression.
pnpm -C "$example" install --ignore-workspace --frozen-lockfile
rm -rf "$artefacts"
mkdir -p "$artefacts" "$work/base" "$work/defect"
git archive 'HEAD^1' "$example/app" | tar -x -C "$work/base"
node "$example/package.mjs" --archive "$artefacts/base.tar" --app "$work/base/$example/app"
node "$example/package.mjs" --archive "$work/head.tar"
cp -R "$example/app" "$work/defect/app"
# The greeting loses the name it was given.
sed -i 's/`${greeting}, ${name}.`/`${greeting}.`/' "$work/defect/app/renderer/app.js"
grep -q '`${greeting}.`' "$work/defect/app/renderer/app.js" || fail "the defect was not planted in the head build"
node "$example/package.mjs" --archive "$work/defect.tar" --app "$work/defect/app"
printf 'this is not an archive\n' > "$work/corrupt.tar"

step() {
  node scripts/run-pipeline-step.mjs execute "$1"
}
step "Find the runner's docker"

# run <name> <head artefact> <expected exit code>: the execute step against
# the provisioned profile, with the evidence set aside.
run() {
  local name="$1" head="$2" expected="$3" code=0
  rm -rf evidence
  git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
  cp "$head" "$artefacts/head.tar"
  cp "$example/plan.json" plan.json
  IMAGE_REF="$image" \
  IMAGE_TAG_REF="$image" \
  IMAGE_DIGEST="${image}@local" \
  BASE_SHA="$(git rev-parse 'HEAD^1')" \
  HEAD_SHA="$(git rev-parse HEAD)" \
  PR_NUMBER=0 \
  PROFILE="$profile" \
    step 'Run the plan' || code=$?
  [ -f evidence/result.json ] || fail "$name: the execute step exited $code and recorded no evidence/result.json"
  mv evidence "$collected/provisioned-$name"
  jq '{verdict, base, client, criteria: [.criteria[] | {id, outcome, regression, reason, base, evidence}]}' "$collected/provisioned-$name/result.json"
  [ "$code" -eq "$expected" ] || fail "$name: the execute step exited $code, not $expected"
}

sha() {
  sha256sum "$1" | cut -d' ' -f1
}
base_sha="$(sha "$artefacts/base.tar")"

# 1. Prebuilt artefacts for base and head, both provisioned.
run both "$work/head.tar" 0
both="$collected/provisioned-both"
jq -e '.verdict == "passed" and (.criteria | length) > 0 and ([.criteria[] | .outcome == "proven" and .base.outcome == "proven"] | all)' "$both/result.json" > /dev/null \
  || fail "both: the plan did not pass on both sides"
jq -e '.base.status == "executed"' "$both/result.json" > /dev/null || fail "both: the base side did not execute"
jq -e --arg head "$(sha "$work/head.tar")" --arg base "$base_sha" '
  .client.driver == "electron" and .client.executable == "qare-example/qare-example" and .client.comparison == "base"
  and .client.artefact == {path: "examples/electron-app/artefacts/head.tar", kind: "archive", source: "prebuilt", sha256: $head}
  and .client.base == {path: "examples/electron-app/artefacts/base.tar", kind: "archive", source: "prebuilt", sha256: $base}' "$both/result.json" > /dev/null \
  || fail "both: the result does not name the artefact each side was installed from, by the hash of the file"
for side in base head; do
  log="$both/$side/provision.log"
  [ -s "$log" ] || fail "both: the $side side has no provisioning log"
  grep -q "^provisioning the $side side from examples/electron-app/artefacts/$side.tar (archive)$" "$log" || fail "both: the $side log does not name its artefact"
  grep -q '^\[obtain\] .* is there: [0-9]* bytes, sha256 ' "$log" || fail "both: the $side artefact was not taken as prebuilt"
  grep -q '^\[install\] installed at .*qare-install-'"$side"'-' "$log" || fail "both: the $side build was not installed into a directory of the run's own"
  # The health check is the real build's own start: its main process and its first window.
  grep -q '^\[health\] \[main stdout\] main: ready, user data at ' "$log" || fail "both: the $side health check did not launch the build"
  grep -q '^\[health\] \[window 1 opened\] ' "$log" || fail "both: the $side health check saw no window"
  grep -q '^\[health\] the build came up within 30s$' "$log" || fail "both: the $side build was not proven up"
  grep -q '^\[teardown\] removed .*; nothing is left$' "$log" || fail "both: the $side install was not removed"
  # The flows drove the installed build, not a path in the checkout.
  grep -q '^\[window 1 console.log\] renderer: greeted Ada$' "$both/$side/checks/greets/0/console.log" || fail "both: the $side build was not driven"
  # Each installed build ran contained (#223): in a cell with no network of
  # its own, launched from a copy of the install, reaching nothing undeclared.
  jq -e '.containment == "cell" and ([.reached[] | select(.declared | not)] | length) == 0' "$both/$side/checks/greets/0/outbound.json" > /dev/null \
    || fail "both: the $side build did not run contained: $(cat "$both/$side/checks/greets/0/outbound.json" 2>&1)"
done
jq -e '.client.egress == "contained"' "$both/result.json" > /dev/null || fail "both: the result does not say the builds were contained"
# Nothing was built by the run, and the base was not checked out to build it.
! grep -q '^\[build\]' "$both/base/provision.log" "$both/head/provision.log" || fail "both: a prebuilt artefact was rebuilt"

# 2. A real comparison: the base build proves what the head build fails.
run regression "$work/defect.tar" 1
regression="$collected/provisioned-regression"
jq -e '.verdict == "failed" and .base.status == "executed" and .client.comparison == "base"
  and ([.criteria[] | select(.id == "greets")][0] | .outcome == "failed" and .regression == true and .base.outcome == "proven")' "$regression/result.json" > /dev/null \
  || fail "regression: a criterion the base build proves and the head build fails was not named a regression"
jq -e --arg base "$base_sha" '.client.base.sha256 == $base' "$regression/result.json" > /dev/null || fail "regression: the base side was not the same prebuilt artefact"

# 3. A failed install: blocked, naming the artefact, with the log attached.
run blocked "$work/corrupt.tar" 2
blocked="$collected/provisioned-blocked"
jq -e '.verdict == "blocked" and (.criteria | length) > 0
  and ([.criteria[] | .outcome == "unverified"
        and (.reason | startswith("the head artefact examples/electron-app/artefacts/head.tar could not be installed: tar exited "))
        and (.evidence == ["head/provision.log"])] | all)
  and ([.criteria[] | .outcome == "failed"] | any | not)' "$blocked/result.json" > /dev/null \
  || fail "blocked: a failed install was not reported blocked naming the artefact with its log attached"
grep -q '^\[install\] tar: ' "$blocked/head/provision.log" || fail "blocked: the log does not carry what the installer said"
grep -q '^\[blocked\] the head artefact examples/electron-app/artefacts/head.tar could not be installed' "$blocked/head/provision.log" || fail "blocked: the log does not say why the run stopped"
# The base side had nothing wrong with it: it was provisioned and checked.
jq -e '.base.status == "executed"' "$blocked/result.json" > /dev/null || fail "blocked: the base side did not execute"
# Nothing was launched for the head, so no check left evidence there.
[ ! -d "$blocked/head/checks" ] || fail "blocked: a check ran against a build that was never installed"

{
  echo "### Client provisioning"
  echo
  echo "\`$example/plan.json\` ran against prebuilt base and head artefacts of the desktop build, both provisioned by the run, in \`$image\`. A head build with a defect was named a regression, and a head artefact that is not an archive blocked the run naming it."
  echo
  echo '```'
  cat "$both/base/provision.log" "$both/head/provision.log"
  echo
  cat "$blocked/head/provision.log"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
echo "client provisioning: prebuilt base and head artefacts were both installed, proven up, driven and removed; a defect in the head build was named a regression; a failed install blocked the run naming the artefact with its log attached"
