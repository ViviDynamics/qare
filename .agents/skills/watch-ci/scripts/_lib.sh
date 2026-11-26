# Shared functions for Vivi Dynamics skill scripts. Source, do not execute.
# bash 3.2 compatible. Dependencies: gh, jq, git.

vivi_die() { local code=$1; shift; printf '{"error":%s}\n' "$(printf '%s' "$*" | jq -Rs .)"; echo "error: $*" >&2; exit "$code"; }

vivi_root() {
  git rev-parse --show-toplevel 2>/dev/null || vivi_die 2 "not inside a git repository"
}

# Per-person keys: the only ones repo.env may set when a repo.env.example exists.
VIVI_PERSONAL_KEYS="VIVI_ASSIGNEE VIVI_GH_TOKEN_FILE"

# Reads VIVI_* lines from <file> and exports them. With "personal", only the per-person
# keys are taken; every other key is left to repo.env.example (and listed in
# VIVI_IGNORED_KEYS for check-wiring to report).
_vivi_read_env() {
  local file=$1 mode=$2 line key val others="" kv
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in VIVI_*=*) ;; *) continue;; esac
    key=${line%%=*}; val=${line#*=}
    case "$key" in *[!A-Za-z0-9_]*) continue;; esac
    # Drop an inline comment: whitespace followed by # and the rest of the line.
    case "$val" in *[[:space:]]#*) val=${val%%[[:space:]]#*};; esac
    while :; do case "$val" in *[[:space:]]) val=${val%?};; *) break;; esac; done
    val=${val%\"}; val=${val#\"}
    val=${val//\$HOME/$HOME}
    if [ "$mode" = personal ]; then
      case " $VIVI_PERSONAL_KEYS " in
        *" $key "*) ;;
        *) others="$others$key=$val"$'\n'; continue;;
      esac
    fi
    export "$key=$val"
  done < "$file"
  # A non-personal key in repo.env is ignored; it is reported when its LAST value there
  # differs from the example's, so a plain copy of an example that repeats a key is fine.
  if [ -n "$others" ]; then
    while IFS= read -r kv; do
      [ -n "$kv" ] || continue
      key=${kv%%=*}; val=${kv#*=}
      if [ "$(eval "printf '%s' \"\${$key:-}\"")" != "$val" ]; then VIVI_IGNORED_KEYS="${VIVI_IGNORED_KEYS:+$VIVI_IGNORED_KEYS }$key"; fi
    done <<<"$(printf '%s' "$others" | awk -F= '{ if (!($1 in last)) order[++n] = $1; last[$1] = $0 } END { for (i = 1; i <= n; i++) print last[order[i]] }')"
  fi
}

# The configuration is repo.env.example, committed, so every clone and worktree has it.
# repo.env (gitignored, optional) only adds the per-person keys on top: VIVI_ASSIGNEE and
# VIVI_GH_TOKEN_FILE. A stale copy of the example in repo.env therefore changes nothing.
# A repo with no repo.env.example keeps the old layout: repo.env is the whole config.
# VIVI_ASSIGNEE already in the environment (for example from an uncommitted
# .claude/settings.local.json) beats both files.
vivi_load_env() {
  local root base file env_assignee=${VIVI_ASSIGNEE:-}
  root=$(vivi_root) || exit 2
  base="$root/repo.env.example"; file="$root/repo.env"
  VIVI_IGNORED_KEYS=""
  if [ -f "$base" ]; then
    _vivi_read_env "$base" all
    if [ "${VIVI_TEMPLATE:-}" = true ]; then
      vivi_die 2 "$base is the unedited template from ViviDynamics/skills (VIVI_TEMPLATE=true): fill in this repository's values and delete the VIVI_TEMPLATE line"
    fi
    if [ -f "$file" ]; then _vivi_read_env "$file" personal; fi
  elif [ -f "$file" ]; then
    _vivi_read_env "$file" all
  else
    vivi_die 2 "no repo.env.example at $base (commit one with this repository's settings)"
  fi
  if [ -n "$env_assignee" ]; then export VIVI_ASSIGNEE="$env_assignee"; fi
  export VIVI_ROOT="$root"
}

# vivi_pr_diff <pr> <out-file>: the PR's diff. GitHub serves no PR diff above 300 files
# or 20,000 lines (HTTP 406, too_large); then the same diff is rebuilt from git (merge
# base of the PR's base and head, to its head), so a large PR is still checked line by
# line rather than refused or skipped. A shallow checkout is unshallowed for it.
vivi_pr_diff() {
  local pr=$1 out=$2 err code=0 oids base_oid head_oid oid merge_base
  err="$out.err"
  vivi_gh pr diff "$pr" --repo "$VIVI_REPO" > "$out" 2> "$err" || code=$?
  if [ "$code" -ne 0 ]; then
    grep -q 'too_large' "$err" || { cat "$err" >&2; rm -f "$err"; return "$code"; }
    rm -f "$err"
    # One read, so a push in between cannot pair one head's base with another's.
    oids=$(vivi_gh pr view "$pr" --repo "$VIVI_REPO" --json baseRefOid,headRefOid --jq '.baseRefOid + " " + .headRefOid') || return $?
    base_oid=${oids%% *}; head_oid=${oids#* }
    if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
      git fetch -q --no-tags --unshallow origin || vivi_die 2 "cannot unshallow the checkout: check out with fetch-depth: 0"
    fi
    for oid in "$base_oid" "$head_oid"; do
      git cat-file -e "$oid^{commit}" 2>/dev/null || git fetch -q --no-tags origin "$oid" \
        || vivi_die 2 "PR $pr commit $oid is not available locally"
    done
    merge_base=$(git merge-base "$base_oid" "$head_oid") || vivi_die 2 "PR $pr has no merge base with its base branch"
    # Called as `vivi_pr_diff ... || exit`, so set -e does not apply here: every failure
    # returns, or an empty diff would read as clean. Plumbing-stable output: no colour,
    # no external diff or textconv, a/ and b/ prefixes, renames found however many files.
    git -c diff.renameLimit=100000 diff --no-color --no-ext-diff --no-textconv -M \
      --src-prefix=a/ --dst-prefix=b/ "$merge_base" "$head_oid" > "$out" || return $?
    echo "PR $pr's diff is too large for GitHub to serve; rebuilt it from git ($merge_base..$head_oid)" >&2
  else
    rm -f "$err"
  fi
}

# Modification time of a path in epoch seconds; now when it cannot be read, so an
# unreadable lock never looks old. The stat flavour is chosen once, never by falling
# back: on GNU, `stat -f` is filesystem mode and prints a multi-line block, which in a
# race (the path gone for -c, back for -f) would land in arithmetic. Only digits return.
vivi_mtime() {
  local m
  if stat -c %Y / >/dev/null 2>&1; then m=$(stat -c %Y "$1" 2>/dev/null || true)
  else m=$(stat -f %m "$1" 2>/dev/null || true); fi
  case "$m" in ''|*[!0-9]*) date +%s ;; *) printf '%s\n' "$m" ;; esac
}

# Serializes read-modify-write of one issue's state across processes and worktrees
# (several worktrees, and a background ci-watch --issue, write the same file). A mkdir
# lock holding its owner's pid; a crashed owner's lock is removed. Reentrant: a script
# holding it exports VIVI_STATE_LOCK_HELD so the state calls it makes do not wait on it.
vivi_state_lock() {
  local issue=$1 dir lock owner start
  [ "${VIVI_STATE_LOCK_HELD:-}" = "$issue" ] && return 0
  # One lock per process: fd 9 (or the mkdir lock's bookkeeping) holds one issue.
  [ -z "${VIVI_STATE_LOCK_HELD:-}" ] || vivi_die 2 "already holding the state lock of issue $VIVI_STATE_LOCK_HELD; one issue per process"
  dir=$(vivi_state_dir) || return 2
  # Where the kernel can lock (flock(1), util-linux: every common Linux), it does: the
  # lock dies with its holder, so there is no stale lock to judge. The mkdir lock below
  # is the fallback (macOS has no flock); the GitHub ubuntu runners admitted a second
  # writer into it under load, which a kernel lock cannot. The choice is by OS, never by
  # what happens to be on PATH: every process on one machine must take the same kind
  # (Homebrew can put a flock on a Mac's PATH for some shells and not others). The
  # lock's fd 9 is inherited by the short-lived children (state, jq, git); a holder that
  # is killed outright keeps it only until they exit.
  if [ "$(uname -s)" = Linux ] && command -v flock >/dev/null 2>&1; then
    exec 9>>"$dir/$issue.flock" || vivi_die 2 "cannot open the state lock $dir/$issue.flock"
    flock -w "${VIVI_STATE_LOCK_MAX_SEC:-60}" 9 || vivi_die 3 "the state of issue $issue is locked ($dir/$issue.flock); run again"
    export VIVI_STATE_LOCK_HELD=$issue
    VIVI_STATE_LOCK_FD=9
    return 0
  fi
  lock="$dir/$issue.lock"; start=$(date +%s)
  until mkdir "$lock" 2>/dev/null; do
    owner=$(cat "$lock/pid" 2>/dev/null || true)
    # A crashed writer's lock: its pid is gone AND it is far older than any write takes
    # (five minutes). The age matters: a pid read just before its owner released, then
    # found dead, would otherwise remove the NEXT writer's fresh lock.
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null \
       && [ $(( $(date +%s) - $(vivi_mtime "$lock") )) -ge 300 ]; then
      rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null || true; continue
    fi
    if [ $(( $(date +%s) - start )) -ge "${VIVI_STATE_LOCK_MAX_SEC:-60}" ]; then
      vivi_die 3 "the state of issue $issue is locked by pid ${owner:-?} ($lock); run again"
    fi
    sleep 0.1
  done
  echo "$$" > "$lock/pid"
  # Read it back: a lock that is not ours after all is never acted under.
  [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ] || vivi_die 3 "the state lock $lock changed hands while it was taken; run again"
  export VIVI_STATE_LOCK_HELD=$issue
  VIVI_STATE_LOCK_DIR=$lock
}
vivi_state_unlock() {
  if [ -n "${VIVI_STATE_LOCK_FD:-}" ]; then
    flock -u 9 2>/dev/null || true; exec 9>&-
    unset VIVI_STATE_LOCK_HELD VIVI_STATE_LOCK_FD
    return 0
  fi
  # Only a lock that still names this process is removed.
  if [ -n "${VIVI_STATE_LOCK_DIR:-}" ] && [ "$(cat "$VIVI_STATE_LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then
    rm -f "$VIVI_STATE_LOCK_DIR/pid"; rmdir "$VIVI_STATE_LOCK_DIR" 2>/dev/null || true
  fi
  unset VIVI_STATE_LOCK_HELD VIVI_STATE_LOCK_DIR
}

# Per-issue state (checkpoints, budgets, preflight records) lives in the git common dir,
# shared by every worktree of the clone, so a run resumed from another worktree, or a
# fresh one, finds it. Prints the directory, creating it.
vivi_state_dir() {
  local common
  common=$(git rev-parse --git-common-dir 2>/dev/null) || vivi_die 2 "not inside a git repository"
  common=$(cd "$common" && pwd)
  mkdir -p "$common/vivi-state" || vivi_die 2 "cannot create $common/vivi-state"
  printf '%s\n' "$common/vivi-state"
}

vivi_require() {
  local k
  for k in "$@"; do
    eval "[ -n \"\${$k:-}\" ]" || vivi_die 2 "repo.env is missing required key $k"
  done
}

# Prints the token file path to use, or nothing (exit 0) when there is no
# token file but GH_TOKEN/GITHUB_TOKEN is set in the environment, e.g. under
# CI, or when gh has auth configured (gh auth status succeeds). Dies with
# exit 2 only when no file, no env token, and gh has no auth.
vivi_token_file() {
  if [ -n "${VIVI_GH_TOKEN_FILE:-}" ] && [ -f "$VIVI_GH_TOKEN_FILE" ]; then echo "$VIVI_GH_TOKEN_FILE"; return; fi
  if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then echo ""; return; fi
  if gh auth status >/dev/null 2>&1; then echo ""; return; fi
  vivi_die 2 "no GitHub token: set VIVI_GH_TOKEN_FILE in repo.env to a readable file, or GH_TOKEN/GITHUB_TOKEN in the environment, or configure gh auth"
}

# VIVI_SLEEP is a test-only override: the test harness sets it to 0 so poll
# loops run instantly. Production never sets it.
vivi_sleep() { sleep "${VIVI_SLEEP-$1}"; }

vivi_gh() {
  # stdout and stderr are captured separately: gh's stderr must never be folded
  # into the JSON a caller parses. Transient classification looks at both, since
  # gh writes some diagnostics to stdout.
  local token_file token max=${VIVI_RETRY_MAX:-5} attempt=1 out err code errf
  token_file=$(vivi_token_file) || return 2
  if [ -n "$token_file" ]; then
    token=$(cat "$token_file" 2>/dev/null) || { echo "error: cannot read token file $token_file" >&2; return 2; }
  else
    token=${GH_TOKEN:-${GITHUB_TOKEN:-}}
  fi
  errf=$(mktemp) || { echo "error: cannot create a temp file" >&2; return 2; }
  while :; do
    code=0
    if [ -n "$token" ]; then
      out=$(GH_TOKEN="$token" gh "$@" 2>"$errf") || code=$?
    else
      out=$(gh "$@" 2>"$errf") || code=$?
    fi
    err=$(cat "$errf" 2>/dev/null) || err=""
    if [ "$code" -eq 0 ]; then
      rm -f "$errf"
      if [ -n "$err" ]; then printf '%s\n' "$err" >&2; fi
      printf '%s\n' "$out"
      return 0
    fi
    # A here-string, not printf | grep -q: grep -q exits at the first match, and under
    # pipefail a printf still writing a large answer then dies of SIGPIPE (skills#25).
    if grep -qiE 'rate limit|HTTP 50[234]|timeout|timed out|connection reset|Could not resolve host' <<<"$err"$'\n'"$out"; then
      if [ "$attempt" -ge "$max" ]; then
        rm -f "$errf"
        echo "gh: transient failure after $max attempts: $*" >&2
        if [ -n "$err" ]; then printf '%s\n' "$err" >&2; fi
        if [ -n "$out" ]; then printf '%s\n' "$out" >&2; fi
        return 3
      fi
      echo "gh: transient error, retry $attempt/$max: $*" >&2
      vivi_sleep $((attempt * 5)); attempt=$((attempt+1)); continue
    fi
    rm -f "$errf"
    if [ -n "$out" ]; then printf '%s\n' "$out" >&2; fi
    if [ -n "$err" ]; then printf '%s\n' "$err" >&2; fi
    return "$code"
  done
}
