/**
 * SPKI parsing helpers for AWS KMS public keys.
 *
 * Phase 3 (per docs/SECRETS_MIGRATION.md §"Phase 3 — AWS KMS for the
 * backend signer"). Shared between scripts/ops/derive-kms-signer-address.mjs
 * (operator CLI) and mcp-server/src/blockchain/kms-signer.js (runtime
 * signer adapter).
 *
 * AWS KMS `GetPublicKey` returns the public key as a DER-encoded
 * SubjectPublicKeyInfo. For an ECC_SECG_P256K1 key, the structure is:
 *
 *   SubjectPublicKeyInfo ::= SEQUENCE {
 *     algorithm         AlgorithmIdentifier,
 *     subjectPublicKey  BIT STRING
 *   }
 *   AlgorithmIdentifier ::= SEQUENCE {
 *     algorithm   OBJECT IDENTIFIER,  -- 1.2.840.10045.2.1 (ecPublicKey)
 *     parameters  OBJECT IDENTIFIER   -- 1.3.132.0.10 (secp256k1)
 *   }
 *   BIT STRING contains 0x00 || uncompressed point (0x04 || x || y, 65 bytes)
 *
 * The doc warns against fixed-offset slicing — algorithm OID encoding
 * can vary — so we walk the DER and validate every length. Any
 * structural surprise fails loudly with a specific error.
 */

import { computeAddress } from "ethers";

const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_SECP256K1 = "1.3.132.0.10";

/**
 * Parse a DER-encoded SPKI for a secp256k1 public key and return the
 * 65-byte uncompressed point (0x04 || x(32) || y(32)).
 *
 * @param {Uint8Array} der  DER-encoded SPKI as returned by KMS GetPublicKey
 * @returns {Uint8Array}    65-byte uncompressed EC point
 */
export function parseSecp256k1Spki(der) {
  if (!(der instanceof Uint8Array)) {
    throw new TypeError("parseSecp256k1Spki expects a Uint8Array");
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
  // stale captured value would land us 2 bytes short.
  const algIdContentLen = readTagLen(0x30, "AlgorithmIdentifier SEQUENCE");
  const algIdEnd = off + algIdContentLen;
  const algorithmOid = readOid("AlgorithmIdentifier.algorithm");
  if (algorithmOid !== OID_EC_PUBLIC_KEY) {
    throw new Error(`AlgorithmIdentifier.algorithm: expected ecPublicKey (${OID_EC_PUBLIC_KEY}), got ${algorithmOid}`);
  }
  const curveOid = readOid("AlgorithmIdentifier.parameters (curve)");
  if (curveOid !== OID_SECP256K1) {
    throw new Error(`Curve OID: expected secp256k1 (${OID_SECP256K1}), got ${curveOid}. Did you create a key with the wrong KeySpec?`);
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
    throw new Error(`Public key point: expected uncompressed marker 0x04, got 0x${pointBytes[0].toString(16)}`);
  }
  return new Uint8Array(pointBytes);
}

/**
 * Compute the EVM address (EIP-55 checksum) for a 65-byte uncompressed
 * secp256k1 public key.
 *
 * @param {Uint8Array} point  65-byte uncompressed point
 * @returns {string}          0x-prefixed checksummed address
 */
export function addressFromUncompressedPoint(point) {
  const hex = "0x" + Buffer.from(point).toString("hex");
  return computeAddress(hex);
}

/**
 * Parse a DER-encoded ECDSA signature as returned by KMS `Sign`. KMS
 * always uses the DER encoding; ethers wants raw 32-byte (r, s).
 *
 *   ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }
 *
 * INTEGERs are big-endian two's-complement; if the high bit is set,
 * DER prepends a 0x00 padding byte so the value isn't interpreted as
 * negative. We strip that and left-pad / right-pad to 32 bytes.
 *
 * @param {Uint8Array} der  DER-encoded ECDSA signature
 * @returns {{ r: Uint8Array, s: Uint8Array }} 32-byte r and s components
 */
export function parseDerEcdsaSignature(der) {
  if (!(der instanceof Uint8Array)) {
    throw new TypeError("parseDerEcdsaSignature expects a Uint8Array");
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
      throw new Error(`${label}: multi-byte length not supported (ECDSA signatures are always short-form)`);
    }
    if (off + len > buf.length) throw new Error(`${label}: declared length ${len} overruns DER`);
    return len;
  }

  function readInt(label) {
    const len = readTagLen(0x02, `${label} INTEGER`);
    let bytes = buf.subarray(off, off + len);
    off += len;
    // DER strips/pads leading 0x00 so a value with high bit set isn't
    // negative. We want a fixed-width 32-byte big-endian field.
    if (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1] & 0x80) !== 0) {
      bytes = bytes.subarray(1);
    }
    if (bytes.length > 32) {
      throw new Error(`${label}: INTEGER too long after stripping pad: ${bytes.length} bytes`);
    }
    // Left-pad to 32 bytes.
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  }

  readTagLen(0x30, "ECDSA-Sig-Value SEQUENCE");
  const r = readInt("r");
  const s = readInt("s");
  if (off !== buf.length) {
    throw new Error(`ECDSA-Sig-Value: trailing bytes at ${off}, expected end at ${buf.length}`);
  }
  return { r, s };
}

// secp256k1 group order N, in big-endian hex. Source: SEC 2 v2.0.
//   0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
export const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);
export const SECP256K1_N_HALF = SECP256K1_N >> 1n;

/**
 * Normalize an ECDSA signature's `s` to the low half of the group
 * order. EIP-2 requires `s <= N/2` to prevent transaction malleability
 * (otherwise an attacker can flip s and produce a different valid sig
 * for the same message). KMS may return either form; we always
 * normalize before handing the sig to ethers.
 *
 * @param {Uint8Array} s32  32-byte big-endian s
 * @returns {{ s: Uint8Array, flipped: boolean }} normalized s and whether we flipped it
 */
export function normalizeSignatureS(s32) {
  if (!(s32 instanceof Uint8Array) || s32.length !== 32) {
    throw new TypeError("normalizeSignatureS expects a 32-byte Uint8Array");
  }
  const s = BigInt("0x" + Buffer.from(s32).toString("hex"));
  if (s <= SECP256K1_N_HALF) {
    return { s: s32, flipped: false };
  }
  const flipped = SECP256K1_N - s;
  const out = new Uint8Array(32);
  const hex = flipped.toString(16).padStart(64, "0");
  out.set(Buffer.from(hex, "hex"));
  return { s: out, flipped: true };
}
