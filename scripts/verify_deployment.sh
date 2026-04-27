#!/usr/bin/env bash
#
# Verify an on-chain deployment matches the manifest written by
# scripts/deploy_contracts.sh. Run this right after every deploy to confirm
# that:
#   - each contract address responds to a known function selector
#   - TreasuryPolicy.owner() matches the expected owner (multisig on prod)
#   - TreasuryPolicy.pauser() matches the expected pauser hot-key
#   - TreasuryPolicy.verifiers(VERIFIER) and TreasuryPolicy.arbitrators(ARBITRATOR) are true
#   - TreasuryPolicy.serviceOperators({escrow,account}) are true
#   - TreasuryPolicy.approvedAssets(TOKEN) is true
#   - TreasuryPolicy is NOT paused (unless --allow-paused is set)
#
# Usage:
#   ./scripts/verify_deployment.sh [profile]
#
# PROFILE (positional or env) defaults to `dev`. The script loads
# deployments/<profile>.json, then issues read-only cast calls against the
# RPC_URL recorded in the manifest (override via RPC_URL env).
#
# Exits non-zero on the first check that fails so it can gate CI/CD promotion.
set -euo pipefail

PROFILE="${1:-${PROFILE:-dev}}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
manifest_path="${repo_root}/deployments/${PROFILE}.json"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command cast
require_command jq

if [[ ! -f "$manifest_path" ]]; then
  echo "No deployment manifest at $manifest_path. Run scripts/deploy_contracts.sh first." >&2
  exit 1
fi

ALLOW_PAUSED=0
for arg in "$@"; do
  case "$arg" in
    --allow-paused) ALLOW_PAUSED=1 ;;
  esac
done

manifest="$(cat "$manifest_path")"
RPC_URL="${RPC_URL:-$(echo "$manifest" | jq -r '.rpcUrl')}"
EXPECTED_OWNER="$(echo "$manifest" | jq -r '.owner')"
EXPECTED_PAUSER="$(echo "$manifest" | jq -r '.pauser')"
EXPECTED_VERIFIER="$(echo "$manifest" | jq -r '.verifier')"
EXPECTED_ARBITRATOR="$(echo "$manifest" | jq -r '.arbitrator')"
TREASURY_POLICY="$(echo "$manifest" | jq -r '.contracts.treasuryPolicy')"
STRATEGY_REGISTRY="$(echo "$manifest" | jq -r '.contracts.strategyAdapterRegistry')"
AGENT_ACCOUNT="$(echo "$manifest" | jq -r '.contracts.agentAccountCore')"
REPUTATION_SBT="$(echo "$manifest" | jq -r '.contracts.reputationSbt')"
DISCOVERY_REGISTRY="$(echo "$manifest" | jq -r '.contracts.discoveryRegistry')"
ESCROW_CORE="$(echo "$manifest" | jq -r '.contracts.escrowCore')"
XCM_WRAPPER="$(echo "$manifest" | jq -r '.contracts.xcmWrapper // empty')"
TOKEN_ADDRESS="$(echo "$manifest" | jq -r '.contracts.token')"

fail=0
check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${expected,,}" == "${actual,,}" ]]; then
    printf "  [ok] %s\n" "$label"
  else
    printf "  [FAIL] %s: expected %s, got %s\n" "$label" "$expected" "$actual"
    fail=1
  fi
}

check_bool() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf "  [ok] %s (%s)\n" "$label" "$actual"
  else
    printf "  [FAIL] %s: expected %s, got %s\n" "$label" "$expected" "$actual"
    fail=1
  fi
}

call() {
  # Read-only call; prints hex-normalised result.
  cast call --rpc-url "$RPC_URL" "$@"
}

# Normalize the cast boolean output (0x0000...0001 / 0x) into "true"/"false".
bool_of() {
  local raw="$1"
  if [[ "$raw" == "0x" || "$raw" == "0x0000000000000000000000000000000000000000000000000000000000000000" ]]; then
    echo "false"
  else
    echo "true"
  fi
}

addr_of() {
  # cast call on an address-returning function yields a 32-byte hex;
  # the last 20 bytes are the address.
  local raw="$1"
  printf "0x%s" "${raw: -40}"
}

echo "Verifying profile: $PROFILE"
echo "RPC:               $RPC_URL"
echo ""
echo "Contract addresses:"
for pair in \
  "TreasuryPolicy=$TREASURY_POLICY" \
  "StrategyAdapterRegistry=$STRATEGY_REGISTRY" \
  "AgentAccountCore=$AGENT_ACCOUNT" \
  "ReputationSBT=$REPUTATION_SBT" \
  "DiscoveryRegistry=$DISCOVERY_REGISTRY" \
  "EscrowCore=$ESCROW_CORE" \
  "Token=$TOKEN_ADDRESS"; do
  name="${pair%%=*}"
  addr="${pair#*=}"
  # A quick sanity call: `eth_getCode` returns non-empty bytes for deployed contracts.
  code=$(cast code --rpc-url "$RPC_URL" "$addr" 2>/dev/null || echo "0x")
  if [[ "$code" == "0x" ]]; then
    printf "  [FAIL] %s at %s has no bytecode\n" "$name" "$addr"
    fail=1
  else
    printf "  [ok] %s at %s\n" "$name" "$addr"
  fi
done

if [[ -n "$XCM_WRAPPER" ]]; then
  code=$(cast code --rpc-url "$RPC_URL" "$XCM_WRAPPER" 2>/dev/null || echo "0x")
  if [[ "$code" == "0x" ]]; then
    printf "  [FAIL] %s at %s has no bytecode\n" "XcmWrapper" "$XCM_WRAPPER"
    fail=1
  else
    printf "  [ok] %s at %s\n" "XcmWrapper" "$XCM_WRAPPER"
  fi
fi

echo ""
echo "TreasuryPolicy roles:"
owner_raw=$(call "$TREASURY_POLICY" "owner()(address)")
pauser_raw=$(call "$TREASURY_POLICY" "pauser()(address)")
paused_raw=$(call "$TREASURY_POLICY" "paused()(bool)")
check "owner"  "$EXPECTED_OWNER"  "$owner_raw"
check "pauser" "$EXPECTED_PAUSER" "$pauser_raw"
if [[ "$ALLOW_PAUSED" == "1" ]]; then
  printf "  [skip] paused check (--allow-paused)\n"
else
  check_bool "not paused" "false" "$paused_raw"
fi

echo ""
echo "Operator + verifier registration:"
check_bool "serviceOperator(EscrowCore)"   "true" "$(call "$TREASURY_POLICY" "serviceOperators(address)(bool)" "$ESCROW_CORE")"
check_bool "serviceOperator(AgentAccount)" "true" "$(call "$TREASURY_POLICY" "serviceOperators(address)(bool)" "$AGENT_ACCOUNT")"
if [[ -n "$XCM_WRAPPER" ]]; then
  check_bool "serviceOperator(XcmWrapper)" "true" "$(call "$TREASURY_POLICY" "serviceOperators(address)(bool)" "$XCM_WRAPPER")"
fi
check_bool "verifier"                      "true" "$(call "$TREASURY_POLICY" "verifiers(address)(bool)" "$EXPECTED_VERIFIER")"
check "discovery publisher"                "$EXPECTED_OWNER" "$(call "$DISCOVERY_REGISTRY" "publisher()(address)")"
check_bool "arbitrator"                    "true" "$(call "$TREASURY_POLICY" "arbitrators(address)(bool)" "$EXPECTED_ARBITRATOR")"
check_bool "approvedAsset(token)"          "true" "$(call "$TREASURY_POLICY" "approvedAssets(address)(bool)" "$TOKEN_ADDRESS")"

if [[ "$(echo "$manifest" | jq -r '.parameters // empty')" != "" ]]; then
  echo ""
  echo "Launch parameters:"
  check "defaultClaimStakeBps" "$(echo "$manifest" | jq -r '.parameters.defaultClaimStakeBps')" \
    "$(call "$TREASURY_POLICY" "defaultClaimStakeBps()(uint16)")"
  check "onboardingWaiverClaimCount" "$(echo "$manifest" | jq -r '.parameters.onboardingWaiverClaimCount')" \
    "$(call "$TREASURY_POLICY" "onboardingWaiverClaimCount()(uint256)")"
  check "claimFeeBps" "$(echo "$manifest" | jq -r '.parameters.claimFeeBps')" \
    "$(call "$TREASURY_POLICY" "claimFeeBps()(uint16)")"
  check "minClaimFee(token)" "$(echo "$manifest" | jq -r '.parameters.minClaimFee')" \
    "$(call "$TREASURY_POLICY" "minClaimFeeByAsset(address)(uint256)" "$TOKEN_ADDRESS")"
  check "claimFeeVerifierBps" "$(echo "$manifest" | jq -r '.parameters.claimFeeVerifierBps')" \
    "$(call "$TREASURY_POLICY" "claimFeeVerifierBps()(uint16)")"
fi

echo ""
if [[ "$fail" == "0" ]]; then
  echo "All checks passed."
  exit 0
else
  echo "One or more checks failed. Investigate before promoting this deploy." >&2
  exit 1
fi
