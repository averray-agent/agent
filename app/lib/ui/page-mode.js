/**
 * Operator-page truth modes.
 *
 * Every authed operator page must reflect one of four states so the
 * UI never silently masks reality:
 *
 *   - `live`     — backend returned data we trust; render it.
 *   - `empty`    — backend returned (e.g. []), and that's the truth
 *                  about the world. Render an "explain the next real
 *                  action" empty state, NOT fixture activity.
 *   - `degraded` — backend errored, timed out, or returned a payload
 *                  shape we can't render. Render a clearly-marked
 *                  degraded state with retry guidance, NOT fixture
 *                  activity.
 *   - `demo`     — opt-in fixture data, only reachable when
 *                  NEXT_PUBLIC_DEMO_MODE=true at build/runtime. A
 *                  persistent banner is mounted globally in this
 *                  case (see <DemoModeBanner />).
 *
 * The whole point of the contract: a production operator must be able
 * to tell from a single screen whether the data is live or not. See
 * `docs/AUDIT_REMEDIATION.md` finding P2.4 for the motivating audit
 * note. This module is the only place that decides what state a page
 * is in; pages call `classifyPageDataMode(...)` and render based on
 * the returned tag.
 *
 * Written as plain JS with JSDoc so it matches the project's existing
 * `node --test` runner pattern (`.mjs` siblings, no TS loader).
 *
 * @typedef {"live" | "empty" | "degraded" | "demo"} PageDataMode
 *
 * @typedef {Object} ClassifyInput
 * @property {boolean} [isLoading]  Initial fetch hasn't resolved yet (no data, no error).
 * @property {unknown} [error]      Network / shape / auth / API error.
 * @property {boolean} hasData      True when the API returned a payload AND it has at least one row.
 *
 * @typedef {Object} RequestHandle
 * @property {unknown} [data]
 * @property {unknown} [error]
 * @property {boolean} [isLoading]
 */

/**
 * Read the `NEXT_PUBLIC_DEMO_MODE` env flag. Resolved at module load
 * so the boolean is stable across renders for a given build.
 * Production deploys MUST set this to `false` (the absence of the
 * env var also resolves to false — the demo path is opt-in only).
 *
 * Implementation detail: process.env.NEXT_PUBLIC_* is inlined by
 * Next.js at build time, so this evaluates to the build-time string
 * literal on the client.
 *
 * @returns {boolean}
 */
export function isDemoModeEnabled() {
  if (typeof process === "undefined") return false;
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}

/**
 * Classify the truth-mode for a page given its data-fetch state.
 *
 * Precedence:
 *   1. Demo mode if NEXT_PUBLIC_DEMO_MODE=true (banner is mounted
 *      globally; pages can render fixtures freely).
 *   2. Degraded if there's an error — surface it, don't paper over.
 *   3. Live if the initial fetch is still in flight; pages should
 *      render their own loading skeleton (no fixtures).
 *   4. Empty if the fetch landed with no rows — this is a real state
 *      and pages should explain the next real action.
 *   5. Live when data is present.
 *
 * Note that `isLoading=true` resolves to `live` rather than a fifth
 * `loading` state on purpose — there's no risk of fixture exposure
 * while a request is in flight (pages render skeletons), and one
 * fewer state keeps the contract small.
 *
 * @param {ClassifyInput} input
 * @returns {PageDataMode}
 */
export function classifyPageDataMode(input) {
  if (isDemoModeEnabled()) return "demo";
  if (input.error) return "degraded";
  if (input.isLoading) return "live";
  if (!input.hasData) return "empty";
  return "live";
}

/**
 * Compose the boolean readiness flags from one or more SWR/useApi
 * request handles. Most operator pages combine several requests; this
 * keeps the per-page wiring small.
 *
 * @param {ReadonlyArray<RequestHandle>} requests
 * @param {boolean} hasData
 * @returns {PageDataMode}
 */
export function classifyFromRequests(requests, hasData) {
  const error = requests.find((r) => r.error)?.error;
  const isLoading = requests.some((r) => r.isLoading);
  return classifyPageDataMode({ error, isLoading, hasData });
}
