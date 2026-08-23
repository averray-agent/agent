/**
 * Retry policy for the SWR-backed API reads in `hooks.ts`.
 *
 * A 401 cannot recover inside the data hook: the wallet session itself must
 * refresh or return to sign-in. Retrying it buys nothing and costs backend
 * `auth_failures_total` counts.
 *
 * That trickle does not stop on its own. SWR's default `onErrorRetry` has no
 * `errorRetryCount`, so it retries forever, backing off only to
 * ~2^8 x `errorRetryInterval` (≈11–32 min, jittered). And because `useApi`
 * sets `revalidateOnFocus: false`, SWR's "stop retrying while inactive"
 * branch never applies, so a backgrounded tab keeps retrying too.
 *
 * A 403 is different now that the authed layout has an operator-role wall:
 * non-entitled wallets never mount these hooks. A 403 seen by an entitled
 * admin/verifier/viewer therefore means an operator feed is temporarily out
 * of alignment with the issued read capabilities. Keep probing so the UI's
 * "unreachable — retrying" copy is operationally true and a backend rollout
 * can recover the live room without a page reload.
 *
 * Polling needs no equivalent guard: SWR skips the `refreshInterval` tick
 * while an error is cached (`!getCache().error` in swr@2.3.0
 * dist/index/index.mjs, "Only revalidate when the page is visible, online,
 * and not errored"), and a failed fetch does write its error to the cache.
 * The interval timer keeps ticking, but it issues no request.
 */
/**
 * @param {unknown} error the value SWR caught from the fetcher
 * @returns {boolean} false only for an invalid/expired session (401), true for
 *   feed denials and failures that can recover on a later attempt
 */
export function shouldRetryApiError(error) {
  const status = error && typeof error === "object" ? error.status : undefined;
  return status !== 401;
}
