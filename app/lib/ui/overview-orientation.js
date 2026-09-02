/**
 * Decide whether to show the Overview first-load orientation card
 * (roadmap A4).
 *
 * Early-state = a signed-in operator whose room has no activity yet
 * (no open runs, no sessions, no receipts) and who has not dismissed the
 * card. The card points them at the first useful action; once the room
 * has any activity, or the operator dismisses it, it stays gone.
 *
 * TRUTH-BOUNDARY: we only decide "empty" once the activity requests have
 * RESOLVED. While they are still loading we return `false`, so the card
 * never flashes in on first paint and then vanishes when data arrives —
 * a loading room must not render as an empty one.
 *
 * Note: unauthenticated visitors never reach `/overview` (the AuthedGuard
 * redirects them to `/sign-in`), so `authenticated` is effectively always
 * true on this surface. It is kept as an explicit guard for correctness
 * and testability rather than relying on that invariant.
 *
 * @typedef {Object} OverviewOrientationInput
 * @property {boolean} dismissed         Operator dismissed the card (persisted).
 * @property {boolean} authenticated     Operator is signed in.
 * @property {boolean} activityResolved  Activity requests have resolved (data or error), not loading.
 * @property {number}  roomActivityCount Open runs + sessions + receipts.
 *
 * @param {OverviewOrientationInput | null | undefined} input
 * @returns {boolean}
 */
export function shouldShowOverviewOrientation(input) {
  if (!input) return false;
  if (input.dismissed) return false;
  if (!input.authenticated) return false;
  // Loading ≠ empty: hold the card back until we actually know.
  if (!input.activityResolved) return false;
  return Number(input.roomActivityCount) === 0;
}

/** localStorage key for the persisted dismissal (A4). */
export const OVERVIEW_ORIENTATION_DISMISSED_KEY =
  "averray:overview-orientation-dismissed";
