export function decisionToVerdict(decision) {
  if (decision === "uphold") return "upheld";
  if (decision === "reject") return "dismissed";
  if (decision === "split") return "split";
  throw new TypeError(`Unknown dispute decision: ${String(decision)}`);
}

export function verdictToDecision(value) {
  const verdict = String(value ?? "").trim().toLowerCase();
  if (verdict === "upheld" || verdict === "uphold") return "uphold";
  if (verdict === "dismissed" || verdict === "reject" || verdict === "rejected") {
    return "reject";
  }
  if (verdict === "split" || verdict === "partial" || verdict === "request-more") {
    return "split";
  }
  return null;
}

export function releaseAmountForDecision({
  decision,
  remainingPayout,
  stakeFrozen,
}) {
  const remaining = Number.isFinite(remainingPayout) ? remainingPayout : stakeFrozen;
  if (decision === "split") {
    return remaining <= 1 ? remaining : Math.floor(remaining / 2);
  }
  if (decision === "reject") {
    return remaining;
  }
  return stakeFrozen;
}
