export type ProtocolSurface = "mcp" | "a2a" | "http";

export type RiskLevel = "low" | "medium" | "high";

export type VerifierMode = "deterministic" | "benchmark" | "quorum" | "human_fallback";

export interface BenchmarkVerifierConfig {
  handler: "benchmark";
  requiredKeywords: string[];
  minimumMatches: number;
}

export interface DeterministicVerifierConfig {
  handler: "deterministic";
  expectedOutputs: string[];
  matchMode: "exact" | "contains_all";
}

export interface HumanFallbackVerifierConfig {
  handler: "human_fallback";
  escalationMessage: string;
  autoApprove: boolean;
}

export type JobVerifierConfig =
  | BenchmarkVerifierConfig
  | DeterministicVerifierConfig
  | HumanFallbackVerifierConfig;

export interface AccountSummary {
  wallet: string;
  liquid: Record<string, number>;
  reserved: Record<string, number>;
  strategyAllocated: Record<string, number>;
  collateralLocked: Record<string, number>;
  debtOutstanding: Record<string, number>;
}

export interface ReputationView {
  skill: number;
  reliability: number;
  economic: number;
  tier: "starter" | "pro" | "elite";
}

export interface AgentProfile {
  wallet: string;
  capabilities: string[];
  supportedProtocols: ProtocolSurface[];
  preferredCategories: string[];
  preferredRiskLevel: RiskLevel;
  verifierCompatibility: VerifierMode[];
  minLiquidReserve: number;
  autoUnwindStrategies: boolean;
}

export interface JobDefinition {
  id: string;
  category: string;
  tier: "starter" | "pro" | "elite";
  rewardAsset: string;
  rewardAmount: number;
  verifierMode: VerifierMode;
  inputSchemaRef: string;
  outputSchemaRef: string;
  claimTtlSeconds: number;
  retryLimit: number;
  requiresSponsoredGas: boolean;
  verifierConfig: JobVerifierConfig;
}

export interface CreateJobInput {
  id: string;
  category: string;
  tier: "starter" | "pro" | "elite";
  rewardAmount: number;
  rewardAsset?: string;
  verifierMode: VerifierMode;
  inputSchemaRef?: string;
  outputSchemaRef?: string;
  claimTtlSeconds?: number;
  retryLimit?: number;
  requiresSponsoredGas?: boolean;
  verifierTerms?: string[];
  verifierMatchMode?: "exact" | "contains_all";
  verifierMinimumMatches?: number;
  escalationMessage?: string;
  autoApprove?: boolean;
}

export interface Recommendation {
  jobId: string;
  fitScore: number;
  netReward: number;
  eligible: boolean;
  explanation: string;
}

export interface JobSession {
  sessionId: string;
  wallet: string;
  jobId: string;
  chainJobId?: string;
  idempotencyKey: string;
  status: "preflighted" | "claimed" | "submitted" | "verifying" | "resolved" | "disputed";
  protocolHistory: ProtocolSurface[];
}

export interface VerificationVerdict {
  jobId: string;
  handler: string;
  outcome: "approved" | "rejected" | "disputed" | "timeout";
  score: number;
  reasonCode: string;
  detail: string;
}
