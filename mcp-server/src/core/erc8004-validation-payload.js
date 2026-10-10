import { ValidationError } from "./errors.js";
import { assertWorkReceiptContentAddress, WORK_RECEIPT_SCHEMA_VERSION } from "./work-receipt.js";

const HASH = /^0x[0-9a-f]{64}$/iu;
const MERGED_ONLY_SINCE = Date.parse("2026-10-08T07:21:00Z");

/**
 * Pure, offline projection of a recorded verdict, NOT a validator or publisher.
 * No registry/agent identity, requestHash, wallet, signer or transport is inferred.
 * Evidence uses Averray's content hash, not the ERC-8004 request commitment.
 */
export function buildErc8004ValidationPayload(receipt) {
  const document = receipt?.schemaVersion === "averray.receipt-envelope.v1"
    ? receipt.document : receipt;
  if (document?.schemaVersion !== WORK_RECEIPT_SCHEMA_VERSION || document.kind !== "run") {
    throw new ValidationError("ERC-8004 payload requires a work run receipt or its receipt envelope.");
  }
  assertWorkReceiptContentAddress(document);
  const evidenceHash = document.receiptId.toLowerCase();
  const outcome = document.verdict?.outcome;
  const verifiedAt = Date.parse(document.timestamps?.verifiedAt);
  let score = null;
  let reason = "verdict_not_reported";
  if (!Number.isFinite(verifiedAt)) {
    reason = "verification_time_not_reported";
  } else if (outcome === "approved" && !isHash(document.settlement?.settlementTx)) {
    reason = "settlement_not_reported";
  } else if (outcome === "approved") {
    score = 100;
    reason = "recorded_approved";
  } else if (outcome === "rejected") {
    score = 0;
    reason = "recorded_rejected";
  } else if (outcome === "inconclusive" || outcome === "platform_fault") {
    reason = outcome;
  }

  const blockers = ["publishing_deferred", "signature_and_live_evidence_not_checked"];
  if (score === null) blockers.push(reason);
  if (document.intent?.specSource !== "chain_verified") {
    blockers.push(document.intent?.specSource === "chain_unavailable_fail_open"
      ? "chain_unavailable_fail_open" : "chain_verified_spec_not_reported");
  }
  // Conservative: older GitHub receipts cannot establish the later merge gate.
  if (document.verifier?.handler === "github_pr"
    && (!Number.isFinite(verifiedAt) || verifiedAt < MERGED_ONLY_SINCE)) {
    blockers.push("github_pr_pre_merged_only_rule");
  }

  return {
    schemaVersion: "averray.erc8004-validation-payload.v1",
    score,
    status: score === null ? "not reported" : "reported",
    reason,
    evidenceURI: `https://api.averray.com/receipts/${evidenceHash}`,
    evidenceHash,
    tag: "averray-recorded-verdict-v1",
    publication: { enabled: false, blockers }
  };
}

function isHash(value) {
  return typeof value === "string" && HASH.test(value) && !/^0x0{64}$/iu.test(value);
}
