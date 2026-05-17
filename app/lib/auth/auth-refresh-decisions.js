/**
 * Pure-logic helpers for the wallet JWT refresh manager.
 *
 * Network and DOM concerns live in auth-refresh-manager.ts; this module
 * is the side-effect-free core that decides:
 *   - whether a given session is close enough to expiry to refresh now
 *   - how long until the next scheduled refresh should fire
 *   - which RefreshOutcome reasons should clear the local session
 *
 * Kept as plain JS with JSDoc so it matches the project's existing
 * test-runner pattern (`.mjs` files via `node --test`, no TS loader).
 */

/**
 * @typedef {Object} AuthSnapshotLike
 * @property {boolean} authenticated
 * @property {string} [expiresAt]   ISO-8601 timestamp from the server's
 *                                  /auth/verify or /auth/refresh response.
 */

/**
 * Refresh when the remaining lifetime is at or below this many ms.
 * 10 minutes leaves enough headroom for: a sleeping tab to wake, a
 * polling tick, AND the request itself to round-trip before the token
 * actually expires.
 */
export const AUTH_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Belt-and-suspenders poll cadence. Short enough that a tab kept open
 * for hours with throttled timers still gets a chance; long enough that
 * a healthy session does not hit the endpoint pointlessly.
 */
export const AUTH_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Never schedule a one-shot refresh sooner than this many ms — guards
 * against tight loops if expiresAt is in the past somehow.
 */
export const AUTH_REFRESH_MIN_SCHEDULE_DELAY_MS = 5_000;

/**
 * @param {AuthSnapshotLike} snapshot
 * @param {number} [nowMs=Date.now()]
 * @returns {boolean}
 */
export function shouldRefreshNow(snapshot, nowMs = Date.now()) {
  if (!snapshot || !snapshot.authenticated || !snapshot.expiresAt) return false;
  const expiresMs = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs - nowMs <= AUTH_REFRESH_THRESHOLD_MS;
}

/**
 * Compute the delay (in ms) until the one-shot refresh timer should
 * fire for a given session. Returns `undefined` when no schedule is
 * possible (no session, invalid expiry).
 *
 * The intent is to fire ~AUTH_REFRESH_THRESHOLD_MS before expiry, but
 * never sooner than AUTH_REFRESH_MIN_SCHEDULE_DELAY_MS — to keep things
 * resilient if expiresAt is slightly in the past due to clock skew.
 *
 * @param {AuthSnapshotLike} snapshot
 * @param {number} [nowMs=Date.now()]
 * @returns {number | undefined}
 */
export function scheduleDelayMs(snapshot, nowMs = Date.now()) {
  if (!snapshot || !snapshot.authenticated || !snapshot.expiresAt) return undefined;
  const expiresMs = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(expiresMs)) return undefined;
  const target = expiresMs - AUTH_REFRESH_THRESHOLD_MS;
  const delay = target - nowMs;
  return Math.max(AUTH_REFRESH_MIN_SCHEDULE_DELAY_MS, delay);
}

/**
 * @typedef {"no_session" | "endpoint_missing" | "unauthorized" | "network" | "shape"} RefreshFailReason
 */

/**
 * Return `true` for outcomes that should clear the local session. Only
 * `unauthorized` qualifies — the others are soft misses (transient
 * network failure, backend not deployed, response shape didn't match).
 *
 * @param {RefreshFailReason} reason
 * @returns {boolean}
 */
export function shouldClearSession(reason) {
  return reason === "unauthorized";
}
