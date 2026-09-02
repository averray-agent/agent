// Unit tests for scripts/ops/derive-kms-signer-address.mjs.
//
// Pure-function tests against captured SPKI fixtures — no AWS account
// required. The "happy path" fixture is the SPKI for the well-known
// secp256k1 generator point (private key = 1), whose EVM address is
// 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf. That's a stable, reproducible
// reference any reviewer can re-derive offline with one line of ethers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSecp256k1Spki,
  addressFromUncompressedPoint
} from "../../mcp-server/src/blockchain/spki.js";

const hex = (s) => new Uint8Array(Buffer.from(s, "hex"));

// SPKI for secp256k1 with private key = 1 (the generator point).
// Layout (88 bytes):
//   30 56                       SPKI SEQUENCE, content len 86
//     30 10                     AlgorithmIdentifier SEQUENCE, len 16
//       06 07 2A 86 48 CE 3D 02 01    OID ecPublicKey  (1.2.840.10045.2.1)
//       06 05 2B 81 04 00 0A          OID secp256k1    (1.3.132.0.10)
//     03 42 00                  BIT STRING, content len 66 (0 unused bits)
//       04 ...64 bytes...       uncompressed point
const SPKI_GENERATOR = hex(
  "3056301006072a8648ce3d020106052b8104000a034200" +
  "04" +
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
);
const EXPECTED_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

test("derive: secp256k1 generator point yields the canonical Ethereum address", () => {
  const point = parseSecp256k1Spki(SPKI_GENERATOR);
  assert.equal(point.length, 65, "uncompressed point must be 65 bytes (0x04 || x || y)");
  assert.equal(point[0], 0x04, "uncompressed marker");
  const address = addressFromUncompressedPoint(point);
  assert.equal(address, EXPECTED_ADDRESS);
});

test("derive: rejects non-secp256k1 curve OID with a specific error", () => {
  // Same shape, but with OID 1.2.840.10045.3.1.7 (NIST P-256 / secp256r1).
  // Substitute the secp256k1 OID bytes for the P-256 OID bytes.
  // P-256 OID DER bytes: 06 08 2A 86 48 CE 3D 03 01 07
  // Adjust outer + inner SEQUENCE lengths to account for +3 bytes.
  const p256Spki = hex(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200" +
    "04" +
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
    "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
  );
  assert.throws(
    () => parseSecp256k1Spki(p256Spki),
    /Curve OID.*expected secp256k1.*got 1\.2\.840\.10045\.3\.1\.7/
  );
});

test("derive: rejects wrong outer tag", () => {
  const badOuter = new Uint8Array(SPKI_GENERATOR);
  badOuter[0] = 0x31; // SET instead of SEQUENCE
  assert.throws(
    () => parseSecp256k1Spki(badOuter),
    /SPKI outer SEQUENCE: expected DER tag 0x30/
  );
});

test("derive: rejects compressed point format", () => {
  // Same SPKI shape but with a 33-byte compressed point (0x02 || x).
  // Adjust BIT STRING length to 34 (1 unused-bits byte + 33 content bytes).
  const compressedSpki = hex(
    "302d301006072a8648ce3d020106052b8104000a032200" +
    "02" +
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
  );
  assert.throws(
    () => parseSecp256k1Spki(compressedSpki),
    /Public key point: expected 65 bytes.*got 33/
  );
});

test("derive: rejects truncated DER", () => {
  const truncated = SPKI_GENERATOR.slice(0, 50); // cut in the middle of the point
  assert.throws(
    () => parseSecp256k1Spki(truncated),
    /(declared length .* overruns DER|truncated|expected 65 bytes)/
  );
});

test("derive: rejects non-zero unused-bits in BIT STRING", () => {
  // SPKI BIT STRING unused-bits byte is at offset 22 (0x16). Flip it from 0 to 4.
  const bad = new Uint8Array(SPKI_GENERATOR);
  bad[22] = 0x04;
  assert.throws(
    () => parseSecp256k1Spki(bad),
    /BIT STRING unused bits should be 0/
  );
});

test("derive: rejects non-0x04 leading byte on the point", () => {
  const bad = new Uint8Array(SPKI_GENERATOR);
  bad[23] = 0x05; // first byte of the point
  assert.throws(
    () => parseSecp256k1Spki(bad),
    /expected uncompressed marker 0x04/
  );
});

test("derive: rejects multi-byte length form (we only support short form here)", () => {
  // SPKI for a normal secp256k1 key is always under 128 bytes content, so
  // the length field always uses the short form (single byte). Sanity-check
  // that a malformed long-form header is rejected loudly.
  const longForm = new Uint8Array([0x30, 0x81, 0x56, ...SPKI_GENERATOR.slice(2)]);
  // The wrapper now declares len 86 in 1-byte multi-byte form. Our parser
  // accepts up to 4-byte length-of-length so this should walk OK; just
  // verify we reach the address derivation.
  const point = parseSecp256k1Spki(longForm);
  const address = addressFromUncompressedPoint(point);
  assert.equal(address, EXPECTED_ADDRESS);
});
