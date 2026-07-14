#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-"$REPO_ROOT/deploy/docker-compose.mainnet.yml"}
PROJECT_NAME=${PROJECT_NAME:-agent-mainnet}
MAINNET_ROOT=${MAINNET_ROOT:-/srv/agent-stack-mainnet}
HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-240}

"$SCRIPT_DIR/preflight-mainnet-sidecar.sh"

mkdir -p "$MAINNET_ROOT/redis"
chmod 0700 "$MAINNET_ROOT" "$MAINNET_ROOT/redis"

testnet_before=$(mktemp)
trap 'rm -f "$testnet_before"' EXIT INT TERM
for container in agent-backend agent-indexer agent-caddy agent-postgres agent-redis; do
  docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' "$container" >> "$testnet_before"
done

compose=(docker compose --project-name "$PROJECT_NAME" -f "$COMPOSE_FILE")
"${compose[@]}" build mainnet-backend mainnet-indexer
"${compose[@]}" up -d mainnet-redis mainnet-backend mainnet-indexer

deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
for container in agent-mainnet-redis agent-mainnet-backend agent-mainnet-indexer; do
  while [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)" != "healthy" ]]; do
    if (( SECONDS >= deadline )); then
      docker logs --tail 160 "$container" >&2 || true
      echo "Timed out waiting for $container to become healthy" >&2
      exit 1
    fi
    sleep 3
  done
done

backend_health=$(curl -fsS http://127.0.0.1:18787/health)
printf '%s' "$backend_health" | jq -e \
  '[.. | objects | .chainId? // empty | tostring] | index("420420419") != null' >/dev/null \
  || { echo "Internal mainnet backend health does not report chainId 420420419" >&2; exit 1; }
curl -fsS http://127.0.0.1:52069/health >/dev/null

testnet_after=$(mktemp)
trap 'rm -f "$testnet_before" "$testnet_after"' EXIT INT TERM
for container in agent-backend agent-indexer agent-caddy agent-postgres agent-redis; do
  docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' "$container" >> "$testnet_after"
done
cmp -s "$testnet_before" "$testnet_after" \
  || { echo "Live testnet container identity changed while starting mainnet sidecar" >&2; exit 1; }

echo "mainnet_sidecar=healthy"
echo "backend=http://127.0.0.1:18787"
echo "indexer=http://127.0.0.1:52069"
echo "testnet_containers=unchanged"
