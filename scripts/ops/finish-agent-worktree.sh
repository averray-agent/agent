#!/usr/bin/env bash
set -euo pipefail

# Remove a merged task worktree and delete its local/remote task branch. This
# refuses to proceed unless the branch is either an ancestor of the remote base
# branch or has a merged GitHub pull request. The GitHub check covers merge
# queue/squash merges, where main contains the branch content but is not a
# descendant of the source branch tip.

REMOTE=${REMOTE:-origin}
BASE_BRANCH=${BASE_BRANCH:-main}
DELETE_REMOTE=${DELETE_REMOTE:-1}

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./scripts/ops/finish-agent-worktree.sh <branch>

Example:
  ./scripts/ops/finish-agent-worktree.sh claude/runs-detail-polish

Environment:
  REMOTE=origin        remote to fetch from
  BASE_BRANCH=main     base branch that must contain the task branch
  DELETE_REMOTE=1      delete the remote task branch when present
USAGE
}

github_repo_from_remote() {
  local remote_url repo
  remote_url="$(git remote get-url "$REMOTE" 2>/dev/null || true)"

  case "$remote_url" in
    git@github.com:*.git)
      repo="${remote_url#git@github.com:}"
      repo="${repo%.git}"
      ;;
    git@github.com:*)
      repo="${remote_url#git@github.com:}"
      ;;
    https://github.com/*.git)
      repo="${remote_url#https://github.com/}"
      repo="${repo%.git}"
      ;;
    https://github.com/*)
      repo="${remote_url#https://github.com/}"
      ;;
    *)
      repo=""
      ;;
  esac

  if [[ "$repo" == */* ]]; then
    printf '%s\n' "$repo"
  fi
}

branch_has_merged_pr() {
  local repo state
  repo="$(github_repo_from_remote)"
  if [[ -z "$repo" ]]; then
    return 1
  fi
  if ! command -v gh >/dev/null 2>&1; then
    return 1
  fi

  state="$(
    GH_PAGER= gh pr view "$branch" \
      --repo "$repo" \
      --json state,mergedAt \
      --jq 'if (.state == "MERGED" or .mergedAt != null) then "merged" else "not_merged" end' \
      2>/dev/null || true
  )"

  [[ "$state" == "merged" ]]
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

branch="$1"
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

current_branch="$(git branch --show-current)"
if [[ "$current_branch" == "$branch" ]]; then
  echo "Refusing to remove the worktree currently running this script." >&2
  echo "Run this from the primary checkout or another worktree instead." >&2
  exit 1
fi

if [[ "$branch" == "$BASE_BRANCH" || "$branch" == "$REMOTE/$BASE_BRANCH" ]]; then
  echo "Refusing to finish the base branch: $branch" >&2
  exit 1
fi

echo "Refreshing $REMOTE/$BASE_BRANCH"
git fetch "$REMOTE" "$BASE_BRANCH" --prune

if ! git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "Local branch not found: $branch" >&2
  exit 1
fi

if git merge-base --is-ancestor "$branch" "$REMOTE/$BASE_BRANCH"; then
  echo "$branch is merged into $REMOTE/$BASE_BRANCH"
elif branch_has_merged_pr; then
  echo "$branch has a merged GitHub pull request"
else
  echo "Refusing to delete $branch because it is not merged into $REMOTE/$BASE_BRANCH and no merged GitHub PR was found" >&2
  exit 1
fi

worktree_path=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      current_path="${line#worktree }"
      ;;
    branch\ refs/heads/"$branch")
      worktree_path="$current_path"
      break
      ;;
  esac
done < <(git worktree list --porcelain)

if [[ -n "$worktree_path" ]]; then
  echo "Removing worktree $worktree_path"
  git worktree remove "$worktree_path"
fi

echo "Deleting local branch $branch"
git branch -d "$branch"

if [[ "$DELETE_REMOTE" == "1" ]] && git show-ref --verify --quiet "refs/remotes/$REMOTE/$branch"; then
  echo "Deleting remote branch $REMOTE/$branch"
  git push "$REMOTE" --delete "$branch"
fi

"$repo_root/scripts/ops/sync-local-main.sh"

echo "Finished $branch"
