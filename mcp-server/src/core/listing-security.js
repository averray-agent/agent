export const LISTING_CONTENT_SCREEN_VERSION = "listing-content-screen-v1";

export const LISTING_SCREEN_RULES = Object.freeze({
  FIELD_TOO_LONG: "LISTING_STRUCTURAL_FIELD_LENGTH_V1",
  TOTAL_TEXT_TOO_LONG: "LISTING_STRUCTURAL_TOTAL_TEXT_LENGTH_V1",
  EMBEDDED_BASE64: "LISTING_STRUCTURAL_EMBEDDED_BASE64_V1",
  URL_SCHEME: "LISTING_STRUCTURAL_URL_SCHEME_V1",
  INSTRUCTION_OVERRIDE: "LISTING_LEXICAL_INSTRUCTION_OVERRIDE_V1",
  AGENT_IMPERATIVE: "LISTING_LEXICAL_AGENT_IMPERATIVE_V1",
  CREDENTIAL_EXFILTRATION: "LISTING_LEXICAL_CREDENTIAL_EXFILTRATION_V1",
  EXTERNAL_EXFILTRATION: "LISTING_LEXICAL_EXTERNAL_EXFILTRATION_V1",
  SCREEN_UNAVAILABLE: "LISTING_SCREEN_UNAVAILABLE_V1"
});

const MAX_TOTAL_TEXT_LENGTH = 24_000;
const MAX_COLLECTION_ENTRIES = 100;
const MAX_NESTING_DEPTH = 12;
const DEFAULT_FIELD_LENGTH = 8_000;
const ALLOWED_URL_SCHEMES = new Set(["https", "ipfs", "schema"]);

const FIELD_LENGTHS = Object.freeze({
  title: 240,
  description: 4_000,
  acceptanceCriteria: 1_500,
  agentInstructions: 1_500,
  inputSchemaRef: 240,
  outputSchemaRef: 240
});

const INSTRUCTION_OVERRIDE_PATTERN =
  /\b(?:ignore|disregard|forget|override|supersede|bypass)\b.{0,80}\b(?:previous|prior|system|developer|your|all)\b.{0,40}\b(?:instruction|instructions|prompt|prompts|rule|rules|policy|policies)\b/isu;
const AGENT_IMPERATIVE_PATTERN =
  /\b(?:the\s+)?(?:agent|assistant|model)\b\s*[,;:]?\s*(?:must|should|shall|needs?\s+to|please)?\s*\b(?:ignore|disregard|override|send|transfer|reveal|expose|upload|post|transmit|forward|contact|visit|execute)\b/isu;
const CREDENTIAL_EXFILTRATION_PATTERN =
  /\b(?:send|share|reveal|expose|upload|post|transmit|forward|provide)\b.{0,100}\b(?:private\s+key|seed\s+phrase|mnemonic|api\s+key|credential|bearer\s+token|password|secret)\b/isu;
const EXTERNAL_EXFILTRATION_PATTERN =
  /\b(?:send|upload|post|transmit|forward|exfiltrate)\b.{0,120}\bto\b\s+https?:\/\//isu;
const URL_SCHEME_PATTERN = /\b([a-z][a-z0-9+.-]{1,20}):\/\//giu;
const DATA_OR_SCRIPT_URL_PATTERN = /\b(?:data|javascript|vbscript):/iu;
const BASE64_BLOB_PATTERN = /(?:[a-z0-9+/]{4}){24,}(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?/iu;

/**
 * Deterministically inspect an external listing without modifying it.
 * A listed result means only that the v1 rules did not match; it is not a
 * reputation claim or an operator review.
 */
export function screenExternalListing(definition) {
  const entries = [];
  const structural = collectTextEntries(definition, "$", 0, entries);
  if (structural) return quarantine(structural);

  let totalTextLength = 0;
  for (const entry of entries) {
    totalTextLength += entry.value.length;
    const fieldName = entry.path.split(".").at(-1)?.replace(/\[\d+\]$/u, "") ?? "";
    const maximumLength = FIELD_LENGTHS[fieldName] ?? DEFAULT_FIELD_LENGTH;
    if (entry.value.length > maximumLength) {
      return quarantine({
        ruleId: LISTING_SCREEN_RULES.FIELD_TOO_LONG,
        fieldPath: entry.path,
        reason: `Quarantined by ${LISTING_SCREEN_RULES.FIELD_TOO_LONG}: ${entry.path} exceeds the ${maximumLength}-character external-listing ceiling.`
      });
    }
    if (DATA_OR_SCRIPT_URL_PATTERN.test(entry.value) || BASE64_BLOB_PATTERN.test(entry.value)) {
      return quarantine({
        ruleId: LISTING_SCREEN_RULES.EMBEDDED_BASE64,
        fieldPath: entry.path,
        reason: `Quarantined by ${LISTING_SCREEN_RULES.EMBEDDED_BASE64}: embedded data, script URLs, and base64 blobs are not accepted in external listings.`
      });
    }
    for (const match of entry.value.matchAll(URL_SCHEME_PATTERN)) {
      const scheme = String(match[1]).toLowerCase();
      if (!ALLOWED_URL_SCHEMES.has(scheme)) {
        return quarantine({
          ruleId: LISTING_SCREEN_RULES.URL_SCHEME,
          fieldPath: entry.path,
          reason: `Quarantined by ${LISTING_SCREEN_RULES.URL_SCHEME}: URL scheme ${scheme}: is not on the external-listing allowlist.`
        });
      }
    }
  }

  if (totalTextLength > MAX_TOTAL_TEXT_LENGTH) {
    return quarantine({
      ruleId: LISTING_SCREEN_RULES.TOTAL_TEXT_TOO_LONG,
      fieldPath: "$",
      reason: `Quarantined by ${LISTING_SCREEN_RULES.TOTAL_TEXT_TOO_LONG}: external-listing text exceeds the ${MAX_TOTAL_TEXT_LENGTH}-character aggregate ceiling.`
    });
  }

  for (const entry of entries) {
    const text = entry.value.normalize("NFKC").replace(/\s+/gu, " ");
    const lexicalRules = [
      [
        LISTING_SCREEN_RULES.INSTRUCTION_OVERRIDE,
        INSTRUCTION_OVERRIDE_PATTERN,
        "instruction-override phrasing is not accepted in external listings"
      ],
      [
        LISTING_SCREEN_RULES.AGENT_IMPERATIVE,
        AGENT_IMPERATIVE_PATTERN,
        "commands addressed to an agent, assistant, or model are not accepted in external listings"
      ],
      [
        LISTING_SCREEN_RULES.CREDENTIAL_EXFILTRATION,
        CREDENTIAL_EXFILTRATION_PATTERN,
        "requests to disclose or transmit credentials are not accepted in external listings"
      ],
      [
        LISTING_SCREEN_RULES.EXTERNAL_EXFILTRATION,
        EXTERNAL_EXFILTRATION_PATTERN,
        "requests to transmit data to an external endpoint are not accepted in external listings"
      ]
    ];
    for (const [ruleId, pattern, message] of lexicalRules) {
      if (pattern.test(text)) {
        return quarantine({
          ruleId,
          fieldPath: entry.path,
          reason: `Quarantined by ${ruleId}: ${message}.`
        });
      }
    }
  }

  return {
    status: "listed",
    screenVersion: LISTING_CONTENT_SCREEN_VERSION
  };
}

export function unavailableListingScreenVerdict() {
  return quarantine({
    ruleId: LISTING_SCREEN_RULES.SCREEN_UNAVAILABLE,
    fieldPath: "$",
    reason: `Quarantined by ${LISTING_SCREEN_RULES.SCREEN_UNAVAILABLE}: the deterministic external-listing screen was unavailable, so the listing was queued instead of published.`
  });
}

function collectTextEntries(value, path, depth, entries) {
  if (depth > MAX_NESTING_DEPTH) {
    return {
      ruleId: LISTING_SCREEN_RULES.FIELD_TOO_LONG,
      fieldPath: path,
      reason: `Quarantined by ${LISTING_SCREEN_RULES.FIELD_TOO_LONG}: external-listing content exceeds the supported nesting depth.`
    };
  }
  if (typeof value === "string") {
    entries.push({ path, value });
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ENTRIES) {
      return {
        ruleId: LISTING_SCREEN_RULES.FIELD_TOO_LONG,
        fieldPath: path,
        reason: `Quarantined by ${LISTING_SCREEN_RULES.FIELD_TOO_LONG}: ${path} exceeds the ${MAX_COLLECTION_ENTRIES}-entry external-listing ceiling.`
      };
    }
    for (const [index, entry] of value.entries()) {
      const violation = collectTextEntries(entry, `${path}[${index}]`, depth + 1, entries);
      if (violation) return violation;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const objectEntries = Object.entries(value);
  if (objectEntries.length > MAX_COLLECTION_ENTRIES) {
    return {
      ruleId: LISTING_SCREEN_RULES.FIELD_TOO_LONG,
      fieldPath: path,
      reason: `Quarantined by ${LISTING_SCREEN_RULES.FIELD_TOO_LONG}: ${path} exceeds the ${MAX_COLLECTION_ENTRIES}-field external-listing ceiling.`
    };
  }
  for (const [key, entry] of objectEntries) {
    const violation = collectTextEntries(entry, `${path}.${key}`, depth + 1, entries);
    if (violation) return violation;
  }
  return undefined;
}

function quarantine({ ruleId, reason, fieldPath }) {
  return {
    status: "quarantined",
    screenVersion: LISTING_CONTENT_SCREEN_VERSION,
    ruleId,
    reason,
    fieldPath
  };
}
