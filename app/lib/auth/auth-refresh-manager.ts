"use client";

/**
 * Background refresh manager for the wallet JWT.
 *
 * Pairs with the backend's POST /auth/refresh endpoint. Keeps an operator
 * signed in across long sessions by rotating the JWT *before* it expires,
 * so they never get a 401 mid-flow and never have to walk through the
 * SIWE prompt again until they actively sign out.
 *
 * Strategy:
 *   - On mount, if the current token expires within REFRESH_THRESHOLD_MS,
 *     refresh now.
 *   - Otherwise schedule a one-shot timer for (expiresAt - margin),
 *     plus a poll every CHECK_INTERVAL_MS as a belt-and-suspenders.
 *   - On `visibilitychange` (tab regains focus after sleep), re-check
 *     and refresh if the timer missed while the page was hidden.
 *   - The manager is idempotent: calling start() while running is a no-op.
 *
 * Failure modes (see refreshAuthToken's RefreshOutcome):
 *   - `endpoint_missing` (backend not deployed) → silent no-op; the
 *     session keeps working and the operator will re-SIWE on natural expiry.
 *   - `unauthorized` → the session was already revoked server-side;
 *     refreshAuthToken clears local state, which will trigger the
 *     existing unauthenticated-redirect logic in the operator app.
 *   - `network` / `shape` / `no_session` → silent no-op; we'll try
 *     again at the next interval / visibility change.
 */

import { getAuthSnapshot, onAuthChange, type AuthSnapshot } from "./token-store";
import { refreshAuthToken } from "./siwe";
import {
  AUTH_REFRESH_CHECK_INTERVAL_MS as CHECK_INTERVAL_MS,
  AUTH_REFRESH_THRESHOLD_MS as REFRESH_THRESHOLD_MS,
  scheduleDelayMs,
  shouldRefreshNow as decideShouldRefresh,
} from "./auth-refresh-decisions.js";

type Stop = () => void;

let activeStop: Stop | null = null;

export function startAuthRefreshManager(): Stop {
  if (activeStop) return activeStop;
  if (typeof window === "undefined") return () => {};

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let nextTokenTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let unsubscribeAuth: (() => void) | undefined;
  let visibilityListener: (() => void) | undefined;
  let stopped = false;

  function clearScheduledTimer() {
    if (nextTokenTimer !== undefined) {
      clearTimeout(nextTokenTimer);
      nextTokenTimer = undefined;
    }
  }

  function shouldRefreshNow(snapshot: AuthSnapshot): boolean {
    return decideShouldRefresh(snapshot);
  }

  async function attemptRefresh(reason: string) {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const outcome = await refreshAuthToken();
      if (outcome.ok) {
        // eslint-disable-next-line no-console
        console.debug(`[auth-refresh] rotated (${reason}); new expiry ${outcome.session.expiresAt}`);
        // The success path re-fires the auth listener via writeSession,
        // which re-runs scheduleForCurrentSession with the new expiry.
      } else if (outcome.reason === "unauthorized") {
        // eslint-disable-next-line no-console
        console.info(`[auth-refresh] unauthorized; session cleared (${reason})`);
      }
      // Other outcomes are silent — soft misses, will retry on the next tick.
    } finally {
      refreshing = false;
    }
  }

  function scheduleForCurrentSession() {
    clearScheduledTimer();
    if (stopped) return;
    const snapshot = getAuthSnapshot();
    if (!snapshot.authenticated || !snapshot.expiresAt) return;
    if (shouldRefreshNow(snapshot)) {
      void attemptRefresh("threshold");
      return;
    }
    const delay = scheduleDelayMs(snapshot);
    if (delay === undefined) return;
    nextTokenTimer = setTimeout(() => {
      void attemptRefresh("scheduled");
    }, delay);
  }

  // 1. Initial check on mount.
  scheduleForCurrentSession();

  // 2. Belt-and-suspenders poll every CHECK_INTERVAL_MS — handles long-running
  //    tabs where the one-shot timer might drift, and catches the case where
  //    a new session is written by sign-in flow.
  pollTimer = setInterval(() => {
    const snapshot = getAuthSnapshot();
    if (shouldRefreshNow(snapshot)) {
      void attemptRefresh("poll");
    }
  }, CHECK_INTERVAL_MS);

  // 3. Re-check on visibilitychange. Tabs that are backgrounded for hours
  //    have their setTimeout / setInterval throttled aggressively, so the
  //    timer above can miss. When the operator returns to the tab, we
  //    refresh immediately if we're inside the threshold.
  visibilityListener = () => {
    if (document.visibilityState === "visible") {
      const snapshot = getAuthSnapshot();
      if (shouldRefreshNow(snapshot)) {
        void attemptRefresh("visibility");
      } else {
        // Reschedule the one-shot in case it was throttled away.
        scheduleForCurrentSession();
      }
    }
  };
  document.addEventListener("visibilitychange", visibilityListener);

  // 4. React to sign-in / sign-out / cross-tab session writes by rescheduling.
  unsubscribeAuth = onAuthChange(() => scheduleForCurrentSession());

  const stop: Stop = () => {
    if (stopped) return;
    stopped = true;
    clearScheduledTimer();
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (visibilityListener) document.removeEventListener("visibilitychange", visibilityListener);
    if (unsubscribeAuth) unsubscribeAuth();
    activeStop = null;
  };

  activeStop = stop;
  return stop;
}

// Re-export the constants so callers can render the same thresholds in
// debug panels without reaching into the .js helper module.
export { AUTH_REFRESH_THRESHOLD_MS, AUTH_REFRESH_CHECK_INTERVAL_MS } from "./auth-refresh-decisions.js";
