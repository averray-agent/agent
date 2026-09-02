/**
 * SPKI parser for NIST P-256 (a.k.a. `prime256v1`, `secp256r1`) public keys.
 *
 * Phase 4b (per docs/PHASE_4B_KMS_JWT_PLAN.md §10). Used by the new JWT
 * code path to verify that the public-key PEM rendered into our backend
 * environment actually corresponds to a P-256 key — not RSA, not the
 * blockchain signer's `secp256k1`. Anti-confusion check at boot/load
 * time; refuses to operate if the configured key doesn't match the
 * algorithm we sign with (`ECDSA_SHA_256` over P-256).
 *
 * Structure mirrors `mcp-server/src/blockchain/spki.js` exactly. The
 * only material differences from the secp256k1 parser are the curve
 * OID (`1.2.840.10045.3.1.7` vs `1.3.132.0.10`) and a different
 * SubjectPublicKeyInfo prefix length:
 *
 *   SubjectPublicKeyInfo ::= SEQUENCE {
 *     algorithm         AlgorithmIdentifier,
 *     subjectPublicKey  BIT STRING
 *   }
 *   AlgorithmIdentifier ::= SEQUENCE {
 *     algorithm   OBJECT IDENTIFIER,  -- 1.2.840.10045.2.1 (ecPublicKey)
 *     parameters  OBJECT IDENTIFIER   -- 1.2.840.10045.3.1.7 (prime256v1 / P-256)
 *   }
 *   BIT STRING contains 0x00 || uncompressed point (0x04 || x || y, 65 bytes)
 *
 * As with the secp256k1 parser, we walk the DER and validate every
 * length — algorithm OID encoding can vary across producers, so a
 * fixed-offset slice would be fragile. Any structural surprise fails
 * loudly with a specific error.
 */

const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_P256 = "1.2.840.10045.3.1.7";

/**
 * Parse a DER-encoded SPKI for a NIST P-256 public key and return the
 * 32-byte big-endian X and Y coordinates of the uncompressed point.
 *
 * @param {Uint8Array} der  DER-encoded SubjectPublicKeyInfo
 * @returns {{ x: Uint8Array, y: Uint8Array }} 32-byte X and Y components
 */
export function parseP256Spki(der) {
  if (!(der instanceof Uint8Array)) {
    throw new TypeError("parseP256Spki expects a Uint8Array");
  }
  const buf = der;
  let off = 0;

  function readTagLen(expectedTag, label) {
    if (off >= buf.length) throw new Error(`${label}: truncated DER at byte ${off}`);
    const tag = buf[off++];
    if (tag !== expectedTag) {
      throw new Error(`${label}: expected DER tag 0x${expectedTag.toString(16)}, got 0x${tag.toString(16)} at byte ${off - 1}`);
    }
    if (off >= buf.length) throw new Error(`${label}: missing length byte`);
    let len = buf[off++];
    if (len & 0x80) {
      const nLen = len & 0x7f;
      if (nLen === 0 || nLen > 4) throw new Error(`${label}: unsupported length-of-length ${nLen}`);
      len = 0;
      for (let i = 0; i < nLen; i++) {
        if (off >= buf.length) throw new Error(`${label}: truncated multi-byte length`);
        len = (len << 8) | buf[off++];
      }
    }
    if (off + len > buf.length) throw new Error(`${label}: declared length ${len} overruns DER at byte ${off}`);
    return len;
  }

  function readOid(label) {
    const len = readTagLen(0x06, `${label} OID`);
    const bytes = buf.subarray(off, off + len);
    off += len;
    const arcs = [];
    arcs.push(Math.floor(bytes[0] / 40));
    arcs.push(bytes[0] % 40);
    let acc = 0;
    for (let i = 1; i < bytes.length; i++) {
      acc = (acc << 7) | (bytes[i] & 0x7f);
      if ((bytes[i] & 0x80) === 0) {
        arcs.push(acc);
        acc = 0;
      }
    }
    return arcs.join(".");
  }

  readTagLen(0x30, "SPKI outer SEQUENCE");

  // NB: capture the AlgId content length BEFORE adding it to `off`.
  // `off + readTagLen(...)` evaluates `off` first, but readTagLen has
  // the side-effect of advancing `off` past the tag+length bytes — a
  // stale captured value would land us short of the right boundary.
  const algIdContentLen = readTagLen(0x30, "AlgorithmIdentifier SEQUENCE");
  const algIdEnd = off + algIdContentLen;
  const algorithmOid = readOid("AlgorithmIdentifier.algorithm");
  if (algorithmOid !== OID_EC_PUBLIC_KEY) {
    throw new Error(`AlgorithmIdentifier.algorithm: expected ecPublicKey (${OID_EC_PUBLIC_KEY}), got ${algorithmOid}`);
  }
  const curveOid = readOid("AlgorithmIdentifier.parameters (curve)");
  if (curveOid !== OID_P256) {
    throw new Error(`Curve OID: expected P-256 / prime256v1 (${OID_P256}), got ${curveOid}. JWT signer must be ECC_NIST_P256, not secp256k1 or any other curve.`);
  }
  if (off !== algIdEnd) {
    throw new Error(`AlgorithmIdentifier has trailing bytes at ${off}, expected end at ${algIdEnd}`);
  }

  const bitStrLen = readTagLen(0x03, "subjectPublicKey BIT STRING");
  if (bitStrLen < 2) throw new Error(`BIT STRING too short: ${bitStrLen}`);
  const unusedBits = buf[off++];
  if (unusedBits !== 0) {
    throw new Error(`BIT STRING unused bits should be 0 for EC public keys, got ${unusedBits}`);
  }
  const pointBytes = buf.subarray(off, off + bitStrLen - 1);
  off += bitStrLen - 1;

  if (pointBytes.length !== 65) {
    throw new Error(`Public key point: expected 65 bytes (0x04 || x32 || y32), got ${pointBytes.length}`);
  }
  if (pointBytes[0] !== 0x04) {
    // We deliberately reject compressed points (0x02 / 0x03). KMS
    // returns uncompressed for ECC_NIST_P256 keys, and a compressed
    // point in env would suggest the operator pasted output from a
    // non-KMS tool — we'd rather fail loudly than silently decompress.
    throw new Error(`Public key point: expected uncompressed marker 0x04, got 0x${pointBytes[0].toString(16)}. Compressed-point encodings are not supported.`);
  }
  const x = new Uint8Array(pointBytes.subarray(1, 33));
  const y = new Uint8Array(pointBytes.subarray(33, 65));
  if (x.length !== 32 || y.length !== 32) {
    // Defensive — the bitStrLen check above already enforces this,
    // but a future refactor could weaken the check; keep the explicit
    // shape assertion close to the consumers' expectations.
    throw new Error(`Public key point: X and Y must both be 32 bytes (got X=${x.length}, Y=${y.length})`);
  }
  return { x, y };
}
