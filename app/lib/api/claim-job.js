/**
 * @typedef {[string, { method?: string, headers?: Record<string, string>, body?: string }]} FetcherKey
 * @typedef {(key: FetcherKey) => Promise<unknown>} Fetcher
 *
 * @typedef {Object} ClaimJobInput
 * @property {string} jobId
 * @property {Fetcher} fetcher   network seam — accepts a `[path, init]` tuple, returns the JSON-parsed body
 *
 * @typedef {Object} ClaimJobOutcome
 * @property {"claimed"} status
 * @property {unknown} session   `/jobs/claim` response — the claim session
 */

/**
 * Claim a job for the signed-in wallet.
 *
 * Deliberately does NOT send `idempotencyKey`. The route defaults it to
 * `<wallet>:<jobId>` (see mcp-server/src/protocols/http/job-routes.js), so a
 * double-click, a retried request, or a reconnect all replay the same claim
 * session instead of opening a second one. Sending a per-click key here would
 * *remove* that protection, which is the opposite of what a button needs.
 *
 * Pure orchestration behind a fetcher seam, matching runGuardedSubmit, so the
 * React layer owns state and the regression test can assert the request shape
 * without mounting a component.
 *
 * Errors are not swallowed: the caller surfaces the API's own message so a
 * `retry_limit_exhausted` or `idempotency_key_already_used` conflict reaches
 * the operator instead of a generic failure.
 *
 * @param {ClaimJobInput} input
 * @returns {Promise<ClaimJobOutcome>}
 */
export async function runClaimJob({ jobId, fetcher }) {
  if (typeof jobId !== "string" || !jobId.trim()) {
    throw new Error("A job id is required to claim.");
  }
  const session = await fetcher([
    "/jobs/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: jobId.trim() })
    }
  ]);
  return { status: "claimed", session };
}
