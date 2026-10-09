import { VerifierRegistry } from "../services/verifier-handlers.js";

// Poster review emits receipts outside VerifierRegistry.evaluate.
export const POSTER_REVIEW_HANDLER = "poster_review";
export const RECEIPT_VERIFIER_HANDLERS = Object.freeze([...new Set([
  ...new VerifierRegistry().listHandlers(),
  POSTER_REVIEW_HANDLER
])].sort());
