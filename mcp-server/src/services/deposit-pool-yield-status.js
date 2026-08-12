export const DEPOSIT_POOL_YIELD_NOT_EARNING_TEXT =
  "Deposits do not currently earn yield; pool capital deployment is a pending operator ceremony. Deposits raise your daily allowance 1:1 — that is the live benefit today.";

export const DEPOSIT_POOL_YIELD_EARNING_TEXT =
  "Pool capital is deployed to the configured venue; yield is recognized only when returned to pool accounting.";

/**
 * Packet 4 and Packet 5 intentionally share this one source. The chain fact is
 * deployed principal, not a release flag: zero means no capital is earning,
 * while any positive value means the venue has accepted principal.
 */
export function depositPoolYieldStatus(deployedPrincipalRaw) {
  if (BigInt(deployedPrincipalRaw ?? 0) > 0n) {
    return {
      yieldStatus: "earning",
      yieldStatusText: DEPOSIT_POOL_YIELD_EARNING_TEXT
    };
  }
  return {
    yieldStatus: "not_yet_earning",
    yieldStatusText: DEPOSIT_POOL_YIELD_NOT_EARNING_TEXT
  };
}
