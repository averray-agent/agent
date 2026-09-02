// Pure-logic decision module for the authed-layout guard (P3.7).
//
// The operator app is a Next.js static export, so we cannot enforce the
// auth boundary in middleware or on a per-request basis at a CDN. The
// guard must be a client-side wrapper at the authed-layout level. That
// wrapper is non-trivial because the FIRST client render (hydration of
// the static HTML) cannot see localStorage, so it always reports
// `authenticated: false` regardless of whether the visitor has a valid
// session — and we must NOT flash either the operator shell to a
// signed-out visitor OR a "redirecting…" frame to a signed-in operator
// during that one render.
//
// This module owns the three-state classifier so the component just
// has to dispatch on the returned action. Keeping the logic in plain JS
// + JSDoc (no React imports) is what lets `node --test` run it the same
// way `app/lib/ui/page-mode.js` is tested (P2.4 / Package E pattern).
//
//   ┌─────────────────┬───────────────────────────────────────────────┐
//   │ Action          │ Meaning                                       │
//   ├─────────────────┼───────────────────────────────────────────────┤
//   │ "checking"      │ Hydration has not yet read localStorage. The  │
//   │                 │ wrapper renders a neutral placeholder, NOT    │
//   │                 │ the operator shell or a redirect frame.       │
//   │ "render"        │ A live session is present. Render children.   │
//   │ "redirect"      │ No live session. Redirect to /sign-in with    │
//   │                 │ a `?next=<currentPath>` query so the post-    │
//   │                 │ sign-in handler can return the operator where │
//   │                 │ they tried to go.                             │
//   └─────────────────┴───────────────────────────────────────────────┘

/**
 * @typedef {Object} AuthGuardInput
 * @property {boolean} authenticated — current value of `useAuth().authenticated`.
 * @property {boolean} hydrated — did the post-mount effect run yet?
 *   The static HTML render and the FIRST client render are both
 *   pre-hydration; `useEffect` flipping a `useState` is what marks
 *   hydration complete. Set to `false` during these and `true` after.
 * @property {string} [currentPath] — the path the visitor is on (e.g.
 *   `/overview`, `/runs/detail`). Used to build the `?next=` query so
 *   the sign-in flow returns them where they tried to go. Defaults to
 *   `/overview` if absent or empty.
 */

/**
 * @typedef {Object} GuardAction
 * @property {"checking"|"render"|"redirect"} action
 * @property {string} [redirectTo] — when action === "redirect", the
 *   absolute path to navigate to (always starts with `/sign-in`).
 */

const SIGN_IN_PATH = "/sign-in";
const DEFAULT_NEXT_PATH = "/overview";

/**
 * Decide what the authed-layout guard should do for a given auth +
 * hydration state.
 *
 * @param {AuthGuardInput} input
 * @returns {GuardAction}
 */
export function decideAuthGuardAction(input) {
  const hydrated = Boolean(input?.hydrated);
  const authenticated = Boolean(input?.authenticated);

  if (!hydrated) {
    // Cannot trust `authenticated` yet — localStorage has not been
    // read. Hold the operator shell back until we know.
    return { action: "checking" };
  }

  if (authenticated) {
    return { action: "render" };
  }

  return {
    action: "redirect",
    redirectTo: buildSignInRedirect(input?.currentPath),
  };
}

/**
 * Build the `/sign-in?next=<path>` URL for a redirect. Exported so the
 * sign-in-page side of the contract can reuse the path-normalization
 * rules without copy-pasting them.
 *
 * Rules:
 *   - Falsy, non-string, or whitespace-only paths default to `/overview`
 *     (the operator home).
 *   - Paths that don't start with `/` are rejected (default applies).
 *     This prevents an attacker from injecting an absolute URL into the
 *     `next` param (`?next=https://evil.com`) by phishing-style flows.
 *   - The sign-in page itself is rejected (avoids `?next=/sign-in`
 *     loops when the guard re-fires after a sign-out).
 *   - The path is encoded with encodeURIComponent so query strings and
 *     hash fragments survive the round-trip intact.
 *
 * @param {unknown} currentPath
 * @returns {string}
 */
export function buildSignInRedirect(currentPath) {
  const next = normalizeNextPath(currentPath);
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeNextPath(value) {
  if (typeof value !== "string") return DEFAULT_NEXT_PATH;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_NEXT_PATH;
  // Reject absolute URLs and protocol-relative URLs outright.
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return DEFAULT_NEXT_PATH;
  }
  // Avoid `?next=/sign-in` loops if the guard ever fires from inside
  // the sign-in flow itself (defensive — current routing puts /sign-in
  // outside the authed layout, but rules should stand on their own).
  if (trimmed === SIGN_IN_PATH || trimmed.startsWith(`${SIGN_IN_PATH}?`)
      || trimmed.startsWith(`${SIGN_IN_PATH}/`)) {
    return DEFAULT_NEXT_PATH;
  }
  return trimmed;
}

// Re-exports for the test file + consumers that want the constants
// without recomputing them.
export const AUTH_GUARD_SIGN_IN_PATH = SIGN_IN_PATH;
export const AUTH_GUARD_DEFAULT_NEXT = DEFAULT_NEXT_PATH;
