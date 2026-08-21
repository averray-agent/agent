/**
 * Exact quote-presence normalization shared by verification profiles.
 * Deliberately no case folding or fuzzy matching.
 */
export function normalizeWhitespace(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}
