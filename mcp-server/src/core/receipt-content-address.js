import { hashCanonicalContent } from "./canonical-content.js";
import { ValidationError } from "./errors.js";

/**
 * Canonical content address shared by every Averray Work Receipt producer.
 * Identity/signature material and the self-referential public URL are excluded.
 */
export function hashReceiptContent(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ValidationError("Work receipt content must be a JSON object.");
  }
  const {
    receiptId: _receiptId,
    canonicalUrl: _canonicalUrl,
    signers: _signers,
    signature: _signature,
    ...content
  } = document;
  return hashCanonicalContent(content);
}

export function assertReceiptContentAddress(document) {
  const expected = bytes32(document?.receiptId);
  const actual = hashReceiptContent(document);
  if (!expected || expected !== actual) {
    throw new ValidationError(
      `Work receipt content address mismatch: expected ${expected ?? "missing"}, reproduced ${actual}.`
    );
  }
  return true;
}

function bytes32(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/u.test(value)
    ? value.toLowerCase()
    : undefined;
}
