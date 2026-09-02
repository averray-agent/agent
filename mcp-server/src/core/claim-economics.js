import { DEFAULT_ESCROW_ASSET_SYMBOL, decimalsForAssetSymbol, normalizeAssetSymbol } from "./assets.js";
import { decimalToBaseUnits, formatBaseUnits } from "./platform-service-helpers.js";

export const DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT = 3;
export const DEFAULT_CLAIM_FEE_BPS = 200;
export const DEFAULT_CLAIM_FEE_VERIFIER_BPS = 7000;
export const DEFAULT_MIN_CLAIM_FEE_BY_ASSET = {
  USDC: 0.05,
  DOT: 0.05
};

export function countClaimedSessions(sessions = []) {
  return sessions.filter((session) => session?.claimedAt || session?.status).length;
}

export function computeClaimEconomics({
  rewardAmount,
  rewardAsset = DEFAULT_ESCROW_ASSET_SYMBOL,
  priorClaimCount = 0,
  claimStakeBps = 500,
  claimFeeBps = DEFAULT_CLAIM_FEE_BPS,
  claimFeeVerifierBps = DEFAULT_CLAIM_FEE_VERIFIER_BPS,
  onboardingWaiverClaimCount = DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT,
  onboardingWaiverEligible = false,
  minClaimFeeByAsset = DEFAULT_MIN_CLAIM_FEE_BY_ASSET
} = {}) {
  const reward = finiteNumber(rewardAmount, 0);
  const asset = normalizeAssetSymbol(rewardAsset);
  const claimNumber = Math.max(0, Math.floor(finiteNumber(priorClaimCount, 0))) + 1;
  const waived = Boolean(onboardingWaiverEligible)
    && claimNumber <= Math.max(0, Math.floor(finiteNumber(onboardingWaiverClaimCount, 0)));

  if (waived) {
    return {
      claimStake: 0,
      claimStakeBps: 0,
      claimFee: 0,
      claimFeeBps: 0,
      claimFeeVerifierBps,
      claimEconomicsWaived: true,
      claimNumber,
      totalClaimLock: 0
    };
  }

  const stakeBps = Math.max(0, finiteNumber(claimStakeBps, 0));
  const feeBps = Math.max(0, finiteNumber(claimFeeBps, 0));
  const minimumFee = Math.max(finiteNumber(minClaimFeeByAsset?.[asset], 0), 0);
  // E-17: compute the stake/fee in integer base units at the asset's precision
  // so this off-chain projection matches the on-chain integer math exactly,
  // instead of accumulating IEEE-754 drift through `reward * bps / 10000`.
  const { claimStake, claimFee, totalClaimLock } = computeClaimAmounts({
    reward,
    asset,
    stakeBps,
    feeBps,
    minimumFee
  });

  return {
    claimStake,
    claimStakeBps: stakeBps,
    claimFee,
    claimFeeBps: feeBps,
    claimFeeVerifierBps,
    claimEconomicsWaived: false,
    claimNumber,
    totalClaimLock
  };
}

// E-17 — exact fixed-point claim economics.
// The contract computes stake/fee as `reward * bps / 10000` in uint256 base
// units. Doing the same arithmetic off-chain in IEEE-754 drifts (e.g.
// 0.1 * 500 / 10000 → 0.005000000000000001), and that noise leaks into the
// projection ledger and API payloads. We convert the human-decimal inputs to
// base units at the asset's precision, run the bps math in BigInt with the same
// floor division the contract uses, then format back to a Number to preserve
// the existing return contract. Inputs that can't be represented exactly at the
// asset's precision (malformed / over-precise projection values) fall back to
// the legacy Number path, so this never throws where it previously computed.
function computeClaimAmounts({ reward, asset, stakeBps, feeBps, minimumFee }) {
  try {
    const decimals = decimalsForAssetSymbol(asset);
    const rewardBase = decimalToBaseUnits(reward, decimals, "reward");
    const minimumFeeBase = decimalToBaseUnits(minimumFee, decimals, "minimum claim fee");
    const claimStakeBase = applyBpsFloor(rewardBase, stakeBps);
    const percentageFeeBase = applyBpsFloor(rewardBase, feeBps);
    const claimFeeBase = percentageFeeBase > minimumFeeBase ? percentageFeeBase : minimumFeeBase;
    return {
      claimStake: Number(formatBaseUnits(claimStakeBase, decimals)),
      claimFee: Number(formatBaseUnits(claimFeeBase, decimals)),
      totalClaimLock: Number(formatBaseUnits(claimStakeBase + claimFeeBase, decimals))
    };
  } catch {
    const claimStake = Math.max((reward * stakeBps) / 10_000, 0);
    const percentageFee = Math.max((reward * feeBps) / 10_000, 0);
    const claimFee = Math.max(percentageFee, minimumFee);
    return { claimStake, claimFee, totalClaimLock: claimStake + claimFee };
  }
}

// Mirrors the contract's integer bps math: floor(baseUnits * bps / 10000).
function applyBpsFloor(baseUnits, bps) {
  return (baseUnits * BigInt(Math.max(0, Math.trunc(bps)))) / 10_000n;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
