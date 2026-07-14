#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}
COMPOSE_FILE=${COMPOSE_FILE:-"$REPO_ROOT/deploy/docker-compose.mainnet.yml"}
BACKEND_ENV=${BACKEND_ENV:-/run/agent-stack-mainnet/backend.env}
INDEXER_ENV=${INDEXER_ENV:-/run/agent-stack-mainnet/indexer.env}
AWS_CONFIG=${AWS_CONFIG:-/etc/agent-stack-mainnet/aws-config}
CERT_DIR=${CERT_DIR:-/etc/agent-stack-mainnet/roles-anywhere}
DEPLOYMENT_FILE=${DEPLOYMENT_FILE:-"$REPO_ROOT/deployments/mainnet.json"}
OWNER_FILE=${OWNER_FILE:-"$REPO_ROOT/deployments/mainnet-multisig-owner.json"}

fail() {
  echo "mainnet sidecar preflight: $*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "required file missing: $1"
}

require_env_value() {
  local file="$1"
  local key="$2"
  local expected="$3"
  local actual
  actual=$(awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$file")
  [[ "$actual" == "$expected" ]] || fail "$file must set $key=$expected"
}

require_mode_owner() {
  local file="$1"
  local mode owner group
  mode=$(stat -c '%a' "$file")
  owner=$(stat -c '%U' "$file")
  group=$(stat -c '%G' "$file")
  [[ "$mode" == "400" && "$owner" == "root" && "$group" == "root" ]] \
    || fail "$file must be mode 0400 root:root (found $mode $owner:$group)"
}

require_file "$COMPOSE_FILE"
require_file "$BACKEND_ENV"
require_file "$INDEXER_ENV"
require_file "$AWS_CONFIG"
require_file "$DEPLOYMENT_FILE"
require_file "$OWNER_FILE"

for stem in signer jwt-signer badge-receipt-signer; do
  cert="$CERT_DIR/${stem}-cert.pem"
  key="$CERT_DIR/${stem}-key.pem"
  require_file "$cert"
  require_file "$key"
  require_mode_owner "$cert"
  require_mode_owner "$key"
  openssl x509 -checkend 604800 -noout -in "$cert" >/dev/null \
    || fail "$cert expires in less than seven days"
  cert_pub=$(openssl x509 -pubkey -noout -in "$cert" | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | awk '{print $1}')
  key_pub=$(openssl pkey -in "$key" -pubout -outform DER 2>/dev/null | sha256sum | awk '{print $1}')
  [[ "$cert_pub" == "$key_pub" ]] || fail "$cert and $key do not match"
done

for profile in averray-signer averray-jwt-signer averray-badge-receipt-signer; do
  count=$(grep -Fxc "[profile $profile]" "$AWS_CONFIG" || true)
  [[ "$count" == "1" ]] || fail "$AWS_CONFIG must contain exactly one [profile $profile] block"
done
if grep -qi 'testnet' "$AWS_CONFIG"; then
  fail "$AWS_CONFIG contains a testnet reference"
fi

require_env_value "$BACKEND_ENV" AUTH_CHAIN_ID 420420419
require_env_value "$BACKEND_ENV" RPC_URL https://eth-rpc.polkadot.io/
require_env_value "$BACKEND_ENV" REDIS_URL redis://mainnet-redis:6379
require_env_value "$BACKEND_ENV" REDIS_NAMESPACE agent-platform-mainnet
require_env_value "$BACKEND_ENV" INDEXER_STATUS_URL http://mainnet-indexer:42069/status
require_env_value "$BACKEND_ENV" SIGNER_BACKEND kms
require_env_value "$BACKEND_ENV" JWT_BACKEND kms
require_env_value "$INDEXER_ENV" PONDER_RPC_URL_420420419 https://eth-rpc.polkadot.io/

for file in "$BACKEND_ENV" "$INDEXER_ENV"; do
  if grep -Eq '^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)=' "$file"; then
    fail "$file contains forbidden static AWS credentials"
  fi
  if grep -Eq 'TODO\(operator\)|eth-rpc-testnet|420420417' "$file"; then
    fail "$file still contains a testnet or unresolved operator value"
  fi
done
if grep -Eq '^AUTH_JWT_SECRETS=|^BADGE_RECEIPT_SIGNING=disabled$' "$BACKEND_ENV"; then
  fail "$BACKEND_ENV disables a fail-closed mainnet signing requirement"
fi

jq -e '
  .profile == "mainnet" and
  .owner != null and
  .parameters.dailyOutflowCap == "0" and
  ([.contracts.treasuryPolicy, .contracts.agentAccountCore, .contracts.escrowCore,
    .contracts.reputationSbt, .contracts.discoveryRegistry] | all(type == "string" and test("^0x[0-9a-fA-F]{40}$")))
' "$DEPLOYMENT_FILE" >/dev/null || fail "$DEPLOYMENT_FILE is incomplete or dailyOutflowCap is armed"

jq -e '
  .profile == "mainnet" and .status == "verified" and .threshold == 2 and
  (.signatories | length) == 3 and .mapAccount.status == "recorded" and
  .launchGate.readyForOwnerUse == true
' "$OWNER_FILE" >/dev/null || fail "$OWNER_FILE is not a final, mapped 2-of-3 owner record"

deployment_owner=$(jq -r '.owner | ascii_downcase' "$DEPLOYMENT_FILE")
multisig_owner=$(jq -r '.multisig.ownerEnvValue | ascii_downcase' "$OWNER_FILE")
[[ "$deployment_owner" == "$multisig_owner" ]] || fail "deployment owner does not match mapped multisig owner"

docker network inspect agent-stack_default >/dev/null 2>&1 \
  || fail "required live Caddy/Postgres network agent-stack_default is absent"
docker compose -f "$COMPOSE_FILE" config --no-interpolate --quiet \
  || fail "mainnet compose config is invalid"

for container in agent-backend agent-indexer agent-caddy agent-postgres agent-redis; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]] \
    || fail "live testnet container is not running: $container"
done

echo "mainnet sidecar preflight: ok"
