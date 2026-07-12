import { ValidationError } from "./errors.js";
import { hashCanonicalContent } from "./canonical-content.js";
import { buildBadgeSigners } from "./badge-metadata.js";

export const RUN_RECEIPT_SCHEMA_VERSION = "averray.run-receipt.v1";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
const FINAL_OUTCOMES = new Set(["approved", "rejected"]);

/**
 * Build the immutable document attesting a verification verdict.
 *
 * This is deliberately separate from the badge document: approval and
 * rejection both earn a run receipt, while only approval earns reputation.
 * Claimed/submitted timestamps are required so expired and never-claimed jobs
 * cannot be represented as verification receipts.
 */
export function buildRunReceipt({ session, job = undefined, verification, context = {} }) {
  if (!session?.sessionId || !session?.jobId) {
    throw new ValidationError("Run receipt requires a persisted session and job id.");
  }
  if (!ADDRESS_RE.test(session.wallet ?? "")) {
    throw new ValidationError("Run receipt requires a real worker wallet.");
  }
  const outcome = String(verification?.outcome ?? "").toLowerCase();
  if (!FINAL_OUTCOMES.has(outcome)) {
    throw new ValidationError(`Run receipt requires an approved or rejected verdict; got ${outcome || "missing"}.`);
  }
  const claimedAt = requireIso(session.claimedAt, "session.claimedAt");
  const submittedAt = requireIso(session.submittedAt, "session.submittedAt");
  const verifiedAt = requireIso(
    outcome === "approved" ? session.resolvedAt : session.rejectedAt,
    outcome === "approved" ? "session.resolvedAt" : "session.rejectedAt"
  );
  const handler = firstString(
    verification?.handler,
    verification?.verificationContract?.handler,
    job?.verifierConfig?.handler,
    job?.verifierMode
  );
  if (!handler) throw new ValidationError("Run receipt requires the verifier handler.");
  const reasonCode = firstString(verification?.reasonCode);
  if (!reasonCode) throw new ValidationError("Run receipt requires the verifier reasonCode.");
  const handlerVersion = positiveInteger(
    verification?.handlerVersion ?? verification?.verificationContract?.handlerVersion,
    "verification.handlerVersion"
  );
  const evidenceHash = firstString(verification?.verificationInputHash)
    ?? hashCanonicalContent(verification?.verificationInput ?? session.submission ?? null);
  const policyTags = collectPolicyTags(job);
  const publicBaseUrl = firstString(context.publicBaseUrl);
  const canonicalUrl = publicBaseUrl
    ? `${publicBaseUrl.replace(/\/+$/u, "")}/badges/${encodeURIComponent(session.sessionId)}/run`
    : undefined;
  const signerVerification = { ...verification, resolvedAt: verifiedAt };

  return compact({
    schemaVersion: RUN_RECEIPT_SCHEMA_VERSION,
    kind: "run",
    receiptType: "verification_verdict",
    attestation: "A final verification verdict for a claimed and submitted run; it does not attest reputation.",
    sessionId: session.sessionId,
    jobId: session.jobId,
    worker: session.wallet.toLowerCase(),
    chainJobId: bytes32(session.chainJobId),
    verifier: compact({
      mode: firstString(verification?.verificationContract?.verifierMode, job?.verifierMode),
      handler,
      version: handlerVersion
    }),
    verdict: {
      outcome,
      reasonCode,
      evidenceHash,
      policyTags
    },
    timestamps: { claimedAt, submittedAt, verifiedAt },
    signers: buildBadgeSigners({ session, verification: signerVerification, context }),
    canonicalUrl
  });
}

function collectPolicyTags(job) {
  const values = [
    job?.verification?.receiptPolicyTag,
    ...(Array.isArray(job?.verification?.policyTags) ? job.verification.policyTags : []),
    ...(Array.isArray(job?.policyTags) ? job.policyTags : [])
  ];
  return [...new Set(values.map((value) => firstString(value)).filter(Boolean))];
}

function requireIso(value, label) {
  const normalized = firstString(value);
  if (!normalized || Number.isNaN(Date.parse(normalized))) {
    throw new ValidationError(`Run receipt requires a valid ${label} timestamp.`);
  }
  return new Date(normalized).toISOString();
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`Run receipt requires a positive ${label}.`);
  }
  return parsed;
}

function bytes32(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/u.test(value) ? value.toLowerCase() : undefined;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
