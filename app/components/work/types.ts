export interface HumanJobListing {
  id: string;
  title?: string;
  summary?: string;
  successCriteria?: string;
  category?: string;
  tier?: string;
  jobType?: string;
  verifierMode?: string;
  claimable?: boolean;
  effectiveState?: string;
  reason?: string | null;
  stake?: number | string | null;
  claimTtlSeconds?: number | null;
  requiresSponsoredGas?: boolean;
  onboardingWaiverEligible?: boolean;
  disposableProof?: boolean;
  reward?: { amount?: number | null; asset?: string | null };
  listedAt?: string | null;
  [key: string]: unknown;
}

export interface HumanJobDefinition extends Record<string, unknown> {
  id: string;
  title?: string;
  description?: string;
  category?: string;
  tier?: string;
  rewardAmount?: number;
  rewardAsset?: string;
  claimTtlSeconds?: number;
  requiresSponsoredGas?: boolean;
  onboardingWaiverEligible?: boolean;
  verifierMode?: string;
  claimable?: boolean;
  reason?: string | null;
  acceptanceCriteria?: string[];
  agentInstructions?: string[];
  submissionContract?: Record<string, unknown>;
  schemaContract?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  verificationContract?: Record<string, unknown>;
}

export interface WorkSessionRecord extends Record<string, unknown> {
  sessionId: string;
  jobId?: string;
  wallet?: string;
  status?: string;
  state?: string;
  workReceiptId?: string;
  claimExpiresAt?: string | null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}
