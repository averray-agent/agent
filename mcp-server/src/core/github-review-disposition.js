// Persisted poll evidence only: health must never fetch GitHub or sign to decide
// whether a submitted session is waiting for a maintainer or needs an operator.
export function githubReviewDisposition(observation) {
  // A self-merge hold keeps the payout with a person. It is not an overdue
  // auto-settlement and it is not a rejection.
  if (observation?.holdReason === "github_pr_self_merge_review") return "human_review";
  if (observation?.upstreamState === "open" && observation?.merged !== true) return "waiting_for_merge";
  if ((observation?.upstreamState === "closed" && observation?.merged === false)
    || (observation?.merged === true && observation?.previewOutcome === "approved")) return "operator_review";
  return "awaiting_evidence";
}
