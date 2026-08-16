export const ARRIVAL_STAGES = Object.freeze([
  "reached",
  "browsed",
  "evaluated",
  "identified",
  "authenticated",
  "claimed",
  "submitted"
]);

export const ARRIVAL_IDENTITY_STAGES = Object.freeze([
  "identified",
  "authenticated",
  "claimed",
  "submitted",
  "settled"
]);

export const HTTP_ROUTE_STAGE = Object.freeze({
  "GET /jobs": "browsed",
  "GET /jobs/definition": "evaluated",
  "GET /jobs/preflight": "evaluated",
  "GET /jobs/estimate-reward": "evaluated",
  "GET /jobs/explain-eligibility": "evaluated",
  "POST /jobs/validate-submission": "evaluated",
  "POST /auth/nonce": "identified",
  "POST /auth/verify": "authenticated",
  "POST /auth/refresh": "authenticated",
  "POST /jobs/claim": "claimed",
  "POST /jobs/submit": "submitted"
});

// Deliberately maps intent, not mechanics. fetchAuthNonce is "identified"
// because the caller has revealed the wallet it intends to use.
export const TOOL_STAGE = Object.freeze({
  getPlatformCapabilities: "browsed",
  listJobs: "browsed",
  getJobDefinition: "browsed",
  preflightJob: "evaluated",
  estimateNetReward: "evaluated",
  explainEligibility: "evaluated",
  validateJobSubmission: "evaluated",
  fetchAuthNonce: "identified",
  verifySiwe: "authenticated",
  refreshAuthToken: "authenticated",
  claimJob: "claimed",
  submitWork: "submitted"
});

export function stageRank(stage) {
  if (stage === "settled") return ARRIVAL_STAGES.length;
  const index = ARRIVAL_STAGES.indexOf(stage);
  return index === -1 ? -1 : index;
}
