import { ApiError } from "@/lib/api/client";
import { getStoredToken } from "@/lib/auth/token-store";

/**
 * POST /jobs/draft with the same canonical definition the posting tool
 * builds (scripts/ops/post-external-bounty.mjs `loadDefinition`, inline
 * path). Field parity with that tool is deliberate: both clients must hash
 * to the same specHash for the same inputs.
 */

export interface DraftFormInput {
  title: string;
  task: string;
  repo: string;
  acceptanceCriteria: string[];
  rewardUsdc: string;
}

export function buildDefinition(input: DraftFormInput): Record<string, unknown> {
  return {
    title: input.title.trim() || `Audit and report on ${input.repo.trim()}`,
    description: input.task.trim(),
    category: "coding",
    tier: "starter",
    jobType: "work",
    requiredRole: "worker",
    rewardAsset: "USDC",
    rewardAmount: input.rewardUsdc.trim(),
    verifierMode: "human_fallback",
    escalationMessage: "The poster must review and approve the submission.",
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    input: {
      task: input.task.trim(),
      acceptanceCriteria: input.acceptanceCriteria,
      repo: input.repo.trim(),
    },
    acceptanceCriteria: input.acceptanceCriteria,
    claimTtlSeconds: 86_400,
    retryLimit: 1,
    requiresSponsoredGas: true,
  };
}

function resolveBaseUrl(): string {
  const override =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_BASE_URL : undefined;
  if (override) return override.replace(/\/+$/u, "");
  return "/api";
}

export async function postDraft(definition: Record<string, unknown>): Promise<unknown> {
  const token = getStoredToken();
  const response = await fetch(`${resolveBaseUrl()}/jobs/draft`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ definition }),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      (body as { message?: string } | undefined)?.message ??
      `Draft creation failed (HTTP ${response.status}).`;
    throw new ApiError(message, response.status, body);
  }
  return body;
}
