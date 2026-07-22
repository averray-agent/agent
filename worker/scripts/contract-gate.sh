#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
worker_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
harness_repo=${HARNESS_REPO:-"$HOME/repo/agent-harness"}
harness_bin=${HARNESS_BIN:-"$harness_repo/.venv/bin/harness"}
gate_tmp=$(mktemp -d "${TMPDIR:-/tmp}/averray-worker-contract.XXXXXX")
trap 'rm -rf "$gate_tmp"' EXIT HUP INT TERM

if [ ! -x "$harness_bin" ]; then
  echo "contract gate: harness executable not found: $harness_bin" >&2
  exit 2
fi

intent_path="$gate_tmp/intent.json"
node "$worker_root/bin/emit-intent.mjs" \
  "$worker_root/examples/github-issue-job.json" \
  --workspace /tmp/x > "$intent_path"

(
  cd "$harness_repo"
  HARNESS_PROFILES_ROOT="$worker_root/profiles" "$harness_bin" validate "$intent_path"
)
