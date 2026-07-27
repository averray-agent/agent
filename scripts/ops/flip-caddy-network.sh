#!/usr/bin/env bash

set -euo pipefail

install_caddy_candidate_in_place() {
  local candidate_path=$1
  local caddyfile_path=$2

  # Caddy bind-mounts this single file. Replacing the pathname with mv(1)
  # changes the host inode while the running container stays attached to the
  # old inode. Copy into the existing file so the mount sees the new bytes.
  cp "$candidate_path" "$caddyfile_path"
}

restore_caddy_backup_in_place() {
  local backup_path=$1
  local caddyfile_path=$2

  # Preserve the mounted inode on rollback for the same reason as install.
  cp -p "$backup_path" "$caddyfile_path"
}

if [[ "${FLIP_CADDY_NETWORK_LIBRARY_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CADDYFILE=${CADDYFILE:-/srv/agent-stack/Caddyfile}
CADDY_CONTAINER=${CADDY_CONTAINER:-agent-caddy}
LOCK_FILE=${LOCK_FILE:-/run/lock/averray-network-cutover.lock}
PUBLIC_HEALTH_URL=${PUBLIC_HEALTH_URL:-https://api.averray.com/health}
CADDY_NETWORK_STATE_FILE=${CADDY_NETWORK_STATE_FILE:-/srv/agent-stack/.deploy-state/caddy-network-selection.json}
TARGET=${1:-}

if [[ "$TARGET" == "status" ]]; then
  STACK_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)" "$SCRIPT_DIR/run-caddy-network-selection.sh" status \
    --state "$CADDY_NETWORK_STATE_FILE" \
    --live-caddy "$CADDYFILE"
  public_health=$(curl -fsS "$PUBLIC_HEALTH_URL")
  printf '%s' "$public_health" | jq '{
    publicStatus: .status,
    publicChainId: ([.. | objects | .chainId? // empty] | first // null)
  }'
  exit 0
fi

if [[ "$TARGET" != "mainnet" && "$TARGET" != "testnet" ]]; then
  echo "Usage: flip-caddy-network.sh <mainnet|testnet|status>" >&2
  exit 2
fi

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
selected_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
selected_by=${CUTOVER_ACTOR:-${SUDO_USER:-$(id -un)}}
execution_user=$(id -un)
cutover_host=$(hostname -f 2>/dev/null || hostname)
source_revision=$(git -C "$SCRIPT_DIR/../.." rev-parse HEAD)
operation_id=${CUTOVER_OPERATION_ID:-"caddy-cutover-$timestamp"}
cutover_reason=${CUTOVER_REASON:-"guarded Caddy cutover to $TARGET"}
candidate=$(mktemp "$dir/.Caddyfile.cutover.XXXXXX")
backup="$dir/Caddyfile.pre-${TARGET}-${timestamp}"
container_candidate="/tmp/averray-caddy-cutover-${timestamp}-$$"
cp -p "$CADDYFILE" "$backup"

cleanup() {
  rm -f "$candidate"
  docker exec "$CADDY_CONTAINER" rm -f "$container_candidate" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

render_meta=$(STACK_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)" \
  "$SCRIPT_DIR/run-caddy-network-selection.sh" render-target \
  --network "$TARGET" \
  --input "$CADDYFILE" \
  --output "$candidate")
previous_network=$(printf '%s' "$render_meta" | jq -er '.current')
printf '%s\n' "$render_meta"
chmod --reference="$CADDYFILE" "$candidate"
chown --reference="$CADDYFILE" "$candidate"

# Validate the complete candidate before touching the mounted live file.
docker cp "$candidate" "$CADDY_CONTAINER:$container_candidate"
if ! docker exec "$CADDY_CONTAINER" caddy validate --config "$container_candidate" --adapter caddyfile; then
  echo "Candidate Caddy configuration failed validation; live configuration unchanged" >&2
  exit 1
fi
docker exec "$CADDY_CONTAINER" rm -f "$container_candidate"

# This copy is intentionally in-place (not atomic) because Caddy bind-mounts a
# single file. The candidate is already validated above, and `caddy reload`
# validates again while retaining the old running config on failure.
install_caddy_candidate_in_place "$candidate" "$CADDYFILE"

rollback() {
  restore_caddy_backup_in_place "$backup" "$CADDYFILE"
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
}

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

if ! STACK_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)" "$SCRIPT_DIR/run-caddy-network-selection.sh" set \
  --state "$CADDY_NETWORK_STATE_FILE" \
  --network "$TARGET" \
  --previous-network "$previous_network" \
  --selected-at "$selected_at" \
  --selected-by "$selected_by" \
  --execution-user "$execution_user" \
  --host "$cutover_host" \
  --source "flip-caddy-network.sh" \
  --source-revision "$source_revision" \
  --operation-id "$operation_id" \
  --reason "$cutover_reason"; then
  rollback
  echo "Durable Caddy network selection write failed; original route restored" >&2
  exit 1
fi

echo "caddy_route=$TARGET"
echo "public_chain_id=$expected_chain"
echo "rollback_file=$backup"
echo "selection_file=$CADDY_NETWORK_STATE_FILE"
