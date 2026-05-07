#!/usr/bin/env bash
#
# Deploy the contract suite to a target RPC with profile-aware safety rails.
#
# Profiles:
#   dev     — local Anvil; mints MockDOT, wires deployer as verifier/arbitrator.
#   testnet — Polkadot Hub TestNet; defaults TOKEN_ADDRESS to USDC. OWNER,
#             PAUSER, VERIFIER, ARBITRATOR default to the deployer but SHOULD
#             be overridden to production-like addresses for realism.
#   mainnet — Polkadot Hub mainnet. Requires ALL of:
#             OWNER (multisig mapped EVM), PAUSER, VERIFIER, ARBITRATOR.
#             TOKEN_ADDRESS must be the v1 USDC precompile. Also requires
#             MAINNET_CONFIRM=I-understand as a belt-and-suspenders
#             acknowledgement.
#
# Idempotency:
#   The script refuses to overwrite an existing deployment manifest for the
#   chosen profile. Delete or rename deployments/<profile>.json if you really
#   want to redeploy (old contracts are orphaned on immutable chains).
#
# Inputs (all env vars):
#   PROFILE                 dev | testnet | mainnet   (default: dev)
#   RPC_URL                 RPC endpoint               (default: http://127.0.0.1:8545)
#   PRIVATE_KEY             deployer key               (required for testnet/mainnet)
#   TOKEN_ADDRESS           ERC20 asset precompile / test token. Defaults to
#                           USDC for testnet/mainnet; native DOT is not
#                           exposed via an ERC20 precompile.
#   OWNER                   multisig mapped EVM address (defaults to deployer on dev)
#   PAUSER                  hot-key pauser EOA          (defaults to deployer)
#   VERIFIER                backend verifier signer EOA (defaults to deployer on dev)
#   ARBITRATOR              arbitrator EOA              (defaults to deployer on dev)
#   DOT_NAME / DOT_SYMBOL   mock token name (dev only)
#   *_BPS / *_CAP / *_PENALTY  policy params (defaults retained from v1;
#                              see docs/MAINNET_PARAMETERS.md for the
#                              intended mainnet launch profile)
#   MAINNET_CONFIRM         must equal "I-understand" for PROFILE=mainnet
#   WITH_XCM_WRAPPER        deploy XcmWrapper when set to 1
#   WITH_XCM_VDOT_ADAPTER   deploy/register XcmVdotAdapter when set to 1
#                           (testnet/dev only; requires WITH_XCM_WRAPPER=1)
#
# Output: deployments/<profile>.json with all deployed addresses.
# Also prints shell-compatible KEY=VALUE lines (same format as before) to stdout.
set -euo pipefail

PROFILE="${PROFILE:-dev}"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
DOT_NAME="${DOT_NAME:-Mock DOT}"
DOT_SYMBOL="${DOT_SYMBOL:-mDOT}"
USDC_PRECOMPILE_ADDRESS="0x0000053900000000000000000000000001200000"
RAW_DAILY_OUTFLOW_CAP="${DAILY_OUTFLOW_CAP:-}"
RAW_BORROW_CAP="${BORROW_CAP:-}"
RAW_MIN_COLLATERAL_RATIO_BPS="${MIN_COLLATERAL_RATIO_BPS:-}"
RAW_DEFAULT_CLAIM_STAKE_BPS="${DEFAULT_CLAIM_STAKE_BPS:-}"
RAW_ONBOARDING_WAIVER_CLAIM_COUNT="${ONBOARDING_WAIVER_CLAIM_COUNT:-}"
RAW_CLAIM_FEE_BPS="${CLAIM_FEE_BPS:-}"
RAW_MIN_CLAIM_FEE="${MIN_CLAIM_FEE:-}"
RAW_CLAIM_FEE_VERIFIER_BPS="${CLAIM_FEE_VERIFIER_BPS:-}"
RAW_REJECTION_SKILL_PENALTY="${REJECTION_SKILL_PENALTY:-}"
RAW_REJECTION_RELIABILITY_PENALTY="${REJECTION_RELIABILITY_PENALTY:-}"
RAW_DISPUTE_LOSS_SKILL_PENALTY="${DISPUTE_LOSS_SKILL_PENALTY:-}"
RAW_DISPUTE_LOSS_RELIABILITY_PENALTY="${DISPUTE_LOSS_RELIABILITY_PENALTY:-}"
if [[ "$PROFILE" == "dev" ]]; then
  DAILY_OUTFLOW_CAP="${DAILY_OUTFLOW_CAP:-1000000000000000000000000}"
  BORROW_CAP="${BORROW_CAP:-1000000000000000000000}"
  MIN_COLLATERAL_RATIO_BPS="${MIN_COLLATERAL_RATIO_BPS:-15000}"
  DEFAULT_CLAIM_STAKE_BPS="${DEFAULT_CLAIM_STAKE_BPS:-500}"
  MIN_CLAIM_FEE="${MIN_CLAIM_FEE:-0}"
  REJECTION_RELIABILITY_PENALTY="${REJECTION_RELIABILITY_PENALTY:-20}"
  DISPUTE_LOSS_SKILL_PENALTY="${DISPUTE_LOSS_SKILL_PENALTY:-30}"
  DISPUTE_LOSS_RELIABILITY_PENALTY="${DISPUTE_LOSS_RELIABILITY_PENALTY:-50}"
else
  # USDC has 6 decimals. These defaults mirror docs/MAINNET_PARAMETERS.md
  # for testnet rehearsal; mainnet still requires explicit env values below.
  DAILY_OUTFLOW_CAP="${DAILY_OUTFLOW_CAP:-250000000}"
  BORROW_CAP="${BORROW_CAP:-25000000}"
  MIN_COLLATERAL_RATIO_BPS="${MIN_COLLATERAL_RATIO_BPS:-20000}"
  DEFAULT_CLAIM_STAKE_BPS="${DEFAULT_CLAIM_STAKE_BPS:-1000}"
  MIN_CLAIM_FEE="${MIN_CLAIM_FEE:-50000}"
  REJECTION_RELIABILITY_PENALTY="${REJECTION_RELIABILITY_PENALTY:-25}"
  DISPUTE_LOSS_SKILL_PENALTY="${DISPUTE_LOSS_SKILL_PENALTY:-35}"
  DISPUTE_LOSS_RELIABILITY_PENALTY="${DISPUTE_LOSS_RELIABILITY_PENALTY:-60}"
fi
ONBOARDING_WAIVER_CLAIM_COUNT="${ONBOARDING_WAIVER_CLAIM_COUNT:-3}"
CLAIM_FEE_BPS="${CLAIM_FEE_BPS:-200}"
CLAIM_FEE_VERIFIER_BPS="${CLAIM_FEE_VERIFIER_BPS:-7000}"
REJECTION_SKILL_PENALTY="${REJECTION_SKILL_PENALTY:-10}"

ANVIL_TEST_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
deployments_dir="${repo_root}/deployments"
manifest_path="${deployments_dir}/${PROFILE}.json"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

fail() {
  echo "error: $*" >&2
  exit 1
}

require_command forge
require_command cast

case "$PROFILE" in
  dev)
    PRIVATE_KEY="${PRIVATE_KEY:-$ANVIL_TEST_KEY}"
    ;;
  testnet|mainnet)
    TOKEN_ADDRESS="${TOKEN_ADDRESS:-$USDC_PRECOMPILE_ADDRESS}"
    [[ -n "${PRIVATE_KEY:-}" ]] || fail "PRIVATE_KEY is required for PROFILE=$PROFILE"
    [[ "$PRIVATE_KEY" != "$ANVIL_TEST_KEY" ]] || fail "refusing to use Anvil test key for PROFILE=$PROFILE"
    ;;
  *)
    fail "unknown PROFILE: $PROFILE (expected dev|testnet|mainnet)"
    ;;
esac

if [[ "$PROFILE" == "mainnet" ]]; then
  [[ "${MAINNET_CONFIRM:-}" == "I-understand" ]] || \
    fail "refusing mainnet deploy without MAINNET_CONFIRM=I-understand"
  [[ -n "${OWNER:-}" ]] || fail "OWNER is required for mainnet (multisig mapped EVM address)"
  [[ -n "${PAUSER:-}" ]] || fail "PAUSER is required for mainnet"
  [[ -n "${VERIFIER:-}" ]] || fail "VERIFIER is required for mainnet"
  [[ -n "${ARBITRATOR:-}" ]] || fail "ARBITRATOR is required for mainnet"
  [[ "${TOKEN_ADDRESS,,}" == "${USDC_PRECOMPILE_ADDRESS,,}" ]] || \
    fail "mainnet TOKEN_ADDRESS must be the v1 USDC precompile $USDC_PRECOMPILE_ADDRESS"
  [[ -n "$RAW_DAILY_OUTFLOW_CAP" ]] || fail "DAILY_OUTFLOW_CAP must be set explicitly for mainnet"
  [[ -n "$RAW_BORROW_CAP" ]] || fail "BORROW_CAP must be set explicitly for mainnet"
  [[ -n "$RAW_MIN_COLLATERAL_RATIO_BPS" ]] || fail "MIN_COLLATERAL_RATIO_BPS must be set explicitly for mainnet"
  [[ -n "$RAW_DEFAULT_CLAIM_STAKE_BPS" ]] || fail "DEFAULT_CLAIM_STAKE_BPS must be set explicitly for mainnet"
  [[ -n "$RAW_ONBOARDING_WAIVER_CLAIM_COUNT" ]] || fail "ONBOARDING_WAIVER_CLAIM_COUNT must be set explicitly for mainnet"
  [[ -n "$RAW_CLAIM_FEE_BPS" ]] || fail "CLAIM_FEE_BPS must be set explicitly for mainnet"
  [[ -n "$RAW_MIN_CLAIM_FEE" ]] || fail "MIN_CLAIM_FEE must be set explicitly for mainnet"
  [[ -n "$RAW_CLAIM_FEE_VERIFIER_BPS" ]] || fail "CLAIM_FEE_VERIFIER_BPS must be set explicitly for mainnet"
  [[ -n "$RAW_REJECTION_SKILL_PENALTY" ]] || fail "REJECTION_SKILL_PENALTY must be set explicitly for mainnet"
  [[ -n "$RAW_REJECTION_RELIABILITY_PENALTY" ]] || fail "REJECTION_RELIABILITY_PENALTY must be set explicitly for mainnet"
  [[ -n "$RAW_DISPUTE_LOSS_SKILL_PENALTY" ]] || fail "DISPUTE_LOSS_SKILL_PENALTY must be set explicitly for mainnet"
  [[ -n "$RAW_DISPUTE_LOSS_RELIABILITY_PENALTY" ]] || fail "DISPUTE_LOSS_RELIABILITY_PENALTY must be set explicitly for mainnet"
fi

mkdir -p "$deployments_dir"
if [[ -f "$manifest_path" ]]; then
  fail "deployment manifest already exists at $manifest_path. Delete or rename it to redeploy (note: old contracts are orphaned)."
fi

DEPLOYER_ADDRESS="$(cast wallet address --private-key "$PRIVATE_KEY")"

# Defaults to deployer if the role env var is unset. That's only safe for dev;
# the earlier checks force explicit values on mainnet.
OWNER_ADDRESS="${OWNER:-$DEPLOYER_ADDRESS}"
PAUSER_ADDRESS="${PAUSER:-$DEPLOYER_ADDRESS}"
VERIFIER_ADDRESS="${VERIFIER:-$DEPLOYER_ADDRESS}"
ARBITRATOR_ADDRESS="${ARBITRATOR:-$DEPLOYER_ADDRESS}"

extract_address() {
  echo "$1" | awk '/Deployed to:/ { print $3 }'
}

send_tx() {
  local to="$1"
  local signature="$2"
  shift 2
  cast send \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    "$to" \
    "$signature" \
    "$@" >/dev/null
}

forge_deploy() {
  local target="$1"
  shift
  forge create "$target" \
    --broadcast \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    "$@"
}

echo "Profile:  $PROFILE"
echo "RPC:      $RPC_URL"
echo "Deployer: $DEPLOYER_ADDRESS"
echo "Manifest: $manifest_path"

TREASURY_POLICY="$(extract_address "$(forge_deploy contracts/TreasuryPolicy.sol:TreasuryPolicy)")"
echo "TreasuryPolicy:          $TREASURY_POLICY"

STRATEGY_REGISTRY="$(extract_address "$(forge_deploy contracts/StrategyAdapterRegistry.sol:StrategyAdapterRegistry --constructor-args "$TREASURY_POLICY")")"
echo "StrategyAdapterRegistry: $STRATEGY_REGISTRY"

AGENT_ACCOUNT="$(extract_address "$(forge_deploy contracts/AgentAccountCore.sol:AgentAccountCore --constructor-args "$TREASURY_POLICY" "$STRATEGY_REGISTRY")")"
echo "AgentAccountCore:        $AGENT_ACCOUNT"

REPUTATION_SBT="$(extract_address "$(forge_deploy contracts/ReputationSBT.sol:ReputationSBT --constructor-args "$TREASURY_POLICY")")"
echo "ReputationSBT:           $REPUTATION_SBT"

DISCOVERY_REGISTRY="$(extract_address "$(forge_deploy contracts/DiscoveryRegistry.sol:DiscoveryRegistry --constructor-args "$DEPLOYER_ADDRESS")")"
echo "DiscoveryRegistry:       $DISCOVERY_REGISTRY"

ESCROW_CORE="$(extract_address "$(forge_deploy contracts/EscrowCore.sol:EscrowCore --constructor-args "$TREASURY_POLICY" "$AGENT_ACCOUNT" "$REPUTATION_SBT")")"
echo "EscrowCore:              $ESCROW_CORE"

XCM_WRAPPER=""
XCM_WRAPPER_PRECOMPILE_ADDRESS="${XCM_WRAPPER_PRECOMPILE_ADDRESS:-0x0000000000000000000000000000000000000000}"
if [[ "${WITH_XCM_WRAPPER:-}" == "1" ]]; then
  echo "Deploying XcmWrapper"
  XCM_WRAPPER="$(extract_address "$(forge_deploy contracts/XcmWrapper.sol:XcmWrapper --constructor-args "$TREASURY_POLICY" "$XCM_WRAPPER_PRECOMPILE_ADDRESS")")"
  echo "XcmWrapper:              $XCM_WRAPPER"
fi

if [[ "$PROFILE" == "dev" && -z "${TOKEN_ADDRESS:-}" ]]; then
  TOKEN_ADDRESS="$(extract_address "$(forge_deploy contracts/mocks/MockERC20.sol:MockERC20 --constructor-args "$DOT_NAME" "$DOT_SYMBOL")")"
  echo "MockDOT (dev only):      $TOKEN_ADDRESS"
fi

echo "Configuring TreasuryPolicy"
send_tx "$TREASURY_POLICY" "setApprovedAsset(address,bool)" "$TOKEN_ADDRESS" true
send_tx "$TREASURY_POLICY" "setServiceOperator(address,bool)" "$AGENT_ACCOUNT" true
send_tx "$TREASURY_POLICY" "setServiceOperator(address,bool)" "$ESCROW_CORE" true
if [[ -n "$XCM_WRAPPER" ]]; then
  send_tx "$TREASURY_POLICY" "setServiceOperator(address,bool)" "$XCM_WRAPPER" true
fi
send_tx "$TREASURY_POLICY" "setVerifier(address,bool)" "$VERIFIER_ADDRESS" true
send_tx "$TREASURY_POLICY" "setArbitrator(address,bool)" "$ARBITRATOR_ADDRESS" true
send_tx "$TREASURY_POLICY" "setDailyOutflowCap(uint256)" "$DAILY_OUTFLOW_CAP"
send_tx "$TREASURY_POLICY" "setPerAccountBorrowCap(uint256)" "$BORROW_CAP"
send_tx "$TREASURY_POLICY" "setMinimumCollateralRatioBps(uint256)" "$MIN_COLLATERAL_RATIO_BPS"
send_tx "$TREASURY_POLICY" "setDefaultClaimStakeBps(uint16)" "$DEFAULT_CLAIM_STAKE_BPS"
send_tx "$TREASURY_POLICY" "setOnboardingWaiverClaimCount(uint256)" "$ONBOARDING_WAIVER_CLAIM_COUNT"
send_tx "$TREASURY_POLICY" "setClaimFeeBps(uint16)" "$CLAIM_FEE_BPS"
send_tx "$TREASURY_POLICY" "setMinClaimFee(address,uint256)" "$TOKEN_ADDRESS" "$MIN_CLAIM_FEE"
send_tx "$TREASURY_POLICY" "setClaimFeeVerifierBps(uint16)" "$CLAIM_FEE_VERIFIER_BPS"
send_tx "$TREASURY_POLICY" "setRejectionSkillPenalty(uint256)" "$REJECTION_SKILL_PENALTY"
send_tx "$TREASURY_POLICY" "setRejectionReliabilityPenalty(uint256)" "$REJECTION_RELIABILITY_PENALTY"
send_tx "$TREASURY_POLICY" "setDisputeLossSkillPenalty(uint256)" "$DISPUTE_LOSS_SKILL_PENALTY"
send_tx "$TREASURY_POLICY" "setDisputeLossReliabilityPenalty(uint256)" "$DISPUTE_LOSS_RELIABILITY_PENALTY"

# Install the pauser hot-key. Must precede ownership transfer because only the
# current owner (deployer) can call setPauser.
echo "Configuring pauser: $PAUSER_ADDRESS"
send_tx "$TREASURY_POLICY" "setPauser(address)" "$PAUSER_ADDRESS"

# Optional: deploy + register the MockVDotAdapter for testnet demos.
# Guarded behind WITH_VDOT_MOCK=1 so mainnet deploys can't accidentally
# enable the simulateYield governance knob.
VDOT_ADAPTER=""
VDOT_STRATEGY_ID=""
VDOT_ADAPTER_KIND=""
if [[ "${WITH_VDOT_MOCK:-}" == "1" ]]; then
  if [[ "$PROFILE" == "mainnet" ]]; then
    fail "WITH_VDOT_MOCK=1 is not allowed on PROFILE=mainnet (see docs/strategies/vdot.md for the real mainnet path)"
  fi
  if [[ "${WITH_XCM_VDOT_ADAPTER:-}" == "1" ]]; then
    fail "WITH_VDOT_MOCK=1 and WITH_XCM_VDOT_ADAPTER=1 are mutually exclusive"
  fi
  VDOT_STRATEGY_ID="${VDOT_STRATEGY_ID_HEX:-0x56444f545f56315f4d4f434b0000000000000000000000000000000000000000}"  # bytes32("VDOT_V1_MOCK")
  VDOT_ADAPTER_KIND="mock_vdot"
  echo "Deploying MockVDotAdapter"
  VDOT_ADAPTER="$(extract_address "$(forge_deploy contracts/strategies/MockVDotAdapter.sol:MockVDotAdapter --constructor-args "$TREASURY_POLICY" "$TOKEN_ADDRESS" "$VDOT_STRATEGY_ID")")"
  echo "MockVDotAdapter:         $VDOT_ADAPTER"
  # The adapter must be a service operator so AgentAccountCore (a future
  # wiring PR) can route allocateIdleFunds → adapter.deposit calls through
  # policy-gated paths. Also mark it as an approved strategy so the
  # registry accepts it.
  send_tx "$TREASURY_POLICY" "setApprovedStrategy(address,bool)" "$VDOT_ADAPTER" true
  send_tx "$TREASURY_POLICY" "setServiceOperator(address,bool)" "$VDOT_ADAPTER" true
  send_tx "$STRATEGY_REGISTRY" "registerStrategy(address)" "$VDOT_ADAPTER"
fi

if [[ "${WITH_XCM_VDOT_ADAPTER:-}" == "1" ]]; then
  if [[ "$PROFILE" == "mainnet" ]]; then
    fail "WITH_XCM_VDOT_ADAPTER=1 is not allowed on PROFILE=mainnet until native observer evidence has passed"
  fi
  if [[ -z "$XCM_WRAPPER" ]]; then
    fail "WITH_XCM_VDOT_ADAPTER=1 requires WITH_XCM_WRAPPER=1"
  fi
  VDOT_STRATEGY_ID="${VDOT_STRATEGY_ID_HEX:-0x56444f545f56315f58434d0000000000000000000000000000000000000000}"  # bytes32("VDOT_V1_XCM")
  VDOT_ADAPTER_KIND="polkadot_vdot"
  echo "Deploying XcmVdotAdapter"
  VDOT_ADAPTER="$(extract_address "$(forge_deploy contracts/strategies/XcmVdotAdapter.sol:XcmVdotAdapter --constructor-args "$TREASURY_POLICY" "$TOKEN_ADDRESS" "$VDOT_STRATEGY_ID" "$XCM_WRAPPER")")"
  echo "XcmVdotAdapter:          $VDOT_ADAPTER"
  send_tx "$TREASURY_POLICY" "setApprovedStrategy(address,bool)" "$VDOT_ADAPTER" true
  send_tx "$TREASURY_POLICY" "setServiceOperator(address,bool)" "$VDOT_ADAPTER" true
  send_tx "$STRATEGY_REGISTRY" "registerStrategy(address)" "$VDOT_ADAPTER"
fi

# Ownership transfer last so all earlier config calls succeed while the
# deployer still holds the owner role. After this the deployer cannot touch
# admin operations — only the multisig (or whatever address OWNER points at)
# can.
if [[ "$OWNER_ADDRESS" != "$DEPLOYER_ADDRESS" ]]; then
  echo "Transferring ownership to: $OWNER_ADDRESS"
  send_tx "$DISCOVERY_REGISTRY" "setPublisher(address)" "$OWNER_ADDRESS"
  send_tx "$TREASURY_POLICY" "transferOwnership(address)" "$OWNER_ADDRESS"
fi

STRATEGIES_JSON="[]"
XCM_WRAPPER_JSON="null"
if [[ -n "$XCM_WRAPPER" ]]; then
  XCM_WRAPPER_JSON="\"$XCM_WRAPPER\""
fi
if [[ -n "$VDOT_ADAPTER" ]]; then
  if [[ "$VDOT_ADAPTER_KIND" == "polkadot_vdot" ]]; then
    XCM_VDOT_DESTINATION_PARACHAIN="${XCM_VDOT_DESTINATION_PARACHAIN:-2030}"
    XCM_VDOT_ASSET_SYMBOL="${XCM_VDOT_ASSET_SYMBOL:-DOT}"
    XCM_VDOT_ASSET_DECIMALS="${XCM_VDOT_ASSET_DECIMALS:-18}"
    STRATEGIES_JSON="[
      {
        \"strategyId\": \"$VDOT_STRATEGY_ID\",
        \"adapter\": \"$VDOT_ADAPTER\",
        \"kind\": \"polkadot_vdot\",
        \"executionMode\": \"async_xcm\",
        \"riskLabel\": \"Async XCM-backed vDOT lane. Requests queue through XcmWrapper and settle later; not instant liquidity.\",
        \"asset\": {
          \"assetClass\": \"custom\",
          \"address\": \"$TOKEN_ADDRESS\",
          \"symbol\": \"$XCM_VDOT_ASSET_SYMBOL\",
          \"decimals\": $XCM_VDOT_ASSET_DECIMALS
        },
        \"xcm\": {
          \"destinationParachain\": $XCM_VDOT_DESTINATION_PARACHAIN
        }
      }
    ]"
  else
    STRATEGIES_JSON="[
      {
        \"strategyId\": \"$VDOT_STRATEGY_ID\",
        \"adapter\": \"$VDOT_ADAPTER\",
        \"kind\": \"mock_vdot\",
        \"riskLabel\": \"Mock vDOT liquid staking (testnet). Not a real yield source.\"
      }
    ]"
  fi
fi

cat > "$manifest_path" <<JSON
{
  "profile": "$PROFILE",
  "rpcUrl": "$RPC_URL",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployer": "$DEPLOYER_ADDRESS",
  "owner": "$OWNER_ADDRESS",
  "pauser": "$PAUSER_ADDRESS",
  "verifier": "$VERIFIER_ADDRESS",
  "arbitrator": "$ARBITRATOR_ADDRESS",
  "contracts": {
    "treasuryPolicy": "$TREASURY_POLICY",
    "strategyAdapterRegistry": "$STRATEGY_REGISTRY",
    "agentAccountCore": "$AGENT_ACCOUNT",
    "reputationSbt": "$REPUTATION_SBT",
    "discoveryRegistry": "$DISCOVERY_REGISTRY",
    "escrowCore": "$ESCROW_CORE",
    "xcmWrapper": $XCM_WRAPPER_JSON,
    "token": "$TOKEN_ADDRESS"
  },
  "parameters": {
    "dailyOutflowCap": "$DAILY_OUTFLOW_CAP",
    "borrowCap": "$BORROW_CAP",
    "minimumCollateralRatioBps": "$MIN_COLLATERAL_RATIO_BPS",
    "defaultClaimStakeBps": "$DEFAULT_CLAIM_STAKE_BPS",
    "onboardingWaiverClaimCount": "$ONBOARDING_WAIVER_CLAIM_COUNT",
    "claimFeeBps": "$CLAIM_FEE_BPS",
    "minClaimFee": "$MIN_CLAIM_FEE",
    "claimFeeVerifierBps": "$CLAIM_FEE_VERIFIER_BPS",
    "rejectionSkillPenalty": "$REJECTION_SKILL_PENALTY",
    "rejectionReliabilityPenalty": "$REJECTION_RELIABILITY_PENALTY",
    "disputeLossSkillPenalty": "$DISPUTE_LOSS_SKILL_PENALTY",
    "disputeLossReliabilityPenalty": "$DISPUTE_LOSS_RELIABILITY_PENALTY"
  },
  "strategies": $STRATEGIES_JSON
}
JSON
echo "Wrote $manifest_path"

cat <<EOF
DEPLOYER_ADDRESS=$DEPLOYER_ADDRESS
RPC_URL=$RPC_URL
TREASURY_POLICY=$TREASURY_POLICY
STRATEGY_ADAPTER_REGISTRY=$STRATEGY_REGISTRY
AGENT_ACCOUNT_ADDRESS=$AGENT_ACCOUNT
REPUTATION_SBT_ADDRESS=$REPUTATION_SBT
DISCOVERY_REGISTRY_ADDRESS=$DISCOVERY_REGISTRY
ESCROW_CORE_ADDRESS=$ESCROW_CORE
TOKEN_ADDRESS=$TOKEN_ADDRESS
EOF
