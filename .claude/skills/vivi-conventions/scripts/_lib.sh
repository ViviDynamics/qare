# Shared functions for Vivi Dynamics skill scripts. Source, do not execute.
# bash 3.2 compatible. Dependencies: gh, jq, git.

vivi_die() { local code=$1; shift; printf '{"error":%s}\n' "$(printf '%s' "$*" | jq -Rs .)"; echo "error: $*" >&2; exit "$code"; }

vivi_root() {
  git rev-parse --show-toplevel 2>/dev/null || vivi_die 2 "not inside a git repository"
}

vivi_load_env() {
  local root file line key val
  root=$(vivi_root) || exit 2
  file="$root/repo.env"
  [ -f "$file" ] || vivi_die 2 "repo.env not found at $file (see ADOPTING.md)"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in VIVI_*=*) ;; *) continue;; esac
    key=${line%%=*}; val=${line#*=}
    # Drop an inline comment: whitespace followed by # and the rest of the line.
    case "$val" in *[[:space:]]#*) val=${val%%[[:space:]]#*};; esac
    while :; do case "$val" in *[[:space:]]) val=${val%?};; *) break;; esac; done
    val=${val%\"}; val=${val#\"}
    val=${val//\$HOME/$HOME}
    export "$key=$val"
  done < "$file"
  export VIVI_ROOT="$root"
}

vivi_require() {
  local k
  for k in "$@"; do
    eval "[ -n \"\${$k:-}\" ]" || vivi_die 2 "repo.env is missing required key $k"
  done
}

vivi_token_file() {
  local org
  if [ -n "${VIVI_GH_TOKEN_FILE:-}" ] && [ -f "$VIVI_GH_TOKEN_FILE" ]; then echo "$VIVI_GH_TOKEN_FILE"; return; fi
  if [ -f "$HOME/Workspaces/.gh_token" ]; then echo "$HOME/Workspaces/.gh_token"; return; fi
  org=${VIVI_REPO%%/*}
  if [ -n "$org" ] && [ -f "$HOME/Workspaces/$org/.gh_token" ]; then echo "$HOME/Workspaces/$org/.gh_token"; return; fi
  vivi_die 2 "no GitHub token file found (VIVI_GH_TOKEN_FILE, ~/Workspaces/.gh_token, ~/Workspaces/<org>/.gh_token)"
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
  token=$(cat "$token_file" 2>/dev/null) || { echo "error: cannot read token file $token_file" >&2; return 2; }
  errf=$(mktemp) || { echo "error: cannot create a temp file" >&2; return 2; }
  while :; do
    code=0
    out=$(GH_TOKEN="$token" gh "$@" 2>"$errf") || code=$?
    err=$(cat "$errf" 2>/dev/null) || err=""
    if [ "$code" -eq 0 ]; then
      rm -f "$errf"
      if [ -n "$err" ]; then printf '%s\n' "$err" >&2; fi
      printf '%s\n' "$out"
      return 0
    fi
    if printf '%s\n%s' "$err" "$out" | grep -qiE 'rate limit|HTTP 50[234]|timeout|timed out|connection reset|Could not resolve'; then
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
