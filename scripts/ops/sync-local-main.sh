#!/usr/bin/env bash
set -euo pipefail

# Fast-forward the local base branch to the latest remote base branch without
# requiring the caller to be on main. If main is checked out in another worktree,
# the pull runs in that worktree.

REMOTE=${REMOTE:-origin}
BASE_BRANCH=${BASE_BRANCH:-main}

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

echo "Fetching $REMOTE/$BASE_BRANCH"
git fetch "$REMOTE" "$BASE_BRANCH" --prune

main_worktree=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      current_path="${line#worktree }"
      ;;
    branch\ refs/heads/"$BASE_BRANCH")
      main_worktree="$current_path"
      break
      ;;
  esac
done < <(git worktree list --porcelain)

if [[ -n "$main_worktree" ]]; then
  tracked_changes="$(git -C "$main_worktree" status --porcelain --untracked-files=no)"
  if [[ -n "$tracked_changes" ]]; then
    echo "Refusing to sync $BASE_BRANCH because tracked changes exist in $main_worktree:" >&2
    echo "$tracked_changes" >&2
    exit 1
  fi

  echo "Fast-forwarding $BASE_BRANCH in $main_worktree"
  git -C "$main_worktree" pull --ff-only "$REMOTE" "$BASE_BRANCH"
else
  if git show-ref --verify --quiet "refs/heads/$BASE_BRANCH"; then
    echo "Fast-forwarding local $BASE_BRANCH without checking it out"
    git fetch "$REMOTE" "$BASE_BRANCH:$BASE_BRANCH"
  else
    echo "Creating local $BASE_BRANCH from $REMOTE/$BASE_BRANCH"
    git branch --track "$BASE_BRANCH" "$REMOTE/$BASE_BRANCH"
  fi
fi

echo "$BASE_BRANCH is synced to $(git rev-parse --short "$REMOTE/$BASE_BRANCH")"
