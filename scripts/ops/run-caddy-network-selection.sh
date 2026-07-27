#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
STACK_ROOT=${STACK_ROOT:-$(cd "$APP_ROOT/.." && pwd)}
CADDY_SELECTION_NODE_IMAGE=${CADDY_SELECTION_NODE_IMAGE:-node:22-bookworm-slim}
SELECTION_TOOL="$SCRIPT_DIR/caddy-network-selection.mjs"

if command -v node >/dev/null 2>&1; then
  exec node "$SELECTION_TOOL" "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "caddy network selection requires node or docker" >&2
  exit 1
fi

# The production host intentionally carries no Node installation. Run the
# dependency-free selector in the already-cached Node image while preserving
# the absolute /srv/agent-stack paths supplied by the caller.
exec docker run --rm \
  -v "$STACK_ROOT:$STACK_ROOT" \
  -w "$APP_ROOT" \
  "$CADDY_SELECTION_NODE_IMAGE" \
  node "$SELECTION_TOOL" "$@"
