/**
 * Claim-state model for the runs surface.
 *
 * The backend emits two layers of "state" on every job:
 *   - `lifecycle.{status,state}` — content/job lifecycle (open / paused /
 *     archived / stale). Tells the operator whether the row is in the
 *     catalog at all.
 *   - `claimStatus` — claim lifecycle (claimable / claimed / expired /
 *     submitted / exhausted). Tells the operator (and any worker) whether
 *     the row can currently be acted on.
 *
 * A row can be `lifecycle.status: "open"` AND `claimStatus.claimable:
 * false` — for example after every retry has been used up. The UI must
 * never decide claimability from `lifecycle` alone; that's the failure
 * mode the new `claimabilitySource` hint warns about.
 *
 * This module is the single source of truth for parsing/labelling the
 * claim block. Both the queue rows (which carry the compact top-level
 * fields) and the detail panel (which carries the full `claimStatus`
 * object) feed through it.
 */

export type ClaimEffectiveState =
  | "claimable"
  | "claimed"
  | "expired"
  | "submitted"
  | "exhausted";

export type ClaimRawState =
  | "open"
  | "claimed"
  | "expired"
  | "submitted"
  | "exhausted";

/**
 * Free-form reason code attached to the claim block. The backend may
 * emit codes we don't have a label for yet — `formatClaimReason`
 * falls back to the raw code rather than swallowing it.
 */
export type ClaimReason = string;

export interface ClaimSummary {
  /** Compact `effectiveState` from the row payload. */
  state: ClaimEffectiveState;
  /** True when the current viewer (or any worker, for the public feed)
   *  can claim. The UI gates Claim/Start buttons on this. */
  claimable: boolean;
  /** Machine reason code; pair with `formatClaimReason` for display. */
  reason: ClaimReason;
  /** Total attempts allowed across the whole job (including the
   *  current one when claimed). */
  retryLimit: number;
  /** Attempts used so far. */
  claimAttemptCount: number;
  /** What's left in the retry budget. 0 means exhausted. */
  remainingClaimAttempts: number;
}

export interface ClaimStatusDetail extends ClaimSummary {
  /** Per-viewer hint: even if `claimable` is true on the row, this
   *  flag flips false when the viewer's wallet has already claimed.
   *  Null when no viewer is signed in (public feed). */
  currentWalletCanClaim: boolean | null;
  /** Wallet that currently holds the claim, if any. */
  claimedBy?: string;
  /** ISO timestamp of when the active claim opened. */
  claimedAt?: string;
  /** ISO timestamp of when the active claim's TTL expires. */
  claimExpiresAt?: string;
  /** Sequence number of the active claim attempt (1-indexed). */
  claimNumber?: number;
  /** Active session id when the row is in `claimed` / `submitted`. */
  sessionId?: string;
  /** ISO timestamp of when a prior claim expired (drives the
   *  "claim_ttl_expired_reopen_available" affordance). */
  expiredAt?: string;
}

const ALLOWED_EFFECTIVE: ClaimEffectiveState[] = [
  "claimable",
  "claimed",
  "expired",
  "submitted",
  "exhausted",
];

/**
 * Compact-row claim block builder. Reads the top-level fields the
 * backend now emits on every `/jobs[]` row (and `/admin/jobs[]`).
 * Returns `undefined` when the row is missing the contract entirely
 * — the caller falls back to the legacy `state`-based render so we
 * don't break older fixtures.
 */
export function buildClaimSummary(raw: unknown): ClaimSummary | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const state = parseEffectiveState(record.effectiveState);
  if (!state) return undefined;
  return {
    state,
    claimable: record.claimable === true,
    reason: typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : "claimable",
    retryLimit: nonNegInt(record.retryLimit),
    claimAttemptCount: nonNegInt(record.claimAttemptCount),
    remainingClaimAttempts: nonNegInt(record.remainingClaimAttempts),
  };
}

/**
 * Detail-page builder. Reads from `/jobs/definition`'s `claimStatus`
 * block. Returns undefined for the same legacy-fallback reason.
 */
export function buildClaimStatusDetail(raw: unknown): ClaimStatusDetail | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const summary = buildClaimSummary(record);
  if (!summary) return undefined;
  return {
    ...summary,
    currentWalletCanClaim:
      typeof record.currentWalletCanClaim === "boolean"
        ? record.currentWalletCanClaim
        : null,
    ...(text(record.claimedBy) ? { claimedBy: text(record.claimedBy) } : {}),
    ...(text(record.claimedAt) ? { claimedAt: text(record.claimedAt) } : {}),
    ...(text(record.claimExpiresAt)
      ? { claimExpiresAt: text(record.claimExpiresAt) }
      : {}),
    ...(typeof record.claimNumber === "number"
      ? { claimNumber: nonNegInt(record.claimNumber) }
      : {}),
    ...(text(record.sessionId) ? { sessionId: text(record.sessionId) } : {}),
    ...(text(record.expiredAt) ? { expiredAt: text(record.expiredAt) } : {}),
  };
}

/**
 * Pull the claim block off a `/jobs/definition?jobId=...` payload —
 * which wraps the block under `claimStatus`. Falls back to the bare
 * top-level fields if the payload is the compact-row shape.
 */
export function extractClaimStatus(payload: unknown): ClaimStatusDetail | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  if (record.claimStatus && typeof record.claimStatus === "object") {
    return buildClaimStatusDetail(record.claimStatus);
  }
  return buildClaimStatusDetail(record);
}

/** Pretty label for the row pill / badge. */
export const CLAIM_STATE_LABEL: Record<ClaimEffectiveState, string> = {
  claimable: "Claimable",
  claimed: "Claimed",
  expired: "Expired",
  submitted: "Submitted",
  exhausted: "Exhausted",
};

/** Tone the existing palette already covers. */
export const CLAIM_STATE_TONE: Record<
  ClaimEffectiveState,
  "ok" | "neutral" | "warn" | "muted" | "bad"
> = {
  claimable: "ok",
  claimed: "neutral",
  submitted: "warn",
  expired: "warn",
  exhausted: "muted",
};

const REASON_LABEL: Record<string, string> = {
  claimable: "Ready to claim",
  claimed_by_other_wallet: "Claimed by another wallet",
  already_claimed_by_current_wallet: "Already claimed by this wallet",
  retry_limit_exhausted: "Retry limit exhausted",
  claim_ttl_expired_reopen_available: "Expired claim can be reopened",
  paused: "Paused — not claimable",
  archived: "Archived — not claimable",
  stale: "Stale — not claimable",
  submitted: "Submitted — awaiting verification",
};

/**
 * Render a backend reason code as operator-readable copy. Unknown codes
 * fall back to the raw string with underscores replaced by spaces so we
 * never silently swallow a new reason kind the backend starts emitting.
 */
export function formatClaimReason(reason: ClaimReason): string {
  if (REASON_LABEL[reason]) return REASON_LABEL[reason];
  return reason.replace(/_/g, " ");
}

function parseEffectiveState(value: unknown): ClaimEffectiveState | null {
  if (typeof value !== "string") return null;
  return ALLOWED_EFFECTIVE.includes(value as ClaimEffectiveState)
    ? (value as ClaimEffectiveState)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
