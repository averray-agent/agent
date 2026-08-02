import { ApiError } from "@/lib/api/client";
import { getStoredToken } from "@/lib/auth/token-store";

/**
 * C3 review client. GET /jobs/:id/submission is consumed via useApi in the
 * component (SWR); this module owns the decision POST and the defensive
 * shaping of payloads whose exact contents the UI must never invent.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export interface SubmissionView {
  worker: string | null;
  submittedAt: string | null;
  /** Review deadline ISO string — rendered only when the API provides it. */
  deadline: string | null;
  reviewStatus: string;
  /** Best link to the deliverable (PR url etc.), if one exists. */
  deliverableUrl: string | null;
  /** Text body of the deliverable for inline display, if present. */
  deliverableText: string | null;
}

/** Shape the submission payload without inventing fields. */
/** First https URL inside a text blob, for linking string-form deliverables. */
function firstUrl(value: string | null): string | null {
  if (!value) return null;
  const match = /https:\/\/[^\s"'<>)\]]+/u.exec(value);
  // Sentence punctuation glued to a URL is prose, not path.
  return match ? match[0].replace(/[.,;:!?]+$/u, "") : null;
}

export function buildSubmissionView(payload: unknown): SubmissionView {
  const record = asRecord(payload);
  const review = asRecord(record.review);
  const deliverable = asRecord(record.deliverable);
  // The live coding-output schema allows `output` to be a plain string (the
  // #625 dogfood submitted exactly that, PR URL inside) as well as an object.
  const outputString = text(deliverable.output);
  const output = asRecord(deliverable.output);
  const deliverableUrl =
    text(output.prUrl) ??
    text(deliverable.prUrl) ??
    text(output.url) ??
    firstUrl(outputString) ??
    firstUrl(text(deliverable.summary)) ??
    null;
  const textParts = [
    text(deliverable.summary),
    outputString ?? text(output.summary) ?? text(output.report),
  ].filter((part): part is string => part !== null);
  const deliverableText =
    textParts.length > 0
      ? [...new Set(textParts)].join("\n\n")
      : (deliverableUrl ? null : text(deliverable.evidence)) ?? null;
  return {
    worker: text(record.worker),
    submittedAt: text(record.submittedAt),
    deadline: text(review.deadline),
    reviewStatus: text(review.status) ?? "awaiting_decision",
    deliverableUrl,
    deliverableText,
  };
}

/** Human-relative time until an ISO deadline; null when absent or invalid. */
export function deadlineLabel(deadlineIso: string | null, now = Date.now()): string | null {
  if (!deadlineIso) return null;
  const target = Date.parse(deadlineIso);
  if (!Number.isFinite(target)) return null;
  const remaining = target - now;
  if (remaining <= 0) return "window expired — escalation takes over";
  const hours = Math.floor(remaining / 3_600_000);
  const days = Math.floor(hours / 24);
  return days >= 1 ? `decide within ${days}d ${hours - days * 24}h` : `decide within ${hours}h`;
}

export interface DecisionResult {
  decision: string | null;
  status: string | null;
  txHash: string | null;
  blockNumber: string | null;
}

export function buildDecisionResult(payload: unknown): DecisionResult {
  const record = asRecord(payload);
  const payout = asRecord(record.payoutTx);
  const dispute = asRecord(record.disputeTx);
  return {
    decision: text(record.decision),
    status: text(record.status),
    txHash: text(payout.txHash) ?? text(dispute.txHash),
    blockNumber:
      payout.blockNumber !== undefined
        ? String(payout.blockNumber)
        : dispute.blockNumber !== undefined
          ? String(dispute.blockNumber)
          : null,
  };
}

function resolveBaseUrl(): string {
  const override =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_BASE_URL : undefined;
  if (override) return override.replace(/\/+$/u, "");
  return "/api";
}

export async function postReview(
  jobId: string,
  verdict: "approve" | "reject",
  reason: string
): Promise<unknown> {
  const token = getStoredToken();
  const response = await fetch(
    `${resolveBaseUrl()}/jobs/${encodeURIComponent(jobId)}/review`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ verdict, reason }),
    }
  );
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      (body as { message?: string } | undefined)?.message ??
      `Review failed (HTTP ${response.status}).`;
    throw new ApiError(message, response.status, body);
  }
  return body;
}
