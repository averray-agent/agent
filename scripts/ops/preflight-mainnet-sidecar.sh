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
UINT256_MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935

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

require_env_nonempty() {
  local file="$1"
  local key="$2"
  local actual
  actual=$(awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$file")
  [[ -n "$actual" ]] || fail "$file must set a non-empty $key from host state"
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
require_env_value "$BACKEND_ENV" RPC_URL https://services.polkadothub-rpc.com/mainnet/
require_env_value "$BACKEND_ENV" RPC_BACKUP_URLS https://eth-rpc.polkadot.io/
require_env_value "$BACKEND_ENV" REDIS_URL redis://mainnet-redis:6379
require_env_value "$BACKEND_ENV" REDIS_NAMESPACE agent-platform-mainnet
require_env_value "$BACKEND_ENV" INDEXER_STATUS_URL http://mainnet-indexer:42069/status
require_env_value "$BACKEND_ENV" SIGNER_BACKEND kms
require_env_value "$BACKEND_ENV" JWT_BACKEND kms
require_env_value "$INDEXER_ENV" PONDER_RPC_URL_420420419 https://eth-rpc.polkadot.io/
require_env_value "$INDEXER_ENV" POLKADOT_CHAIN_ID 420420419
require_env_value "$INDEXER_ENV" POLKADOT_CHAIN_NAME polkadotHubMainnet

for file in "$BACKEND_ENV" "$INDEXER_ENV"; do
  if grep -Eq '^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)=' "$file"; then
    fail "$file contains forbidden static AWS credentials"
  fi
  if grep -Eq '^[A-Z][A-Z0-9_]*=.*(eth-rpc-testnet|420420417)' "$file"; then
    fail "$file still contains a testnet value"
  fi
  if grep -Eq '^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]*=.*TODO\(operator\)' "$file"; then
    fail "$file still contains an unresolved operator value"
  fi
done
if grep -Eq '^AUTH_JWT_SECRETS=|^BADGE_RECEIPT_SIGNING=disabled$' "$BACKEND_ENV"; then
  fail "$BACKEND_ENV disables a fail-closed mainnet signing requirement"
fi

jq -e --arg cap "$UINT256_MAX" '
  .profile == "mainnet" and
  .owner != null and
  .parameters.dailyOutflowCap == $cap and
  ([.contracts.treasuryPolicy, .contracts.agentAccountCore, .contracts.escrowCore,
    .contracts.reputationSbt, .contracts.discoveryRegistry] | all(type == "string" and test("^0x[0-9a-fA-F]{40}$")))
' "$DEPLOYMENT_FILE" >/dev/null \
  || fail "$DEPLOYMENT_FILE is incomplete or dailyOutflowCap is not the audited uint256.max value"

jq -e '
  .profile == "mainnet" and .threshold == 2 and
  (.signatories | length) == 3 and
  (
    (
      .status == "verified" and
      .mapAccount.status == "recorded" and
      .launchGate.readyForOwnerUse == true
    ) or (
      (.status == "draft" or .status == "verified") and
      .mapAccount.mechanism == "auto_map" and
      .mapAccount.required == false and
      .mapAccount.status == "auto_mapped" and
      .mapAccount.extrinsic == null and
      .mapAccount.txHash == null and
      .mapAccount.autoMap.originalAccountVerified == true and
      (.mapAccount.autoMap.accountCreationBlock | test("^[0-9]+$")) and
      (.mapAccount.autoMap.accountCreationTxHash | test("^0x[0-9a-fA-F]{64}$")) and
      .mapAccount.autoMap.verify.expect == .multisig.accountId32
    )
  )
' "$OWNER_FILE" >/dev/null || fail "$OWNER_FILE is not a verified recorded-map or AutoMap 2-of-3 owner record"

deployment_owner=$(jq -r '.owner | ascii_downcase' "$DEPLOYMENT_FILE")
multisig_owner=$(jq -r '.multisig.ownerEnvValue | ascii_downcase' "$OWNER_FILE")
[[ "$deployment_owner" == "$multisig_owner" ]] || fail "deployment owner does not match mapped multisig owner"

require_env_value "$BACKEND_ENV" TREASURY_POLICY_ADDRESS "$(jq -r '.contracts.treasuryPolicy' "$DEPLOYMENT_FILE")"
require_env_value "$BACKEND_ENV" AGENT_ACCOUNT_ADDRESS "$(jq -r '.contracts.agentAccountCore' "$DEPLOYMENT_FILE")"
require_env_value "$BACKEND_ENV" ESCROW_CORE_ADDRESS "$(jq -r '.contracts.escrowCore' "$DEPLOYMENT_FILE")"
require_env_value "$BACKEND_ENV" LEGACY_ESCROW_CORE_ADDRESS "$(jq -r '.contracts.legacyEscrowCore // ""' "$DEPLOYMENT_FILE")"
require_env_value "$BACKEND_ENV" REPUTATION_SBT_ADDRESS "$(jq -r '.contracts.reputationSbt' "$DEPLOYMENT_FILE")"
require_env_value "$BACKEND_ENV" DISCOVERY_REGISTRY_ADDRESS "$(jq -r '.contracts.discoveryRegistry' "$DEPLOYMENT_FILE")"
require_env_value "$BACKEND_ENV" AUTH_ADMIN_WALLETS "$(jq -r '.runtime.auth.adminWallets | join(",")' "$DEPLOYMENT_FILE")"
require_env_value "$BACKEND_ENV" AUTH_VERIFIER_WALLETS "$(jq -r '.runtime.auth.verifierWallets | join(",")' "$DEPLOYMENT_FILE")"
require_env_value "$BACKEND_ENV" USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT "$(jq -r '.treasuryReserve' "$DEPLOYMENT_FILE")"

require_env_value "$INDEXER_ENV" PONDER_TREASURY_POLICY_ADDRESS "$(jq -r '.contracts.treasuryPolicy' "$DEPLOYMENT_FILE")"
require_env_value "$INDEXER_ENV" PONDER_ESCROW_CORE_ADDRESS "$(jq -r '.contracts.escrowCore' "$DEPLOYMENT_FILE")"
require_env_value "$INDEXER_ENV" PONDER_LEGACY_ESCROW_CORE_ADDRESS "$(jq -r '.contracts.legacyEscrowCore // ""' "$DEPLOYMENT_FILE")"
require_env_value "$INDEXER_ENV" PONDER_AGENT_ACCOUNT_ADDRESS "$(jq -r '.contracts.agentAccountCore' "$DEPLOYMENT_FILE")"
require_env_value "$INDEXER_ENV" PONDER_REPUTATION_SBT_ADDRESS "$(jq -r '.contracts.reputationSbt' "$DEPLOYMENT_FILE")"
require_env_value "$INDEXER_ENV" PONDER_DISCOVERY_REGISTRY_ADDRESS "$(jq -r '.contracts.discoveryRegistry' "$DEPLOYMENT_FILE")"
require_env_value "$INDEXER_ENV" PONDER_START_BLOCK_TREASURY "$(jq -r '.deploymentBlocks.treasuryPolicy' "$DEPLOYMENT_FILE")"
agent_start=$(jq -r '[.deploymentBlocks.agentAccountCore, .deploymentBlocks.escrowCore] | min' "$DEPLOYMENT_FILE")
require_env_value "$INDEXER_ENV" PONDER_START_BLOCK_ESCROW "$agent_start"
require_env_value "$INDEXER_ENV" PONDER_START_BLOCK_REPUTATION "$(jq -r '.deploymentBlocks.reputationSbt' "$DEPLOYMENT_FILE")"
require_env_value "$INDEXER_ENV" PONDER_START_BLOCK_REGISTRIES "$(jq -r '.deploymentBlocks.discoveryRegistry' "$DEPLOYMENT_FILE")"

# DATABASE_SCHEMA is host-owned runtime state, not deployment-manifest data.
# The normal deploy wrapper validates and injects it before container startup.
require_env_nonempty "$INDEXER_ENV" DATABASE_SCHEMA

docker network inspect agent-stack_default >/dev/null 2>&1 \
  || fail "required live Caddy/Postgres network agent-stack_default is absent"
docker compose -f "$COMPOSE_FILE" config --no-interpolate --quiet \
  || fail "mainnet compose config is invalid"

for container in agent-backend agent-indexer agent-caddy agent-postgres agent-redis; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]] \
    || fail "live testnet container is not running: $container"
done

owner_record_status=$(jq -r '.status // "unknown"' "$OWNER_FILE")
owner_ready_for_go=$(jq -r '.launchGate.readyForOwnerUse // false' "$OWNER_FILE")
if [[ "$owner_record_status" == "verified" && "$owner_ready_for_go" == "true" ]]; then
  echo "owner_go_gate=ready"
else
  echo "owner_go_gate=pending (internal sidecar only; ownership/admin rehearsal still required)"
fi

echo "mainnet sidecar preflight: ok"
