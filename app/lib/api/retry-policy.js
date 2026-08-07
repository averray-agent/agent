/**
 * Retry policy for the SWR-backed API reads in `hooks.ts`.
 *
 * A request that failed because this session may not read the route fails
 * the same way on every attempt: the capability is missing, not momentarily
 * unavailable. Retrying it buys nothing and costs backend
 * `auth_failures_total` counts — mcp-server/src/protocols/http/server.js
 * increments that counter on every 401 *and* 403 — so a role-less browser
 * tab left open emits a steady trickle of auth failures that reads like
 * probing in the metrics.
 *
 * That trickle does not stop on its own. SWR's default `onErrorRetry` has no
 * `errorRetryCount`, so it retries forever, backing off only to
 * ~2^8 x `errorRetryInterval` (≈11–32 min, jittered). And because `useApi`
 * sets `revalidateOnFocus: false`, SWR's "stop retrying while inactive"
 * branch never applies, so a backgrounded tab keeps retrying too.
 *
 * The classification is `feedPresence`'s, deliberately: "locked" is exactly
 * the set of statuses this session can never read (401/403), and the surfaces
 * already render those feeds as locked rather than empty. One classifier, so
 * a feed that renders as locked is also a feed we stop asking for.
 *
 * Polling needs no equivalent guard: SWR skips the `refreshInterval` tick
 * while an error is cached (`!getCache().error` in swr@2.3.0
 * dist/index/index.mjs, "Only revalidate when the page is visible, online,
 * and not errored"), and a failed fetch does write its error to the cache.
 * The interval timer keeps ticking, but it issues no request.
 */
import { feedPresence } from "./feed-presence.js";

/**
 * @param {unknown} error the value SWR caught from the fetcher
 * @returns {boolean} false for auth-locked failures, true for anything that
 *   could plausibly succeed on a later attempt (5xx, network, unknown shapes)
 */
export function shouldRetryApiError(error) {
  return feedPresence({ error }) !== "locked";
}
