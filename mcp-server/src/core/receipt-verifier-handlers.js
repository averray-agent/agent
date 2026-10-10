import { VerifierRegistry } from "../services/verifier-handlers.js";

// Brokered review and witness-configured jobs can persist receipts outside
// VerifierRegistry.evaluate (HumanVerdictService / buildRunReceipt fallback).
export const POSTER_REVIEW_HANDLER = "poster_review";
export const RECEIPT_VERIFIER_HANDLERS = Object.freeze([...new Set([
  ...new VerifierRegistry().listHandlers(),
  POSTER_REVIEW_HANDLER,
  "human_review",
  "witness"
])].sort());
