/**
 * Feed-presence classification — the six-states rule from
 * docs/AUDIT_REMEDIATION.md ("every production surface must declare
 * whether it is real, degraded, or example") applied to one SWR request.
 *
 * Four states, chosen so a surface can always say WHY it is empty:
 *   - "live"    · request resolved — render the data
 *   - "loading" · first response still in flight — render a waiting hint
 *   - "locked"  · API answered 401/403 — this session may not read the
 *                 surface; rendering zeros here fabricates an all-quiet room
 *   - "down"    · request failed for any other reason — degraded, not empty
 *
 * "locked" is deliberately separate from "down": a role-less wallet
 * session 403s on /alerts, /policies and /admin/* while the public feeds
 * stay live, and an operator must be able to tell "I can't see this"
 * apart from "there is nothing to see".
 */

/**
 * @param {{ data?: unknown, error?: unknown, isLoading?: boolean } | null | undefined} request
 * @returns {"live" | "loading" | "locked" | "down"}
 */
export function feedPresence(request) {
  const error = request?.error;
  if (error) {
    return isAuthStatus(error) ? "locked" : "down";
  }
  if (request && request.data !== undefined) return "live";
  return "loading";
}

/** A feed the surface cannot truthfully render numbers from. */
export function isFeedBlocked(request) {
  const presence = feedPresence(request);
  return presence === "locked" || presence === "down";
}

/**
 * Standard short labels for blocked feeds so surfaces stay consistent.
 * Surfaces may add their own detail, but should never replace a blocked
 * state with a zero.
 */
export const FEED_STATE_LABEL = {
  live: "live",
  loading: "loading",
  locked: "locked for this session",
  down: "unavailable",
};

/**
 * Aggregate presence over the requests behind one page/panel.
 *
 * @param {Array<{ data?: unknown, error?: unknown, isLoading?: boolean }>} requests
 * @returns {{ live: number, loading: number, locked: number, down: number, total: number }}
 */
export function summarizePresence(requests) {
  const summary = { live: 0, loading: 0, locked: 0, down: 0, total: 0 };
  for (const request of requests ?? []) {
    summary[feedPresence(request)] += 1;
    summary.total += 1;
  }
  return summary;
}

function isAuthStatus(error) {
  const status = error && typeof error === "object" ? error.status : undefined;
  return status === 401 || status === 403;
}
