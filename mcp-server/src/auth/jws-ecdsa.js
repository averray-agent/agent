/**
 * DER ↔ JWS raw (R‖S) conversion for ECDSA signatures.
 *
 * Phase 4b (per docs/PHASE_4B_KMS_JWT_PLAN.md §2, §10). AWS KMS returns
 * ECDSA signatures in DER form:
 *
 *   ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }
 *
 * But RFC 7518 §3.4 requires the ES256 JWS signature value to be exactly
 * 64 octets: a 32-byte big-endian R followed by a 32-byte big-endian S.
 * These helpers convert between the two forms.
 *
 * Differences vs the existing `parseDerEcdsaSignature` in
 * mcp-server/src/blockchain/spki.js:
 *   - We need both directions (DER → raw AND raw → DER); spki.js only
 *     does DER → raw because the blockchain signer never has to
 *     reconstruct DER for verification.
 *   - We're stricter on the verify-side parse: rejecting negative ASN.1
 *     INTEGERs and overlong R/S, because we're feeding untrusted
 *     attacker-controlled JWT inputs through this code path rather than
 *     trusted KMS Sign responses.
 *   - The blockchain helper already left-pads to 32 bytes and strips
 *     DER sign bytes; we re-implement for the JWS context to keep the
 *     stricter checks together and keep ownership of the JWS-spec
 *     constraints in one file.
 */

const R_S_LENGTH = 32;
const RAW_SIG_LENGTH = 64;

/**
 * Convert a DER-encoded ECDSA-Sig-Value to the 64-byte raw JWS form
 * (R‖S, each 32 bytes big-endian, left-padded with zeros if needed).
 *
 * Strict parse rules:
 *   - Outer tag must be SEQUENCE (0x30)
 *   - Length encoding must be short-form (≤127 bytes); ECDSA-Sig-Value
 *     for P-256 is always well below this
 *   - Both inner values must be INTEGERs (0x02)
 *   - INTEGERs must be non-negative (leading byte < 0x80, OR a single
 *     leading 0x00 sign-padding byte followed by a high-bit-set byte)
 *   - R and S, after stripping the optional 0x00 sign-padding byte,
 *     must each be at most 32 bytes
 *   - No trailing bytes after the SEQUENCE
 *
 * @param {Uint8Array} der  DER-encoded ECDSA signature
 * @returns {Uint8Array}    64-byte raw signature (R‖S)
 */
export function jwsRawFromDer(der) {
  if (!(der instanceof Uint8Array)) {
    throw new TypeError("jwsRawFromDer expects a Uint8Array");
  }
  const buf = der;
  let off = 0;

  function readTagLen(expectedTag, label) {
    if (off >= buf.length) throw new Error(`${label}: truncated DER at byte ${off}`);
    const tag = buf[off++];
    if (tag !== expectedTag) {
      throw new Error(`${label}: expected DER tag 0x${expectedTag.toString(16)}, got 0x${tag.toString(16)}`);
    }
    if (off >= buf.length) throw new Error(`${label}: missing length byte`);
    const len = buf[off++];
    if (len & 0x80) {
      // ECDSA-Sig-Value for any sane curve (≤ secp521r1) fits in
      // short-form length. Multi-byte length here is either a bug or
      // an attacker probing our parser; reject.
      throw new Error(`${label}: multi-byte length not supported (ECDSA signatures are always short-form)`);
    }
    if (off + len > buf.length) throw new Error(`${label}: declared length ${len} overruns DER`);
    return len;
  }

  function readInt(label) {
    const len = readTagLen(0x02, `${label} INTEGER`);
    if (len === 0) {
      throw new Error(`${label}: zero-length INTEGER not allowed`);
    }
    const bytes = buf.subarray(off, off + len);
    off += len;
    // Reject negative ASN.1 INTEGERs. A non-negative DER INTEGER either:
    //   (a) has its high bit clear (bytes[0] < 0x80), or
    //   (b) has its high bit set AND is prefixed with a single 0x00
    //       sign-padding byte (so bytes[0] === 0x00 && bytes[1] >= 0x80).
    // Anything else is a negative or malformed encoding.
    if (bytes[0] & 0x80) {
      throw new Error(`${label}: negative ASN.1 INTEGER encoding (leading byte 0x${bytes[0].toString(16)})`);
    }
    // Also reject overlong encodings: a leading 0x00 byte is only
    // allowed when the next byte's high bit is set. Otherwise it's
    // padding that DER requires to be absent.
    if (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1] & 0x80) === 0) {
      throw new Error(`${label}: overlong ASN.1 INTEGER encoding (leading 0x00 without high-bit-set successor)`);
    }
    // Strip the canonical sign-padding byte, if present.
    let stripped = bytes;
    if (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1] & 0x80) !== 0) {
      stripped = bytes.subarray(1);
    }
    if (stripped.length > R_S_LENGTH) {
      throw new Error(`${label}: INTEGER too long after stripping sign byte: ${stripped.length} bytes (max ${R_S_LENGTH})`);
    }
    // Left-pad to 32 bytes.
    const out = new Uint8Array(R_S_LENGTH);
    out.set(stripped, R_S_LENGTH - stripped.length);
    return out;
  }

  readTagLen(0x30, "ECDSA-Sig-Value SEQUENCE");
  const r = readInt("r");
  const s = readInt("s");
  if (off !== buf.length) {
    throw new Error(`ECDSA-Sig-Value: trailing bytes at ${off}, expected end at ${buf.length}`);
  }
  const raw = new Uint8Array(RAW_SIG_LENGTH);
  raw.set(r, 0);
  raw.set(s, R_S_LENGTH);
  return raw;
}

/**
 * Inverse of `jwsRawFromDer`: take a 64-byte raw R‖S and return a
 * DER-encoded ECDSA-Sig-Value suitable for Node `crypto.verify`.
 * Strips any leading zero padding, then re-adds a DER 0x00 sign byte
 * when the resulting value has its high bit set.
 *
 * @param {Uint8Array} raw  64-byte raw signature (R‖S)
 * @returns {Uint8Array}    DER-encoded ECDSA signature
 */
export function jwsRawToDer(raw) {
  if (!(raw instanceof Uint8Array)) {
    throw new TypeError("jwsRawToDer expects a Uint8Array");
  }
  if (raw.length !== RAW_SIG_LENGTH) {
    throw new Error(`jwsRawToDer: expected ${RAW_SIG_LENGTH}-byte input, got ${raw.length}`);
  }
  const rSlice = raw.subarray(0, R_S_LENGTH);
  const sSlice = raw.subarray(R_S_LENGTH, RAW_SIG_LENGTH);
  const rDer = derInteger(rSlice);
  const sDer = derInteger(sSlice);
  // SEQUENCE { r INTEGER, s INTEGER } — each INTEGER is `02 LEN bytes`
  const innerLen = 2 + rDer.length + 2 + sDer.length;
  if (innerLen > 0x7f) {
    // Defensive — an ES256 (32-byte R+S each, +1 sign byte each, +2
    // tag/len each) inner is at most 2*(2+33) = 70 bytes, far below
    // the short-form length boundary.
    throw new Error(`jwsRawToDer: encoded inner length ${innerLen} exceeds short-form bound`);
  }
  const out = new Uint8Array(2 + innerLen);
  out[0] = 0x30;
  out[1] = innerLen;
  let off = 2;
  out[off++] = 0x02;
  out[off++] = rDer.length;
  out.set(rDer, off);
  off += rDer.length;
  out[off++] = 0x02;
  out[off++] = sDer.length;
  out.set(sDer, off);
  return out;
}

/**
 * Internal: take a 32-byte big-endian integer slice and produce the
 * canonical DER INTEGER value bytes (without the tag or length prefix).
 * Strips redundant leading zero bytes, then re-adds a single 0x00 sign
 * byte if the resulting value has its high bit set.
 */
function derInteger(bytes) {
  // Strip redundant leading zero bytes — DER INTEGER must be the
  // shortest possible encoding. We keep at least one byte (a value of
  // exactly 0 is encoded as a single 0x00 byte).
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) {
    start++;
  }
  const trimmed = bytes.subarray(start);
  // If high bit is set, prepend 0x00 so the INTEGER isn't read as
  // negative two's-complement.
  if (trimmed[0] & 0x80) {
    const padded = new Uint8Array(trimmed.length + 1);
    padded[0] = 0x00;
    padded.set(trimmed, 1);
    return padded;
  }
  // Return a copy so callers can't mutate the input through the result.
  return new Uint8Array(trimmed);
}
