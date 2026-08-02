/**
 * Canonical posting-wizard verifier choices. Keeping the definition builder
 * independent from React makes the template-to-gate binding directly
 * regression-testable.
 */
const VERIFICATION_DISCLOSURES = Object.freeze({
  pr: Object.freeze({
    verifierMode: "github_pr",
    outputSchemaRef: "schema://jobs/github-pr-evidence-output",
    label: "Automated live GitHub PR gate",
    summary:
      "Averray checks the public PR against the selected repository and issue, binds its Averray disclosure footer to the actual claimant wallet or claim session, and re-derives live CI/check state and test evidence. A readable missing or mismatched claimant binding is rejected. If GitHub or the PR body is unreachable, rate-limited, private, partially unreadable, or the score is ambiguous, settlement escalates to human review and never auto-approves."
  }),
  report: Object.freeze({
    verifierMode: "human_fallback",
    outputSchemaRef: "schema://jobs/coding-output",
    label: "Human review",
    summary:
      "The poster reviews the open-ended audit report against the stated acceptance criteria; it is not auto-approved by a keyword or PR gate."
  })
});

export function verifierDisclosureForDeliverable(kind) {
  const disclosure = VERIFICATION_DISCLOSURES[kind];
  if (!disclosure) {
    throw new Error(`Unsupported poster deliverable kind: ${kind}`);
  }
  return disclosure;
}

export function buildPosterDefinition(input) {
  const disclosure = verifierDisclosureForDeliverable(input.deliverableKind);
  const repo = input.repo.trim();
  const issueNumber = Number(input.issueNumber);
  const issueUrl = input.issueUrl.trim();

  return {
    title: input.title.trim() || `Audit and report on ${repo}`,
    description: input.task.trim(),
    category: "coding",
    tier: "starter",
    jobType: "work",
    requiredRole: "worker",
    rewardAsset: "USDC",
    rewardAmount: input.rewardUsdc.trim(),
    verifierMode: disclosure.verifierMode,
    ...(input.deliverableKind === "pr" ? { requireClaimantBinding: true } : {}),
    escalationMessage:
      input.deliverableKind === "pr"
        ? "Live GitHub verification could not make a confident decision; escalate to human review."
        : "The poster must review and approve the submission.",
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: disclosure.outputSchemaRef,
    source: {
      type: "github_issue",
      repo,
      issueNumber,
      issueUrl
    },
    input: {
      task: input.task.trim(),
      acceptanceCriteria: input.acceptanceCriteria,
      repo
    },
    acceptanceCriteria: input.acceptanceCriteria,
    ...(input.deliverableKind === "pr"
      ? {
          agentInstructions: [
            "Append the standard Averray disclosure footer to the public pull request body.",
            "Bind the footer to this claim with at least one exact labelled line: `Agent identity: <claimant EVM wallet>` or `Claim session:  <claim session id>`. Use the wallet/session returned by the claim; another worker's footer is rejected."
          ]
        }
      : {}),
    claimTtlSeconds: 86_400,
    retryLimit: 1,
    requiresSponsoredGas: true
  };
}
