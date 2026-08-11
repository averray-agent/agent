export const HOSTED_CANARY_CLAIMANT_KIND = "hosted_worker_canary";
export const HOSTED_CANARY_CLAIMANT_EVIDENCE = "wallet_bound_marker_v1";

export function createHostedCanaryClaimantAttribution() {
  return {
    kind: HOSTED_CANARY_CLAIMANT_KIND,
    evidence: HOSTED_CANARY_CLAIMANT_EVIDENCE
  };
}

// Only the server-created, wallet-bound marker result is durable. Callers
// cannot widen this object with a job-name convention or other unproved hint.
export function normalizeClaimantAttribution(value) {
  return isHostedCanaryClaimant({ claimantAttribution: value })
    ? createHostedCanaryClaimantAttribution()
    : undefined;
}

export function isHostedCanaryClaimant(value) {
  return value?.claimantAttribution?.kind === HOSTED_CANARY_CLAIMANT_KIND
    && value?.claimantAttribution?.evidence === HOSTED_CANARY_CLAIMANT_EVIDENCE;
}
