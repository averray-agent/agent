#!/usr/bin/env bash
set -euo pipefail

# Poll GitHub Actions for successful production deploys and fast-forward local
# main after a new deploy succeeds. This never switches away from the caller's
# current task branch; sync-local-main.sh handles the local main update.

REMOTE=${REMOTE:-origin}
BASE_BRANCH=${BASE_BRANCH:-main}
WORKFLOW=${WORKFLOW:-deploy-production.yml}
INTERVAL=${INTERVAL:-60}
ONCE=${ONCE:-0}

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./scripts/ops/watch-production-sync.sh [--once]

Environment:
  REMOTE=origin                         git remote to sync from
  BASE_BRANCH=main                      deployed branch to watch
  WORKFLOW=deploy-production.yml         GitHub Actions workflow file/name
  INTERVAL=60                           polling interval in seconds
  GITHUB_REPOSITORY=owner/name           optional; inferred from origin
  STATE_DIR=.codex/state                 local state directory
  ONCE=1                                check once, then exit
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once)
      ONCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

infer_repo() {
  local remote_url repo
  remote_url="$(git remote get-url "$REMOTE")"

  case "$remote_url" in
    https://github.com/*)
      repo="${remote_url#https://github.com/}"
      ;;
    git@github.com:*)
      repo="${remote_url#git@github.com:}"
      ;;
    *)
      echo "Could not infer GitHub repository from $REMOTE URL: $remote_url" >&2
      echo "Set GITHUB_REPOSITORY=owner/name and try again." >&2
      exit 1
      ;;
  esac

  repo="${repo%.git}"
  echo "$repo"
}

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

require_command gh
require_command git

GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-$(infer_repo)}
STATE_DIR=${STATE_DIR:-"$repo_root/.codex/state"}
last_file="$STATE_DIR/last-production-sync"

mkdir -p "$STATE_DIR"

check_once() {
  local line status conclusion head_sha run_id run_url previous_synced local_main

  line="$(
    gh run list \
      --repo "$GITHUB_REPOSITORY" \
      --workflow "$WORKFLOW" \
      --branch "$BASE_BRANCH" \
      --limit 1 \
      --json databaseId,status,conclusion,headSha,url \
      --jq 'if length == 0 then "" else .[0] | [.status, .conclusion, .headSha, (.databaseId | tostring), .url] | @tsv end'
  )"

  if [[ -z "$line" ]]; then
    echo "No $WORKFLOW runs found for $GITHUB_REPOSITORY@$BASE_BRANCH"
    return 0
  fi

  IFS=$'\t' read -r status conclusion head_sha run_id run_url <<<"$line"

  if [[ "$status" != "completed" || "$conclusion" != "success" ]]; then
    echo "Latest deploy is not successful yet: run=$run_id status=$status conclusion=${conclusion:-none}"
    return 0
  fi

  previous_synced=""
  if [[ -f "$last_file" ]]; then
    previous_synced="$(<"$last_file")"
  fi

  local_main=""
  if git show-ref --verify --quiet "refs/heads/$BASE_BRANCH"; then
    local_main="$(git rev-parse "$BASE_BRANCH")"
  fi

  if [[ "$previous_synced" == "$head_sha" && "$local_main" == "$head_sha" ]]; then
    echo "Already synced deployed $BASE_BRANCH at ${head_sha:0:7}"
    return 0
  fi

  echo "Syncing local $BASE_BRANCH to successful deploy ${head_sha:0:7} from run $run_id"
  "$repo_root/scripts/ops/sync-local-main.sh"

  if git show-ref --verify --quiet "refs/heads/$BASE_BRANCH"; then
    local_main="$(git rev-parse "$BASE_BRANCH")"
  else
    local_main=""
  fi

  if [[ "$local_main" != "$head_sha" ]]; then
    echo "Warning: synced $BASE_BRANCH to ${local_main:0:7}, but latest deploy is ${head_sha:0:7}" >&2
    echo "Deploy URL: $run_url" >&2
    return 1
  fi

  printf '%s\n' "$head_sha" > "$last_file"
  echo "Synced local $BASE_BRANCH to deployed ${head_sha:0:7}"
}

if [[ "$ONCE" == "1" ]]; then
  check_once
  exit 0
fi

echo "Watching $GITHUB_REPOSITORY $WORKFLOW on $BASE_BRANCH every ${INTERVAL}s"
echo "State: $last_file"

while true; do
  check_once || true
  sleep "$INTERVAL"
done
