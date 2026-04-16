#!/usr/bin/env bash
#
# Wire the tracked hooks in `.githooks/` into the local git checkout.
#
# Run once after cloning. Uses `core.hooksPath` so the hook lives in-repo
# (versioned, reviewable) rather than in `.git/hooks/` (per-clone, invisible).
#
# Usage:
#   ./scripts/install-hooks.sh
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"

hooks_dir="${repo_root}/.githooks"
if [[ ! -d "$hooks_dir" ]]; then
  echo "Missing hooks directory at $hooks_dir" >&2
  exit 1
fi

# chmod +x so git actually runs them.
find "$hooks_dir" -type f -exec chmod +x {} \;

git -C "$repo_root" config core.hooksPath .githooks
echo "git hooks installed (core.hooksPath = .githooks)"
echo ""
echo "Active hooks:"
ls -1 "$hooks_dir" | sed 's/^/  /'
