export const INCONCLUSIVE_ATTRIBUTIONS = Object.freeze([
  "infrastructure",
  "contract",
  "candidate",
  "verifier"
]);

export function workerConsequenceFor(verdict) {
  return verdict === "INCONCLUSIVE" ? "none" : null;
}

export function verifierReputationSignalFor({ verdict, attribution, reason, details }) {
  if (verdict !== "INCONCLUSIVE" || attribution !== "verifier") return null;
  return {
    kind: "evidence_completeness_gap",
    reason,
    details
  };
}

export function assertInconclusiveAttribution(verdict, attribution) {
  if (verdict === "INCONCLUSIVE" && !INCONCLUSIVE_ATTRIBUTIONS.includes(attribution)) {
    throw new Error(
      `INCONCLUSIVE verdict is missing ${INCONCLUSIVE_ATTRIBUTIONS.join("/")} attribution`
    );
  }
}
