#!/usr/bin/env bash
set -euo pipefail

# Start a new agent/task branch in the current worktree from the latest remote
# main. Prefer start-agent-worktree.sh for multi-agent work.

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
  BASE_BRANCH=main    remote base branch to create the new branch from
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
git fetch "$REMOTE" "$BASE_BRANCH" --prune

echo "Creating $new_branch from $(git rev-parse --short "$REMOTE/$BASE_BRANCH")"
git switch -c "$new_branch" "$REMOTE/$BASE_BRANCH"

echo "Ready on $new_branch"
