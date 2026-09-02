// Unit tests for jws-ecdsa.js — covers the acceptance cases listed in
// docs/PHASE_4B_KMS_JWT_PLAN.md §10 "ECDSA helper acceptance tests".

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";

import { jwsRawFromDer, jwsRawToDer } from "./jws-ecdsa.js";

// Helper: hand-construct a DER ECDSA-Sig-Value from arbitrary r/s
// byte buffers, without the canonical sign-byte handling. Used to
// produce both well-formed and intentionally-malformed inputs.
function makeDer(rBytes, sBytes) {
  const inner = 2 + rBytes.length + 2 + sBytes.length;
  const out = new Uint8Array(2 + inner);
  out[0] = 0x30;
  out[1] = inner;
  let off = 2;
  out[off++] = 0x02;
  out[off++] = rBytes.length;
  out.set(rBytes, off);
  off += rBytes.length;
  out[off++] = 0x02;
  out[off++] = sBytes.length;
  out.set(sBytes, off);
  return out;
}

// Helper: produce a real ECDSA signature using Node's crypto and
// extract its DER bytes. Returns { der, message, publicKey }.
function realSig(namedCurve = "prime256v1") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve });
  const message = randomBytes(16);
  const der = createSign("SHA256").update(message).sign(privateKey);
  return { der: new Uint8Array(der), message, publicKey };
}

test("jwsRawFromDer: real Node-generated ECDSA signature → exactly 64-byte raw", () => {
  const { der } = realSig();
  const raw = jwsRawFromDer(der);
  assert.equal(raw.length, 64);
});

test("jwsRawToDer + Node crypto.verify: round-trip raw → DER verifies", () => {
  const { der, message, publicKey } = realSig();
  const raw = jwsRawFromDer(der);
  const derAgain = jwsRawToDer(raw);
  const ok = createVerify("SHA256").update(message).verify(publicKey, Buffer.from(derAgain));
  assert.equal(ok, true, "round-tripped DER must verify under Node crypto");
});

test("jwsRawFromDer + jwsRawToDer: many real signatures round-trip cleanly", () => {
  // Generate a batch — this exercises the natural distribution of R/S
  // shapes (some with leading zeros, some with high bit set).
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  for (let i = 0; i < 25; i++) {
    const message = randomBytes(32);
    const der = new Uint8Array(createSign("SHA256").update(message).sign(privateKey));
    const raw = jwsRawFromDer(der);
    assert.equal(raw.length, 64, `iter ${i}: raw must be 64 bytes`);
    const derAgain = jwsRawToDer(raw);
    const ok = createVerify("SHA256").update(message).verify(publicKey, Buffer.from(derAgain));
    assert.equal(ok, true, `iter ${i}: round-trip must verify`);
  }
});

test("jwsRawFromDer: R requiring left-padding (e.g., 5-byte R) widens to 32 bytes", () => {
  // R has natural length < 32 → must be left-padded with zeros.
  const r = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]); // 5 bytes, high bit clear
  const s = new Uint8Array(32).fill(0x42); // 32 bytes
  s[0] = 0x42; // ensure high bit clear
  const der = makeDer(r, s);
  const raw = jwsRawFromDer(der);
  assert.equal(raw.length, 64);
  // R section should be 27 leading zero bytes then 0x01 02 03 04 05
  const rOut = raw.subarray(0, 32);
  for (let i = 0; i < 27; i++) assert.equal(rOut[i], 0, `byte ${i} should be zero pad`);
  assert.deepEqual(Array.from(rOut.subarray(27)), [0x01, 0x02, 0x03, 0x04, 0x05]);
});

test("jwsRawFromDer: DER 0x00 sign-padding byte stripped (R high-bit-set case)", () => {
  // R high bit set → DER produced with leading 0x00 sign-byte (33 bytes
  // total). Parser must strip the 0x00 and emit a clean 32-byte value.
  const rRaw = new Uint8Array(32).fill(0xff);
  const rWithSign = new Uint8Array(33);
  rWithSign[0] = 0x00;
  rWithSign.set(rRaw, 1);
  const s = new Uint8Array(32).fill(0x11);
  const der = makeDer(rWithSign, s);
  const raw = jwsRawFromDer(der);
  assert.equal(raw.length, 64);
  assert.deepEqual(Array.from(raw.subarray(0, 32)), Array.from(rRaw));
  assert.deepEqual(Array.from(raw.subarray(32, 64)), Array.from(s));
});

test("jwsRawFromDer: S requiring left-padding (3-byte S)", () => {
  const r = new Uint8Array(32).fill(0x12);
  const s = new Uint8Array([0x00, 0x7a, 0xff]); // 3 bytes, leading 0x00 with high-bit clear next is invalid
  // Instead use a 3-byte value with high bit clear: 0x01 0x02 0x03.
  const sShort = new Uint8Array([0x01, 0x02, 0x03]);
  const der = makeDer(r, sShort);
  const raw = jwsRawFromDer(der);
  const sOut = raw.subarray(32, 64);
  for (let i = 0; i < 29; i++) assert.equal(sOut[i], 0);
  assert.deepEqual(Array.from(sOut.subarray(29)), [0x01, 0x02, 0x03]);
});

test("jwsRawFromDer: rejects wrong outer SEQUENCE tag", () => {
  const r = new Uint8Array(32).fill(0x01);
  const s = new Uint8Array(32).fill(0x02);
  const der = makeDer(r, s);
  const mutated = new Uint8Array(der);
  mutated[0] = 0x31; // SET
  assert.throws(
    () => jwsRawFromDer(mutated),
    /ECDSA-Sig-Value SEQUENCE: expected DER tag 0x30/,
  );
});

test("jwsRawFromDer: rejects wrong INTEGER tag for r", () => {
  const r = new Uint8Array(32).fill(0x01);
  const s = new Uint8Array(32).fill(0x02);
  const der = makeDer(r, s);
  const mutated = new Uint8Array(der);
  // The first INTEGER tag is at index 2 (right after outer SEQUENCE
  // tag + length byte).
  mutated[2] = 0x04; // OCTET STRING
  assert.throws(
    () => jwsRawFromDer(mutated),
    /r INTEGER: expected DER tag 0x2/,
  );
});

test("jwsRawFromDer: rejects negative ASN.1 INTEGER (high bit set, no sign byte)", () => {
  // r starts with 0x80 — represents a negative two's-complement
  // integer, which is invalid for an ECDSA r/s value.
  const r = new Uint8Array(32);
  r[0] = 0x80;
  const s = new Uint8Array(32).fill(0x11);
  const der = makeDer(r, s);
  assert.throws(
    () => jwsRawFromDer(der),
    /negative ASN\.1 INTEGER encoding/,
  );
});

test("jwsRawFromDer: rejects overlong INTEGER (leading 0x00 without high-bit successor)", () => {
  // r is `00 7f ...` — the 0x00 byte is illegal because the next byte
  // (0x7f) has high bit clear, so the 0x00 is redundant padding.
  const r = new Uint8Array(33);
  r[0] = 0x00;
  r[1] = 0x7f;
  // remainder zeros is fine.
  const s = new Uint8Array(32).fill(0x11);
  const der = makeDer(r, s);
  assert.throws(
    () => jwsRawFromDer(der),
    /overlong ASN\.1 INTEGER encoding/,
  );
});

test("jwsRawFromDer: rejects INTEGER too long (> 33 bytes for a 32-byte value)", () => {
  // r is 34 bytes with valid sign-byte structure: 00 ff ff ... — after
  // stripping the sign byte, 33 bytes remain (> 32 max).
  const r = new Uint8Array(34);
  r[0] = 0x00;
  r[1] = 0xff;
  for (let i = 2; i < 34; i++) r[i] = 0xab;
  const s = new Uint8Array(32).fill(0x11);
  const der = makeDer(r, s);
  assert.throws(
    () => jwsRawFromDer(der),
    /INTEGER too long after stripping sign byte/,
  );
});

test("jwsRawFromDer: rejects zero-length INTEGER", () => {
  // r INTEGER with zero-length payload.
  const der = new Uint8Array([0x30, 0x04, 0x02, 0x00, 0x02, 0x00]);
  assert.throws(() => jwsRawFromDer(der), /zero-length INTEGER/);
});

test("jwsRawFromDer: rejects trailing bytes after the SEQUENCE", () => {
  const r = new Uint8Array(32).fill(0x01);
  const s = new Uint8Array(32).fill(0x02);
  const der = makeDer(r, s);
  // Lie about the outer length: shrink by 1 so a trailing byte is
  // exposed AFTER the declared end.
  const mutated = new Uint8Array(der.length + 1);
  mutated.set(der);
  mutated[mutated.length - 1] = 0x99;
  // Don't change the outer length — the trailing byte is past it. The
  // parser reaches end-of-SEQUENCE-content at index buf.length-1, not
  // buf.length, so this triggers the trailing-bytes guard.
  assert.throws(
    () => jwsRawFromDer(mutated),
    /trailing bytes/,
  );
});

test("jwsRawFromDer: rejects multi-byte length encoding", () => {
  // Outer SEQUENCE with 2-byte length 0x81 0x80 — multi-byte form;
  // we reject it as unsupported.
  const der = new Uint8Array([0x30, 0x81, 0x40, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
  assert.throws(
    () => jwsRawFromDer(der),
    /multi-byte length not supported/,
  );
});

test("jwsRawFromDer: rejects non-Uint8Array input", () => {
  assert.throws(() => jwsRawFromDer("not bytes"), /expects a Uint8Array/);
});

test("jwsRawFromDer: rejects truncated DER", () => {
  // SEQUENCE with declared length 10 but only 2 inner bytes available.
  const der = new Uint8Array([0x30, 0x0a, 0x02, 0x01]);
  assert.throws(() => jwsRawFromDer(der), /overruns DER|truncated/);
});

test("jwsRawToDer: rejects input not exactly 64 bytes (0 bytes)", () => {
  assert.throws(
    () => jwsRawToDer(new Uint8Array(0)),
    /expected 64-byte input, got 0/,
  );
});

test("jwsRawToDer: rejects input not exactly 64 bytes (63 bytes)", () => {
  assert.throws(
    () => jwsRawToDer(new Uint8Array(63)),
    /expected 64-byte input, got 63/,
  );
});

test("jwsRawToDer: rejects input not exactly 64 bytes (65 bytes)", () => {
  assert.throws(
    () => jwsRawToDer(new Uint8Array(65)),
    /expected 64-byte input, got 65/,
  );
});

test("jwsRawToDer: rejects non-Uint8Array input", () => {
  assert.throws(() => jwsRawToDer("not bytes"), /expects a Uint8Array/);
});

test("jwsRawToDer: high-bit-set R gets DER sign-byte prepended", () => {
  // R is 32 bytes all 0xff (high bit set). DER encoding must prepend
  // 0x00 to avoid the value being interpreted as negative.
  const raw = new Uint8Array(64);
  for (let i = 0; i < 32; i++) raw[i] = 0xff;
  for (let i = 32; i < 64; i++) raw[i] = 0x01;
  const der = jwsRawToDer(raw);
  // Outer SEQUENCE: 0x30, len. First INTEGER: 0x02, 33 (32 + sign byte),
  // then 0x00 then 32 × 0xff. Second INTEGER: 0x02, 32, then 32 × 0x01.
  assert.equal(der[0], 0x30);
  assert.equal(der[2], 0x02);
  assert.equal(der[3], 33);
  assert.equal(der[4], 0x00, "sign-padding byte must precede high-bit-set R");
  assert.equal(der[5], 0xff);
});

test("jwsRawToDer: leading zeros in R/S are trimmed in DER output", () => {
  // R has 5 leading zero bytes — DER must trim them.
  const raw = new Uint8Array(64);
  // R = 27 zeros + [0x01..]; keep S all 0xaa with high bit set → S gets sign byte
  raw[27] = 0x01;
  raw[28] = 0x02;
  raw[29] = 0x03;
  raw[30] = 0x04;
  raw[31] = 0x05;
  for (let i = 32; i < 64; i++) raw[i] = 0xaa;
  const der = jwsRawToDer(raw);
  // R should be just 5 bytes: 0x02 0x05 01 02 03 04 05
  assert.equal(der[2], 0x02);
  assert.equal(der[3], 5);
  assert.deepEqual(Array.from(der.subarray(4, 9)), [0x01, 0x02, 0x03, 0x04, 0x05]);
});

test("jwsRawToDer: zero R or S produces a single-byte 0x00 INTEGER", () => {
  // Practically impossible for a real ECDSA signature, but the encoder
  // should still produce a syntactically-valid DER INTEGER for an
  // all-zero input. (Any verifier will then reject it as r=0 / s=0.)
  const raw = new Uint8Array(64); // all zeros
  const der = jwsRawToDer(raw);
  // Both INTEGERs should encode as 02 01 00
  assert.equal(der[0], 0x30);
  assert.equal(der[2], 0x02);
  assert.equal(der[3], 1);
  assert.equal(der[4], 0x00);
  assert.equal(der[5], 0x02);
  assert.equal(der[6], 1);
  assert.equal(der[7], 0x00);
});
