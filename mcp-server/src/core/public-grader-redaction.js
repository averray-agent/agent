const PUBLIC_CONFIG_FIELDS = {
  deterministic: ["matchMode"],
  benchmark: ["anchorEvidence"],
  human_fallback: ["autoApprove", "escalationMessage"],
  github_pr: ["minimumScore", "requireIssueReference", "requireTestEvidence", "acceptMergedAsApproved", "requireClaimantBinding"]
};

function publicVerifierConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const keys = ["handler", "version", ...(PUBLIC_CONFIG_FIELDS[config.handler] ?? [])];
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(config, key)).map((key) => [key, config[key]]));
}

// Copy at the worker-facing response boundary, never mutate the definition or
// claim snapshot used for verification. Only verifierConfig is restricted:
// input.rubric and similarly named public task inputs must remain intact.
export function redactPublicGraderFields(value) {
  if (Array.isArray(value)) return value.map(redactPublicGraderFields);
  if (!value || typeof value !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, key === "verifierConfig" ? publicVerifierConfig(entry) : redactPublicGraderFields(entry)]));
}
