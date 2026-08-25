import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveH160FromSs58,
  h160ToSs58,
  INVALID_WALLET_IDENTITY_REASON,
  parseWalletIdentity
} from "./wallet-identity.js";

const TESTER_SS58 = "14RLk2G7hu2xMEYL1hbkcwbwWgjL6Nem3fL1maD2GYP1pGNe";
const TESTER_H160 = "0x97450BF69Cb4aEB0b33db3aE51AC2D18224d4b5c";
const NAIVE_ALWAYS_KECCAK_H160 = "0x0baD84d6875827c959E068019f2DcE2f0BE0b59D";
const NATIVE_SS58 = "12eYrKzitqg8q8CiGCiAymMZeFH5wRnngxQ5uynmEp4WUYn4";
const NATIVE_H160 = "0x02c27c2fA9F8c16Cac621D5406A992663ec5a923";

test("deriveH160FromSs58 strips the 0xEE suffix for the pinned EVM-derived tester wallet", () => {
  assert.equal(deriveH160FromSs58(TESTER_SS58), TESTER_H160);
});

test("deriveH160FromSs58 never returns the naive always-Keccak tester address", () => {
  const derived = deriveH160FromSs58(TESTER_SS58);
  assert.notEqual(derived, NAIVE_ALWAYS_KECCAK_H160);
  assert.equal(derived, TESTER_H160);
});

test("deriveH160FromSs58 hashes all 32 bytes for a native AccountId32", () => {
  assert.equal(deriveH160FromSs58(NATIVE_SS58), NATIVE_H160);
});

test("h160ToSs58 preserves the existing prefix-0 top-up derivation byte-for-byte", () => {
  assert.equal(h160ToSs58(TESTER_H160), TESTER_SS58);
  assert.equal(
    h160ToSs58("0x1111111111111111111111111111111111111111"),
    "1PNtGSJ2VC7gGhEPqTbtj9mBEUcxkcFKu44BGyGURScDNUM"
  );
});

test("parseWalletIdentity keeps an H160 canonical and never reconstructs SS58", () => {
  const identity = parseWalletIdentity(TESTER_H160);
  assert.deepEqual(identity, {
    h160: TESTER_H160.toLowerCase(),
    source: "h160"
  });
  assert.equal(Object.hasOwn(identity, "ss58"), false);
});

test("parseWalletIdentity preserves caller-supplied SS58 case and always returns H160", () => {
  assert.deepEqual(parseWalletIdentity(TESTER_SS58), {
    h160: TESTER_H160.toLowerCase(),
    ss58: TESTER_SS58,
    source: "ss58"
  });
});

test("parseWalletIdentity rejects invalid input with the named identity reason", () => {
  assert.throws(
    () => parseWalletIdentity("not-a-wallet"),
    (error) => error.code === INVALID_WALLET_IDENTITY_REASON
      && error.details?.reason === INVALID_WALLET_IDENTITY_REASON
  );
});
