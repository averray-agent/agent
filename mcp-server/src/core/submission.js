import { ValidationError } from "./errors.js";
import { canonicalizeContent, hashCanonicalContent } from "./canonical-content.js";

export function normalizeSubmission(input) {
  if (typeof input === "string") {
    return {
      kind: "text",
      rawText: input,
      evidenceText: input
    };
  }

  if (isStructuredSubmission(input)) {
      return {
        kind: "structured",
        structured: input,
        evidenceText: stableStringify(input)
      };
  }

  throw new ValidationError("submission must be a string, object, or array");
}

export function extractSubmissionText(input) {
  if (!input) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof input.evidenceText === "string") {
    return input.evidenceText;
  }
  if (typeof input.rawText === "string") {
    return input.rawText;
  }
  if (isStructuredSubmission(input.structured)) {
    return stableStringify(input.structured);
  }
  if (isStructuredSubmission(input)) {
    return stableStringify(input);
  }
  return "";
}

export function hashSubmission(input) {
  if (input?.kind === "structured" && isStructuredSubmission(input.structured)) {
    return hashCanonicalContent(input.structured);
  }
  if (isStructuredSubmission(input)) {
    return hashCanonicalContent(input);
  }
  return hashCanonicalContent(extractSubmissionText(input));
}

export function stableStringify(value) {
  return canonicalizeContent(value);
}

export function isStructuredSubmission(value) {
  return Array.isArray(value) || (value !== null && typeof value === "object");
}
