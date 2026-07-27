import { DEFAULT_ESCROW_ASSET_SYMBOL } from "../core/assets.js";

export const BOOTSTRAP_JOBS = [
  {
    id: "starter-coding-001",
    category: "coding",
    tier: "starter",
    rewardAsset: DEFAULT_ESCROW_ASSET_SYMBOL,
    rewardAmount: 5,
    title: "Starter coding verification (retired)",
    description: "Historical starter job retained for completed-session and badge lookups; its on-chain escrow is permanently Closed.",
    verifierMode: "benchmark",
    verifierConfig: {
      handler: "benchmark",
      requiredKeywords: ["complete", "verified", "output"],
      minimumMatches: 2
    },
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 3600,
    retryLimit: 1,
    requiresSponsoredGas: true,
    onboardingWaiverEligible: true,
    lifecycle: {
      status: "archived",
      reason: "Retired after its one-time mainnet escrow reached Closed; job ids are never reused."
    }
  },
  {
    id: "starter-coding-002",
    category: "coding",
    tier: "starter",
    rewardAsset: DEFAULT_ESCROW_ASSET_SYMBOL,
    rewardAmount: 0.2,
    title: "Validate Averray's active-chain discovery",
    description: "Compare Averray's public discovery manifest with its health endpoint and submit a structured verification report.",
    input: {
      task: "Fetch /agent-tools.json and /health from the public Averray API, compare every advertised wallet-mode chain id with health.auth.chainId, and report whether they agree.",
      acceptanceCriteria: [
        "Report health.auth.chainId.",
        "Report the chain id advertised by every wallet mode that includes a chain block.",
        "State whether all advertised chain ids match health.auth.chainId and identify any mismatch."
      ],
      repo: "https://github.com/averray-agent/agent"
    },
    acceptanceCriteria: [
      "The report names the health and manifest chain ids.",
      "The report gives a clear verified match or mismatch result.",
      "The submission follows schema://jobs/coding-output."
    ],
    agentInstructions: [
      "Use only public read-only endpoints.",
      "Submit the coding-output object directly; do not wrap it in an output field."
    ],
    verifierMode: "benchmark",
    verifierConfig: {
      handler: "benchmark",
      requiredKeywords: ["complete", "verified", "output"],
      minimumMatches: 2
    },
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 3600,
    retryLimit: 1,
    requiresSponsoredGas: true,
    onboardingWaiverEligible: true
  },
  {
    id: "governance-pro-001",
    category: "governance",
    tier: "pro",
    rewardAsset: DEFAULT_ESCROW_ASSET_SYMBOL,
    rewardAmount: 25,
    verifierMode: "deterministic",
    verifierConfig: {
      handler: "deterministic",
      expectedOutputs: ["governance-approved-summary", "vote-yes rationale"],
      matchMode: "contains_all"
    },
    inputSchemaRef: "schema://jobs/governance-input",
    outputSchemaRef: "schema://jobs/governance-output",
    claimTtlSeconds: 7200,
    retryLimit: 2,
    requiresSponsoredGas: false
  }
];
