export const DEPOSIT_POOL_YIELD_NOT_EARNING_TEXT =
  "Deposits do not currently earn yield; pool capital is home, and venue deployment is not scheduled. The venue lane can reopen when deployable pool TVL reaches approximately 62 USDC or the seven-day cap is amended. A vested deposit is a capital-backed trust-and-capacity signal, never catalogue reward entitlement.";

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
