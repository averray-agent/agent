#!/usr/bin/env bash

set -euo pipefail

TARGET=${1:-}
if [[ "$TARGET" != "mainnet" && "$TARGET" != "testnet" ]]; then
  echo "Usage: flip-caddy-network.sh <mainnet|testnet>" >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CADDYFILE=${CADDYFILE:-/srv/agent-stack/Caddyfile}
CADDY_CONTAINER=${CADDY_CONTAINER:-agent-caddy}
LOCK_FILE=${LOCK_FILE:-/run/lock/averray-network-cutover.lock}
PUBLIC_HEALTH_URL=${PUBLIC_HEALTH_URL:-https://api.averray.com/health}

if [[ "$TARGET" == "mainnet" ]]; then
  internal_health=http://127.0.0.1:18787/health
  expected_chain=420420419
else
  internal_health=http://127.0.0.1:8787/health
  expected_chain=420420417
fi

exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Another network cutover operation holds $LOCK_FILE" >&2; exit 1; }

health=$(curl -fsS "$internal_health")
printf '%s' "$health" | jq -e --arg chain "$expected_chain" \
  '[.. | objects | .chainId? // empty | tostring] | index($chain) != null' >/dev/null \
  || { echo "Target internal health does not report chainId $expected_chain" >&2; exit 1; }

dir=$(dirname "$CADDYFILE")
timestamp=$(date -u +"%Y%m%d-%H%M%S")
candidate=$(mktemp "$dir/.Caddyfile.cutover.XXXXXX")
backup="$dir/Caddyfile.pre-${TARGET}-${timestamp}"
cp -p "$CADDYFILE" "$backup"
trap 'rm -f "$candidate"' EXIT INT TERM

node "$SCRIPT_DIR/render-caddy-cutover.mjs" "$CADDYFILE" "$candidate" "$TARGET"
chmod --reference="$CADDYFILE" "$candidate"
chown --reference="$CADDYFILE" "$candidate"
mv "$candidate" "$CADDYFILE"

rollback() {
  cp -p "$backup" "$CADDYFILE"
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
}

if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  rollback
  echo "Candidate Caddy configuration failed validation; original restored" >&2
  exit 1
fi
if ! docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  rollback
  echo "Caddy reload failed; original restored" >&2
  exit 1
fi

if ! public_health=$(curl -fsS --retry 4 --retry-delay 1 "$PUBLIC_HEALTH_URL"); then
  rollback
  echo "Public health failed after cutover; original route restored" >&2
  exit 1
fi
if ! printf '%s' "$public_health" | jq -e --arg chain "$expected_chain" \
  '[.. | objects | .chainId? // empty | tostring] | index($chain) != null' >/dev/null; then
  rollback
  echo "Public health did not report chainId $expected_chain; original route restored" >&2
  exit 1
fi

echo "caddy_route=$TARGET"
echo "public_chain_id=$expected_chain"
echo "rollback_file=$backup"
