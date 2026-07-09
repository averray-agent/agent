/**
 * Small value-formatters for the runs detail panel. Kept outside the
 * component so truth-boundary copy can be tested without a browser harness.
 */

/**
 * @param {{
 *   claimState?: unknown;
 *   claimExpiresAt?: unknown;
 *   claimTtlSeconds?: unknown;
 *   nowMs?: number;
 * }} input
 */
export function buildClaimWindowLabel({
  claimState,
  claimExpiresAt,
  claimTtlSeconds,
  nowMs = Date.now(),
} = {}) {
  const state = text(claimState).toLowerCase();
  const expiresMs = Date.parse(text(claimExpiresAt));
  if (state === "claimed" && Number.isFinite(expiresMs)) {
    const remainingMs = Math.max(0, expiresMs - nowMs);
    return remainingMs > 0 ? `${formatDuration(remainingMs)} remaining` : "expired";
  }

  const ttlSeconds = nonNegativeNumber(claimTtlSeconds);
  if (ttlSeconds <= 0) return "";
  if (state && !["claimable", "open", "ready"].includes(state)) return "";
  return formatDuration(ttlSeconds * 1000);
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(nonNegativeNumber(ms) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function nonNegativeNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
