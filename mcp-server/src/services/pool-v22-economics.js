// Operator-recorded measurement, not a quote or an environment-configured APY.
export const POOL_V22_RATE_STATE = "pool-v22:measured-venue-rate";
export const MEASURED_ROUND_TRIP_FRICTIONS_RAW = Object.freeze([51_490n, 51_765n]);
// Conservatively take the larger of the two actual round trips, once per term.
export const POOL_V22_ROUND_TRIP_FRICTION_RAW = 51_765n;

export function measuredVenueRate(input) {
  try {
    if (!input || input.approved !== true || typeof input.evidence !== "string" || !input.evidence.trim()) return null;
    if (![input.principalRaw, input.yieldRaw, input.elapsedSeconds].every((n) => /^\d+$/u.test(String(n)))) return null;
    const principalRaw = BigInt(input.principalRaw);
    const yieldRaw = BigInt(input.yieldRaw);
    const elapsedSeconds = BigInt(input.elapsedSeconds);
    if (principalRaw <= 0n || elapsedSeconds <= 0n) return null;
    return { principalRaw, yieldRaw, elapsedSeconds, evidence: input.evidence };
  } catch { return null; }
}

export function projectTermYield(assetsRaw, termSeconds, observation) {
  const rate = measuredVenueRate(observation);
  if (!rate) return null;
  return BigInt(assetsRaw) * rate.yieldRaw * BigInt(termSeconds) / (rate.principalRaw * rate.elapsedSeconds);
}
