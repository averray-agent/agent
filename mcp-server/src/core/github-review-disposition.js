// Persisted poll evidence only: health must never fetch GitHub or sign to decide
// whether a submitted session is waiting for a maintainer or needs an operator.
export function githubReviewDisposition(observation) {
  if (observation?.upstreamState === "open" && observation?.merged !== true) return "waiting_for_merge";
  if ((observation?.upstreamState === "closed" && observation?.merged === false)
    || (observation?.merged === true && observation?.previewOutcome === "approved")) return "operator_review";
  return "awaiting_evidence";
}
