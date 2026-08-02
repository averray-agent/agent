import { ApiError } from "@/lib/api/client";
import { getStoredToken } from "@/lib/auth/token-store";
import { buildPosterDefinition } from "@/lib/api/poster-definition";

/**
 * POST /jobs/draft with the same canonical definition the posting tool
 * builds (scripts/ops/post-external-bounty.mjs `loadDefinition`, inline
 * path). Field parity with that tool is deliberate: both clients must hash
 * to the same specHash for the same inputs.
 */

export interface DraftFormInput {
  deliverableKind: "report" | "pr";
  title: string;
  task: string;
  repo: string;
  issueNumber: number;
  issueUrl: string;
  acceptanceCriteria: string[];
  rewardUsdc: string;
}

export function buildDefinition(input: DraftFormInput): Record<string, unknown> {
  return buildPosterDefinition(input);
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
