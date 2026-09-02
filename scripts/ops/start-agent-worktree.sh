#!/usr/bin/env bash
set -euo pipefail

# Create a dedicated task worktree from the latest remote main. This keeps the
# primary checkout free for syncing and prevents agents from branching off stale
# local state.

REMOTE=${REMOTE:-origin}
BASE_BRANCH=${BASE_BRANCH:-main}

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./scripts/ops/start-agent-worktree.sh <new-branch> [worktree-path]

Examples:
  ./scripts/ops/start-agent-worktree.sh codex/github-pr-verifier
  ./scripts/ops/start-agent-worktree.sh claude/runs-detail-polish

Environment:
  REMOTE=origin       remote to fetch from
  BASE_BRANCH=main    base branch to create worktrees from
USAGE
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

new_branch="$1"
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ "$new_branch" == "$BASE_BRANCH" || "$new_branch" == "$REMOTE/$BASE_BRANCH" ]]; then
  echo "Refusing to create a task branch named like the base branch: $new_branch" >&2
  exit 1
fi

if [[ "$new_branch" != */* ]]; then
  echo "Use an owner prefix, for example codex/$new_branch or claude/$new_branch" >&2
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

owner="${new_branch%%/*}"
slug="${new_branch#*/}"

if [[ $# -eq 2 ]]; then
  worktree_path="$2"
else
  case "$owner" in
    claude)
      worktree_path=".claude/worktrees/$slug"
      ;;
    codex)
      worktree_path=".codex/worktrees/$slug"
      ;;
    *)
      worktree_path=".agent-worktrees/$owner/$slug"
      ;;
  esac
fi

if [[ -e "$worktree_path" ]]; then
  echo "Worktree path already exists: $worktree_path" >&2
  exit 1
fi

echo "Refreshing $REMOTE/$BASE_BRANCH"
git fetch "$REMOTE" "$BASE_BRANCH" --prune

echo "Creating worktree $worktree_path from $REMOTE/$BASE_BRANCH"
git worktree add -b "$new_branch" "$worktree_path" "$REMOTE/$BASE_BRANCH"

echo
echo "Ready:"
echo "  branch:   $new_branch"
echo "  worktree: $repo_root/$worktree_path"
echo
echo "Next:"
echo "  cd $repo_root/$worktree_path"
