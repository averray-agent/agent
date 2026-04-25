#!/usr/bin/env bash
set -euo pipefail

# Start a new agent/task branch from the latest remote main.
# This prevents agents from accidentally branching off a stale local checkout.

REMOTE=${REMOTE:-origin}
BASE_BRANCH=${BASE_BRANCH:-main}

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./scripts/ops/start-agent-branch.sh <new-branch>

Example:
  ./scripts/ops/start-agent-branch.sh codex/fix-runs-empty-state

Environment:
  REMOTE=origin       remote to fetch from
  BASE_BRANCH=main    base branch to refresh before creating the new branch
USAGE
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

new_branch="$1"

if [[ "$new_branch" == "$BASE_BRANCH" || "$new_branch" == "$REMOTE/$BASE_BRANCH" ]]; then
  echo "Refusing to create a task branch named like the base branch: $new_branch" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$new_branch"; then
  echo "Local branch already exists: $new_branch" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/remotes/$REMOTE/$new_branch"; then
  echo "Remote branch already exists: $REMOTE/$new_branch" >&2
  exit 1
fi

tracked_changes="$(git status --porcelain --untracked-files=no)"
if [[ -n "$tracked_changes" ]]; then
  echo "Tracked working tree changes are present. Commit, stash, or discard them before starting a new branch:" >&2
  echo "$tracked_changes" >&2
  exit 1
fi

echo "Refreshing $REMOTE/$BASE_BRANCH"
git fetch "$REMOTE" --prune
git switch "$BASE_BRANCH"
git pull --ff-only "$REMOTE" "$BASE_BRANCH"

echo "Creating $new_branch from $(git rev-parse --short HEAD)"
git switch -c "$new_branch"

echo "Ready on $new_branch"
