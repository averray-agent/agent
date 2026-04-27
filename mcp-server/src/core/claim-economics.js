export const DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT = 3;
export const DEFAULT_CLAIM_FEE_BPS = 200;
export const DEFAULT_CLAIM_FEE_VERIFIER_BPS = 7000;
export const DEFAULT_MIN_CLAIM_FEE_BY_ASSET = {
  DOT: 0.05
};

export function countClaimedSessions(sessions = []) {
  return sessions.filter((session) => session?.claimedAt || session?.status).length;
}

export function computeClaimEconomics({
  rewardAmount,
  rewardAsset = "DOT",
  priorClaimCount = 0,
  claimStakeBps = 500,
  claimFeeBps = DEFAULT_CLAIM_FEE_BPS,
  claimFeeVerifierBps = DEFAULT_CLAIM_FEE_VERIFIER_BPS,
  onboardingWaiverClaimCount = DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT,
  minClaimFeeByAsset = DEFAULT_MIN_CLAIM_FEE_BY_ASSET
} = {}) {
  const reward = finiteNumber(rewardAmount, 0);
  const claimNumber = Math.max(0, Math.floor(finiteNumber(priorClaimCount, 0))) + 1;
  const waived = claimNumber <= Math.max(0, Math.floor(finiteNumber(onboardingWaiverClaimCount, 0)));

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
  const claimStake = Math.max((reward * stakeBps) / 10_000, 0);
  const percentageFee = Math.max((reward * feeBps) / 10_000, 0);
  const minimumFee = Math.max(finiteNumber(minClaimFeeByAsset?.[rewardAsset], 0), 0);
  const claimFee = Math.max(percentageFee, minimumFee);

  return {
    claimStake,
    claimStakeBps: stakeBps,
    claimFee,
    claimFeeBps: feeBps,
    claimFeeVerifierBps,
    claimEconomicsWaived: false,
    claimNumber,
    totalClaimLock: claimStake + claimFee
  };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
