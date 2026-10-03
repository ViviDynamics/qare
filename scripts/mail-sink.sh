#!/usr/bin/env bash
# Prove a criterion about a sent message from a real message (#65).
#
# First, run the pipeline's execute steps against the example profile whose
# stack carries a real Mailpit catcher (examples/mail-app), and hold the
# result to it: the app sent a message over SMTP, the mail check read it from
# the catcher, a later check followed the link in it, and the run deleted
# what it was sent. The steps are the ones .github/workflows/pipeline.yml
# ships, as in scripts/compose-boot.sh.
#
# Then start one catcher and run two waits on it at once, each at an address
# of its own: neither may read the other's message.
#
#   scripts/mail-sink.sh <image>
#
# <image> is the qare image the run executes in. CI passes the core image it
# built from this tree. The base side is the commit before HEAD, which the
# checkout must carry (fetch-depth: 2 in a workflow). The workspace must be
# built (pnpm build): the second part runs qare's mail adapter from it.
set -euo pipefail

image="${1:?usage: scripts/mail-sink.sh <image>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-$RUNNER_TEMP/mail-sink-summary.md}"
export RUNNER_TEMP GITHUB_STEP_SUMMARY
mkdir -p "$RUNNER_TEMP"

catcher="qare-mail-sink-$$"
rm -rf evidence
cp examples/mail-app/plan.json plan.json
# A base worktree an earlier run left behind would refuse the new one.
git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
cleanup() {
  rm -f plan.json
  git worktree remove --force "$RUNNER_TEMP/qare-base" 2>/dev/null || true
  docker rm -f "$catcher" > /dev/null 2>&1 || true
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
PROFILE=examples/mail-app/.qa \
  step 'Run the plan' || code=$?
# The stack outlives the run: taking it down is the pipeline's step, and it
# runs whatever the run came to, so nothing it booted outlives a failure.
IMAGE_REF="$image" step 'Tear down what the run booted'

if [ ! -f evidence/result.json ]; then
  echo "the execute step exited $code and recorded no evidence/result.json" >&2
  exit 1
fi

jq '{verdict, base: .base.status, criteria: [.criteria[] | {id, outcome, reason, mail}]}' evidence/result.json
# Passed, with both criteria proven: the message arrived and its link worked.
# The result names the message as the catcher held it.
if [ "$code" -ne 0 ] || ! jq -e '
  .verdict == "passed" and
  (.criteria | length) == 2 and
  ([.criteria[] | .outcome == "proven"] | all) and
  (.criteria[0].mail | length) == 1 and
  .criteria[0].mail[0].check == "confirmation" and
  .criteria[0].mail[0].subject == "Confirm your account" and
  (.criteria[0].mail[0].from | contains("no-reply@mail-app.example"))
' evidence/result.json > /dev/null; then
  echo "the execute step exited $code: the app did not boot, no message was read from the catcher, or its link did not confirm the account" >&2
  exit 1
fi

# The head's evidence: the message as it was read, swept, and the cleanup.
message="$(find evidence -path '*signup-sends-confirmation*' -name message.json -not -path 'evidence/base/*' | head -n 1)"
cleaned="$(find evidence -name mail-cleanup.json -not -path 'evidence/base/*' | head -n 1)"
if [ -z "$message" ] || [ -z "$cleaned" ]; then
  echo "the run saved no message.json for the mail check, or no mail-cleanup.json" >&2
  exit 1
fi
jq . "$message" "$cleaned"
# The recipient's address and the one-time code never reach the evidence.
if ! jq -e '
  (.excerpt | contains("Your one-time code is [redacted]")) and
  (.excerpt | test("@localhost") | not) and
  (.excerpt | test("[0-9]{6}") | not)
' "$message" > /dev/null; then
  echo "the message evidence carries an address or a one-time code that should have been swept" >&2
  exit 1
fi
# The run deleted the one message it was sent, at the address it minted.
if ! jq -e '(.source | startswith("mailpit at ")) and (.addresses | length) == 1 and .addresses[0].deleted == 1' "$cleaned" > /dev/null; then
  echo "the run did not delete the message at the address it minted" >&2
  exit 1
fi
echo "mail sink: the app sent a message, the mail check read it from a real catcher, its link confirmed the account, and the run deleted it"

# Two waits at once on one catcher, the same image the example stack pins.
catcher_image="$(sed -n 's/^ *image: *\(axllent\/mailpit:[^ ]*\) *$/\1/p' examples/mail-app/compose.yaml)"
docker run -d --name "$catcher" -p 127.0.0.1::8025 -p 127.0.0.1::1025 "$catcher_image" > /dev/null
web="$(docker port "$catcher" 8025/tcp | head -n 1)"
relay="$(docker port "$catcher" 1025/tcp | head -n 1)"
ready=""
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://$web/readyz" 2>/dev/null; then
    ready=yes
    break
  fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "the catcher ($catcher_image) never answered on $web" >&2
  docker logs "$catcher" >&2 || true
  exit 1
fi
node examples/mail-app/concurrent.mjs "http://$web" "$relay"
echo "mail sink: two concurrent waits on one catcher each read their own message, and deleted only their own"
