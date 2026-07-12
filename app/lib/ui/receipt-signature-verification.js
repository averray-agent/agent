import canonicalize from "canonicalize";

export const BADGE_RECEIPT_JWKS_PATH = "/.well-known/badge-receipt-jwks.json";
export const BADGE_RECEIPT_KID = "badge-1";
export const BADGE_RECEIPT_TYP = "averray-badge-receipt+jws";

/** @typedef {{state: "verified", kid: string, signedAt: string} | {state: "unsigned"} | {state: "failed" | "unavailable", error: string}} ReceiptVerificationResult */

/**
 * Verify an immutable badge/run receipt locally with WebCrypto.
 *
 * The API call fetches public key material only. The receipt document and the
 * detached signing input never leave the browser for verification.
 *
 * @param {{document?: Record<string, unknown> | null, fetchImpl?: typeof fetch, cryptoImpl?: Crypto, jwksUrl?: string}} [options]
 * @returns {Promise<ReceiptVerificationResult>}
 */
export async function verifyReceiptSignature({
  document,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  jwksUrl = resolveReceiptJwksUrl(),
} = {}) {
  if (!isPlainObject(document)) {
    return failed("Canonical receipt document is unavailable.");
  }

  const signature = document.signature;
  if (signature === undefined) {
    return { state: "unsigned" };
  }
  if (!isPlainObject(signature)) {
    return failed("Receipt signature has an invalid shape.");
  }

  const alg = nonEmptyString(signature.alg);
  const kid = nonEmptyString(signature.kid);
  const sig = nonEmptyString(signature.sig);
  const signedAt = nonEmptyString(signature.signedAt);
  if (alg !== "ES256" || kid !== BADGE_RECEIPT_KID || !sig || !signedAt) {
    return failed("Receipt signature metadata is malformed or uses an unsupported key.");
  }
  if (!cryptoImpl?.subtle || typeof fetchImpl !== "function") {
    return unavailable("Browser cryptography is unavailable in this session.");
  }

  let protectedSegment;
  let signatureBytes;
  let protectedHeader;
  try {
    const segments = sig.split(".");
    if (segments.length !== 3 || segments[1] !== "") {
      return failed("Receipt signature is not a detached compact JWS.");
    }
    [protectedSegment] = segments;
    signatureBytes = decodeBase64Url(segments[2]);
    if (signatureBytes.byteLength !== 64) {
      return failed("ES256 receipt signature must be a 64-byte raw R||S value.");
    }
    protectedHeader = JSON.parse(new TextDecoder().decode(decodeBase64Url(protectedSegment)));
  } catch {
    return failed("Receipt signature contains invalid base64url or protected-header JSON.");
  }

  if (!hasExactProtectedHeader(protectedHeader, signedAt)) {
    return failed("Protected header does not integrity-bind alg, kid, typ, and signedAt.");
  }

  let canonicalBytes;
  try {
    const { signature: _signature, ...unsignedDocument } = document;
    canonicalBytes = new TextEncoder().encode(canonicalize(unsignedDocument));
  } catch {
    return failed("Receipt document is not valid RFC 8785 canonical JSON.");
  }

  let jwks;
  try {
    const response = await fetchImpl(jwksUrl, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response?.ok) {
      return unavailable(`Receipt JWKS is unavailable (HTTP ${response?.status ?? "unknown"}).`);
    }
    jwks = await response.json();
  } catch {
    return unavailable("Receipt JWKS could not be loaded.");
  }

  const jwk = Array.isArray(jwks?.keys)
    ? jwks.keys.find((key) => key?.kid === kid)
    : undefined;
  if (!isExpectedJwk(jwk)) {
    return failed(`Published JWKS does not contain the expected ${BADGE_RECEIPT_KID} P-256 key.`);
  }

  try {
    const publicKey = await cryptoImpl.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const payloadSegment = encodeBase64Url(canonicalBytes);
    const signingInput = new TextEncoder().encode(`${protectedSegment}.${payloadSegment}`);
    const valid = await cryptoImpl.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signatureBytes,
      signingInput
    );
    return valid
      ? { state: "verified", kid, signedAt }
      : failed("Signature does not match the canonical receipt document.");
  } catch {
    return failed("Browser ES256 verification rejected the receipt signature.");
  }
}

/**
 * Select the exact document whose root signature covers the receipt.
 * Run list rows are discovery wrappers; only their embedded runReceipt is
 * canonical. Badges are verified from the fetched per-session document.
 *
 * @param {{kind: string, listRow?: unknown, detailDocument?: unknown}} input
 * @returns {Record<string, unknown> | null}
 */
export function selectCanonicalReceiptDocument({ kind, listRow, detailDocument }) {
  if (kind === "run" && isPlainObject(listRow) && isPlainObject(listRow.runReceipt)) {
    return listRow.runReceipt;
  }
  if (kind === "badge" && isPlainObject(detailDocument)) {
    return detailDocument;
  }
  return null;
}

export function receiptHasSignature(document) {
  return isPlainObject(document) && Object.hasOwn(document, "signature");
}

export function resolveReceiptJwksUrl(
  baseUrl = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_BASE_URL : undefined
) {
  const normalizedBaseUrl = nonEmptyString(baseUrl);
  return normalizedBaseUrl
    ? `${normalizedBaseUrl.replace(/\/+$/u, "")}${BADGE_RECEIPT_JWKS_PATH}`
    : `/api${BADGE_RECEIPT_JWKS_PATH}`;
}

function hasExactProtectedHeader(value, signedAt) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 4
    && keys.join(",") === "alg,kid,signedAt,typ"
    && value.alg === "ES256"
    && value.kid === BADGE_RECEIPT_KID
    && value.typ === BADGE_RECEIPT_TYP
    && value.signedAt === signedAt;
}

/** @returns {value is JsonWebKey} */
function isExpectedJwk(value) {
  return isPlainObject(value)
    && value.kid === BADGE_RECEIPT_KID
    && value.kty === "EC"
    && value.crv === "P-256"
    && value.alg === "ES256"
    && (value.use === undefined || value.use === "sig");
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("invalid base64url");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = globalThis.atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

/** @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** @returns {{state: "failed", error: string}} */
function failed(error) {
  return { state: "failed", error };
}

/** @returns {{state: "unavailable", error: string}} */
function unavailable(error) {
  return { state: "unavailable", error };
}
