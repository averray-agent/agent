#!/usr/bin/env bash

set -euo pipefail
set +x

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FLIP_CADDY_NETWORK_SCRIPT=${FLIP_CADDY_NETWORK_SCRIPT:-"$SCRIPT_DIR/flip-caddy-network.sh"}
TESTNET_BACKEND_ENV_FILE=${TESTNET_BACKEND_ENV_FILE:-/run/agent-stack/backend.env}
MAINNET_BACKEND_ENV_FILE=${MAINNET_BACKEND_ENV_FILE:-/run/agent-stack-mainnet/backend.env}

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to resolve the live backend env." >&2
  exit 1
fi

status=$("$FLIP_CADDY_NETWORK_SCRIPT" status)
selection=$(
  printf '%s' "$status" | jq -ser '
    if length != 2 then
      error("expected selector and public-health objects")
    elif .[0].consistent != true then
      error("durable selector disagrees with the live Caddy route")
    elif .[0].selectedNetwork != .[0].liveRoute then
      error("selected network does not match the live Caddy route")
    elif .[1].publicStatus != "ok" then
      error("public API is not healthy")
    elif .[0].expectedChainId != .[1].publicChainId then
      error("public chain does not match the durable selector")
    else
      {
        network: .[0].selectedNetwork,
        chainId: .[1].publicChainId
      }
    end
  '
)

network=$(printf '%s' "$selection" | jq -er '.network')
chain_id=$(printf '%s' "$selection" | jq -er '.chainId')

case "$network:$chain_id" in
  testnet:420420417)
    backend_env_file=$TESTNET_BACKEND_ENV_FILE
    ;;
  mainnet:420420419)
    backend_env_file=$MAINNET_BACKEND_ENV_FILE
    ;;
  *)
    echo "Unsupported live network/chain pair: $network/$chain_id" >&2
    exit 1
    ;;
esac

if [[ ! -r "$backend_env_file" ]]; then
  echo "Live $network backend env is not readable: $backend_env_file" >&2
  exit 1
fi

printf '%s\n' "$backend_env_file"
