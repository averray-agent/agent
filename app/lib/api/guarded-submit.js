/**
 * @typedef {[string, { method?: string, headers?: Record<string, string>, body?: string }]} FetcherKey
 * @typedef {(key: FetcherKey) => Promise<unknown>} Fetcher
 *
 * @typedef {Object} GuardedSubmitInput
 * @property {string} jobId
 * @property {string} sessionId
 * @property {unknown} submission   parsed submission body, ready to JSON.stringify
 * @property {boolean} structuredSubmissionRequired
 * @property {Fetcher} fetcher       network seam — accepts a `[path, init]` tuple, returns the JSON-parsed body
 *
 * @typedef {Object} GuardedSubmitOutcome
 * @property {"validation_failed" | "submitted"} status
 * @property {unknown} [validation]      validation-endpoint body when validation gates the submit
 * @property {unknown} [submitResponse]  /jobs/submit response on success
 */

/**
 * Submit pipeline for the operator app. When the job declares
 * `structuredSubmissionRequired`, runs `POST /jobs/validate-submission`
 * *before* `POST /jobs/submit` and refuses to fire the submit when the
 * validation response is not `{ valid: true }`. The validation response
 * is returned so the caller can render the schema-violation path
 * without re-fetching.
 *
 * Pure orchestration so the React layer can wrap it for state updates
 * and the regression test can verify the "invalid → no submit" promise
 * without mounting the component.
 *
 * @param {GuardedSubmitInput} input
 * @returns {Promise<GuardedSubmitOutcome>}
 */
export async function runGuardedSubmit({
  jobId,
  sessionId,
  submission,
  structuredSubmissionRequired,
  fetcher
}) {
  if (structuredSubmissionRequired) {
    const validation = await fetcher([
      "/jobs/validate-submission",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, submission })
      }
    ]);
    if (!isValidValidationResponse(validation)) {
      return { status: "validation_failed", validation };
    }
  }
  const submitResponse = await fetcher([
    "/jobs/submit",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, submission })
    }
  ]);
  return { status: "submitted", submitResponse };
}

function isValidValidationResponse(value) {
  return (
    value !== null
    && typeof value === "object"
    && /** @type {{ valid?: unknown }} */ (value).valid === true
  );
}
