#!/usr/bin/env bash

set -euo pipefail
set +x

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BACKEND_ENV_FILE=$("$SCRIPT_DIR/resolve-live-backend-env.sh")
MAINNET_BACKEND_ENV_FILE=${MAINNET_BACKEND_ENV_FILE:-/run/agent-stack-mainnet/backend.env}

if [[ "$BACKEND_ENV_FILE" == "$MAINNET_BACKEND_ENV_FILE" ]]; then
  BACKEND_CONTAINER=${BACKEND_CONTAINER:-agent-mainnet-backend}
else
  BACKEND_CONTAINER=${BACKEND_CONTAINER:-agent-backend}
fi

export BACKEND_ENV_FILE
export BACKEND_CONTAINER

exec "$SCRIPT_DIR/collect-observability-proof.sh"
