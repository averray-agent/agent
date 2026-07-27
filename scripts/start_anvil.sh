#!/usr/bin/env bash
set -euo pipefail


HOST="${ANVIL_HOST:-127.0.0.1}"
PORT="${ANVIL_PORT:-8545}"
MNEMONIC="${ANVIL_MNEMONIC:-test test test test test test test test test test test junk}"

exec anvil --host "$HOST" --port "$PORT" --mnemonic "$MNEMONIC"

