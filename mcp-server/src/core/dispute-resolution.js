import { keccak256, toUtf8Bytes } from "ethers";
import { ValidationError } from "./errors.js";
import { buildContentRecord } from "./content-addressed-store.js";

export const ARBITRATOR_SLA_SECONDS = 14 * 24 * 60 * 60;

/**
 * Stable id for the dispute associated with a session. Hashed from
 * the session id so the same dispute id is computed everywhere
 * (HTTP route, state-store mutation receipts, profile dispute
 * history). Stays usable as a public identifier without leaking the
 * raw session id.
 */
export function disputeIdForSession(sessionId) {
  return `dispute-${keccak256(toUtf8Bytes(String(sessionId))).slice(2, 14)}`;
}

/**
 * Add a fixed seconds offset to an ISO timestamp, returning the
 * same ISO format. Used to derive the SLA window end for a dispute
 * (`openedAt + ARBITRATOR_SLA_SECONDS`). Treats unparseable inputs
 * as undefined so the caller can render `—` rather than `NaN`.
 */
export function addSecondsIso(iso, seconds) {
  if (typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t + seconds * 1000).toISOString();
}

export const DISPUTE_REASON_CODES = Object.freeze({
  upheld: "DISPUTE_LOST",
  dismissed: "DISPUTE_OVERTURNED",
  split: "DISPUTE_PARTIAL",
  timeout: "ARB_TIMEOUT"
});

export function normalizeDisputeVerdict(value) {
  const verdict = String(value ?? "").trim().toLowerCase();
  if (verdict === "upheld" || verdict === "uphold") return "upheld";
  if (verdict === "dismissed" || verdict === "dismiss" || verdict === "rejected" || verdict === "reject") {
    return "dismissed";
  }
  if (verdict === "split" || verdict === "partial" || verdict === "request-more") return "split";
  if (verdict === "timeout" || verdict === "arb_timeout") return "timeout";
  throw new ValidationError("verdict must be one of upheld, dismissed, split.");
}

export function buildDisputeResolution({ verdict, remainingPayout, workerPayout = undefined } = {}) {
  const normalized = normalizeDisputeVerdict(verdict);
  const remaining = normalizePayout(remainingPayout, "remainingPayout");

  if (normalized === "upheld") {
    return {
      verdict: normalized,
      workerPayout: 0,
      reasonCode: DISPUTE_REASON_CODES.upheld,
      nextSessionStatus: "rejected",
      releaseAction: "slash-to-treasury"
    };
  }

  if (normalized === "dismissed" || normalized === "timeout") {
    return {
      verdict: normalized,
      workerPayout: remaining,
      reasonCode: DISPUTE_REASON_CODES[normalized],
      nextSessionStatus: "resolved",
      releaseAction: "return-to-depositor"
    };
  }

  const explicit = workerPayout === undefined || workerPayout === null || workerPayout === ""
    ? defaultPartialPayout(remaining)
    : normalizePayout(workerPayout, "workerPayout");
  if (explicit <= 0 || explicit > remaining) {
    throw new ValidationError("workerPayout for split verdicts must be greater than zero and no more than the remaining payout.", {
      workerPayout: explicit,
      remainingPayout: remaining
    });
  }

  return {
    verdict: normalized,
    workerPayout: explicit,
    reasonCode: DISPUTE_REASON_CODES.split,
    nextSessionStatus: "resolved",
    releaseAction: "return-to-depositor",
    payoutSource: workerPayout === undefined || workerPayout === null || workerPayout === ""
      ? "default_half_remaining"
      : "operator_supplied"
  };
}

function normalizePayout(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ValidationError(`${label} must be a non-negative number.`);
  }
  return parsed;
}

function defaultPartialPayout(remaining) {
  if (remaining <= 1) {
    return remaining;
  }
  return Math.floor(remaining / 2);
}

function normalizeOptionalString(value) {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeNumberLike(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * Normalize a verdict to its canonical token specifically for request
 * hashing. Lowercases and folds synonyms (uphold/dismiss/partial/...)
 * to the same canonical value the resolver uses so equivalent replays
 * hit the idempotency cache instead of returning 409.
 */
export function normalizeDisputeVerdictForRequestHash(value) {
  const verdict = normalizeOptionalString(value)?.toLowerCase();
  if (verdict === "uphold") return "upheld";
  if (verdict === "dismiss" || verdict === "rejected" || verdict === "reject") return "dismissed";
  if (verdict === "partial" || verdict === "request-more") return "split";
  if (verdict === "arb_timeout") return "timeout";
  return verdict;
}

/**
 * Project a verdict request body into the shape the idempotency hash
 * builder uses. Same shape, regardless of whether the caller sent
 * `verdict` or its `outcome` synonym, so an equivalent retry replays.
 */
export function normalizeDisputeVerdictRequestPayload(id, payload = {}) {
  return {
    disputeId: id,
    verdict: normalizeDisputeVerdictForRequestHash(payload?.verdict ?? payload?.outcome),
    workerPayout: normalizeNumberLike(payload?.workerPayout ?? payload?.payoutAmount),
    rationale: normalizeOptionalString(payload?.rationale),
    reasoningHash: normalizeOptionalString(payload?.reasoningHash),
    metadataURI: normalizeOptionalString(payload?.metadataURI)
  };
}

/**
 * Project a release request body into the idempotency-hash shape.
 * Falls back to the dispute's staked amount when the caller omits
 * `amount`, so the receipt is deterministic from the dispute alone.
 */
export function normalizeDisputeReleaseRequestPayload(id, dispute, payload = {}) {
  return {
    disputeId: id,
    action: normalizeOptionalString(payload?.action) || "release",
    amount: normalizeNumberLike(payload?.amount ?? dispute?.stakedAmount ?? 0)
  };
}

/**
 * Build the public content-URI for a dispute-reasoning hash. Uses
 * `PUBLIC_BASE_URL` when configured (`https://api.averray.com/content/0x...`)
 * and falls back to a `urn:` form so the URI is still stable in
 * environments without a public base.
 */
export function publicContentUri(hash, { publicBaseUrl } = {}) {
  const normalized = typeof hash === "string" && /^0x[a-fA-F0-9]{64}$/u.test(hash)
    ? hash
    : undefined;
  if (!normalized) {
    return "";
  }
  const base = typeof publicBaseUrl === "string" ? publicBaseUrl.trim().replace(/\/+$/u, "") : "";
  return base ? `${base}/content/${normalized}` : `urn:averray:content:${normalized}`;
}

/**
 * Build the arbitrator-reasoning content record and its `metadataURI`
 * pointer in one place. The content record is keyed by the keccak hash
 * of the canonical reasoning payload, so the same inputs always
 * produce the same `reasoningHash`; replaying a verdict request never
 * spawns a duplicate content record.
 */
export function buildDisputeReasoningReceipt({
  id,
  dispute,
  payload,
  auth,
  verdict,
  decidedAt,
  publicBaseUrl
}) {
  const rationale = typeof payload?.rationale === "string" ? payload.rationale.trim() : "";
  const explicitHash = typeof payload?.reasoningHash === "string" && /^0x[a-fA-F0-9]{64}$/u.test(payload.reasoningHash)
    ? payload.reasoningHash.toLowerCase()
    : undefined;
  const reasoningPayload = {
    disputeId: id,
    sessionId: dispute.sessionId,
    verdict,
    rationale,
    decidedBy: auth.wallet,
    decidedAt
  };
  const contentRecord = buildContentRecord({
    payload: reasoningPayload,
    contentType: "arbitrator_reasoning",
    ownerWallet: dispute.claimant,
    verdict: verdict === "upheld" ? "fail" : "pass",
    createdAt: decidedAt
  });
  if (explicitHash && explicitHash !== contentRecord.hash) {
    throw new ValidationError("reasoningHash does not match canonical dispute reasoning payload.", {
      expected: contentRecord.hash,
      actual: explicitHash
    });
  }
  const reasoningHash = contentRecord.hash;
  const metadataURI = typeof payload?.metadataURI === "string" && payload.metadataURI.trim()
    ? payload.metadataURI.trim()
    : publicContentUri(reasoningHash, { publicBaseUrl });
  return { rationale, reasoningHash, metadataURI, contentRecord };
}
