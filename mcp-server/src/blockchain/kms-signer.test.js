// Unit tests for kms-signer.js.
//
// The test strategy: build a fake KMS client whose `send()` responds to
// `GetPublicKeyCommand` and `SignCommand` by USING A KNOWN LOCAL PRIVATE
// KEY (via ethers `SigningKey`). This lets us test the full signing
// pipeline — DER parsing, low-s normalization, recovery byte detection
// — without an AWS account, and we can verify the resulting signature
// recovers back to the expected address.
//
// The local private key we use is the secp256k1 generator (k=1). Its
// address is well-known and the SPKI fixture is stable.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Signature,
  SigningKey,
  Transaction,
  Wallet,
  hashMessage,
  TypedDataEncoder,
  getBytes,
  recoverAddress,
  hexlify,
} from "ethers";

import { KmsSigner } from "./kms-signer.js";
import {
  parseDerEcdsaSignature,
  normalizeSignatureS,
  SECP256K1_N,
  SECP256K1_N_HALF,
} from "./spki.js";

// ───────────────────────────────────────────────────────────────────
// Fixtures: known private key, SPKI for its public key, and a helper
// that turns a raw (r, s) ECDSA signature back into DER form (the way
// KMS would return it).
// ───────────────────────────────────────────────────────────────────

const PRIV_KEY = "0x" + "01".padStart(64, "0").slice(-64);
const EXPECTED_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

const SPKI_HEX =
  "3056301006072a8648ce3d020106052b8104000a034200" +
  "04" +
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const SPKI_BYTES = new Uint8Array(Buffer.from(SPKI_HEX, "hex"));

const localKey = new SigningKey(PRIV_KEY);

function toDerSig(r, s) {
  // r and s are hex strings without 0x prefix, fixed-width 64 chars
  const rBytes = Buffer.from(r.padStart(64, "0"), "hex");
  const sBytes = Buffer.from(s.padStart(64, "0"), "hex");
  // Strip leading zeros; if high bit set, re-prepend 0x00 so the
  // INTEGER isn't interpreted as negative.
  function trim(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let out = Buffer.from(bytes.subarray(i));
    if (out[0] & 0x80) out = Buffer.concat([Buffer.from([0x00]), out]);
    return out;
  }
  const rDer = trim(rBytes);
  const sDer = trim(sBytes);
  const innerLen = 2 + rDer.length + 2 + sDer.length;
  const der = Buffer.concat([
    Buffer.from([0x30, innerLen]),
    Buffer.from([0x02, rDer.length]),
    rDer,
    Buffer.from([0x02, sDer.length]),
    sDer,
  ]);
  return new Uint8Array(der);
}

class FakeKMSClient {
  constructor({ failNextSign = false, returnHighS = false } = {}) {
    this.calls = [];
    this.failNextSign = failNextSign;
    this.returnHighS = returnHighS;
  }
  async send(command) {
    this.calls.push(command);
    const name = command.constructor.name;
    if (name === "GetPublicKeyCommand") {
      return { PublicKey: SPKI_BYTES, KeyId: command.input.KeyId };
    }
    if (name === "SignCommand") {
      if (this.failNextSign) {
        this.failNextSign = false;
        throw new Error("simulated KMS Sign failure");
      }
      // Sign the digest with our local key. ethers SigningKey gives us
      // r, s, v (or yParity); convert to DER for KMS-shaped response.
      const digest = command.input.Message;
      assert.equal(command.input.MessageType, "DIGEST", "MessageType must be DIGEST");
      assert.equal(command.input.SigningAlgorithm, "ECDSA_SHA_256", "SigningAlgorithm must be ECDSA_SHA_256");
      const sig = localKey.sign(hexlify(digest));
      // To exercise the low-s normalization path, we may intentionally
      // return the high-s form (KMS sometimes does; not all SDKs
      // pre-normalize). Build the DER bytes directly here — ethers'
      // Signature.from rejects non-canonical s as a malleability guard.
      let rHex = sig.r.slice(2);
      let sHex = sig.s.slice(2);
      if (this.returnHighS) {
        const sBig = BigInt(sig.s);
        if (sBig <= SECP256K1_N_HALF) {
          const flippedS = SECP256K1_N - sBig;
          sHex = flippedS.toString(16).padStart(64, "0");
        }
      }
      return { Signature: toDerSig(rHex, sHex) };
    }
    throw new Error(`FakeKMSClient: unknown command ${name}`);
  }
}

// ───────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────

test("KmsSigner.getAddress returns the cached EVM address derived from KMS public key", async () => {
  const kms = new FakeKMSClient();
  const signer = new KmsSigner({ kmsClient: kms, keyId: "test-key" });
  const addr1 = await signer.getAddress();
  const addr2 = await signer.getAddress();
  assert.equal(addr1, EXPECTED_ADDRESS);
  assert.equal(addr2, EXPECTED_ADDRESS, "second call returns cached value");
  // Only one GetPublicKey call; the second hit the cache.
  const gpkCalls = kms.calls.filter((c) => c.constructor.name === "GetPublicKeyCommand");
  assert.equal(gpkCalls.length, 1, "GetPublicKey called exactly once");
});

test("KmsSigner.signMessage produces a signature that recovers to the expected address", async () => {
  const kms = new FakeKMSClient();
  const signer = new KmsSigner({ kmsClient: kms, keyId: "test-key" });
  const msg = "hello kms";
  const sigHex = await signer.signMessage(msg);

  // Verify the produced signature recovers back to our address using
  // ethers' own verifyMessage path (EIP-191).
  const recovered = recoverAddress(getBytes(hashMessage(msg)), sigHex);
  assert.equal(recovered, EXPECTED_ADDRESS);
});

test("KmsSigner.signMessage normalizes high-s signatures to low form (EIP-2)", async () => {
  const kms = new FakeKMSClient({ returnHighS: true });
  const signer = new KmsSigner({ kmsClient: kms, keyId: "test-key" });
  const sigHex = await signer.signMessage("malleability test");

  const sig = Signature.from(sigHex);
  // EIP-2: s must be <= N/2. If our code didn't normalize, this would fail.
  const sValue = BigInt(sig.s);
  assert.ok(sValue <= SECP256K1_N_HALF, `s should be in low half: got ${sig.s}`);
  // And it should still recover to our address.
  const recovered = recoverAddress(getBytes(hashMessage("malleability test")), sig);
  assert.equal(recovered, EXPECTED_ADDRESS);
});

test("KmsSigner.signTypedData produces an EIP-712 signature that matches a local-Wallet baseline", async () => {
  const kms = new FakeKMSClient();
  const signer = new KmsSigner({ kmsClient: kms, keyId: "test-key" });

  const domain = { name: "TestApp", version: "1", chainId: 1n };
  const types = {
    Order: [
      { name: "from", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  };
  const value = { from: EXPECTED_ADDRESS, amount: 42n };

  const kmsSig = await signer.signTypedData(domain, types, value);

  // Locally signed reference for parity.
  const localSig = await new Wallet(PRIV_KEY).signTypedData(domain, types, value);

  // The (r,s) bytes should match (same private key, same digest). v may
  // differ in encoding but the recovered address must be identical.
  const kmsRecovered = recoverAddress(
    TypedDataEncoder.hash(domain, types, value),
    kmsSig,
  );
  const localRecovered = recoverAddress(
    TypedDataEncoder.hash(domain, types, value),
    localSig,
  );
  assert.equal(kmsRecovered, EXPECTED_ADDRESS);
  assert.equal(kmsRecovered, localRecovered);
});

test("KmsSigner.signTransaction produces a serialized tx that recovers to our address", async () => {
  const kms = new FakeKMSClient();
  const signer = new KmsSigner({ kmsClient: kms, keyId: "test-key" });

  const txReq = {
    chainId: 1n,
    nonce: 7,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gasLimit: 21_000n,
    to: "0x0000000000000000000000000000000000000001",
    value: 0n,
    data: "0x",
    type: 2,
  };

  const signedHex = await signer.signTransaction(txReq);
  const decoded = Transaction.from(signedHex);
  assert.equal(decoded.from, EXPECTED_ADDRESS, "from-recovery matches our address");
  assert.equal(decoded.nonce, 7);
  assert.equal(decoded.chainId, 1n);
});

test("KmsSigner.signTransaction handles a Transaction class instance (not just POJO) — regression for empty-tx bug", async () => {
  // Regression: ethers v6 AbstractSigner.sendTransaction (the path used
  // by every ethers.Contract method call) wraps the populated tx via
  // `Transaction.from(pop)` before passing it to signTransaction. The
  // resulting Transaction class instance exposes its fields via
  // getters, not enumerable own properties, so `{ ...txInstance }`
  // returns `{}` and `Transaction.from({})` produces an empty tx
  // (chainId=0, no to, no data, no gas) — which `eth_sendRawTransaction`
  // rejects as "Invalid transaction". This test exercises the
  // instance-input path to lock down the fix.
  const kms = new FakeKMSClient();
  const signer = new KmsSigner({ kmsClient: kms, keyId: "test-key" });

  const txPojo = {
    chainId: 1n,
    nonce: 7,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gasLimit: 21_000n,
    to: "0x0000000000000000000000000000000000000001",
    value: 0n,
    data: "0xdeadbeef",
    type: 2,
  };
  const txInstance = Transaction.from(txPojo);

  const signedHex = await signer.signTransaction(txInstance);
  const decoded = Transaction.from(signedHex);
  assert.equal(
    decoded.to,
    "0x0000000000000000000000000000000000000001",
    "to must survive the instance → signTransaction → serialized round-trip",
  );
  assert.equal(decoded.chainId, 1n, "chainId must survive (bug would give 0)");
  assert.equal(decoded.nonce, 7, "nonce must survive");
  assert.equal(decoded.data, "0xdeadbeef", "data must survive (bug would give 0x)");
  assert.equal(decoded.from, EXPECTED_ADDRESS, "from-recovery matches our address");
});

test("KmsSigner.signTransaction rejects mismatched from-address", async () => {
  const kms = new FakeKMSClient();
  const signer = new KmsSigner({ kmsClient: kms, keyId: "test-key" });

  await assert.rejects(
    () =>
      signer.signTransaction({
        from: "0xdeadbeef00000000000000000000000000000000",
        chainId: 1n,
        nonce: 0,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        gasLimit: 21_000n,
        to: "0x0000000000000000000000000000000000000001",
        type: 2,
      }),
    /tx\.from .* does not match this signer's address/,
  );
});

test("KmsSigner.connect returns a new instance bound to the given provider", async () => {
  const kms = new FakeKMSClient();
  const signer = new KmsSigner({ kmsClient: kms, keyId: "test-key" });
  const fakeProvider = { _isProvider: true };
  const bound = signer.connect(fakeProvider);
  assert.notEqual(bound, signer, "connect returns a new instance");
  assert.equal(bound.provider, fakeProvider);
  assert.equal(await bound.getAddress(), EXPECTED_ADDRESS);
});

test("KmsSigner surfaces KMS Sign failures with the underlying error message", async () => {
  const kms = new FakeKMSClient({ failNextSign: true });
  const signer = new KmsSigner({ kmsClient: kms, keyId: "test-key" });
  // getAddress works (it only needs GetPublicKey, not Sign).
  await signer.getAddress();
  await assert.rejects(
    () => signer.signMessage("x"),
    /simulated KMS Sign failure/,
  );
});

test("KmsSigner constructor rejects missing required options", () => {
  assert.throws(
    () => new KmsSigner({ keyId: "k" }),
    /either kmsClient or region must be provided/,
  );
  assert.throws(
    () => new KmsSigner({ kmsClient: {} }),
    /keyId is required/,
  );
  assert.throws(
    () => new KmsSigner({ kmsClient: {}, keyId: 42 }),
    /keyId is required/,
  );
  // Constructor accepts region-only (lazy KMSClient construction path).
  // We don't actually call KMS here, so no AWS dependency.
  const s = new KmsSigner({ region: "eu-central-1", keyId: "alias/test" });
  assert.equal(typeof s.getAddress, "function");
});

// ───────────────────────────────────────────────────────────────────
// SPKI helper coverage (re-exercised here so the unit covers the
// runtime path, not just the script path).
// ───────────────────────────────────────────────────────────────────

test("parseDerEcdsaSignature: round-trips a fixed-width signature", () => {
  // r and s with high bit clear, no leading-zero padding required.
  const r = "1".repeat(64);
  const s = "2".repeat(64);
  const der = toDerSig(r, s);
  const parsed = parseDerEcdsaSignature(der);
  assert.equal(Buffer.from(parsed.r).toString("hex"), r);
  assert.equal(Buffer.from(parsed.s).toString("hex"), s);
});

test("parseDerEcdsaSignature: strips DER 0x00 padding when high bit is set", () => {
  // r has high bit set → DER prepends 0x00; parser must strip it.
  const r = "f".repeat(64); // 0xff... high bit set
  const s = "1".repeat(64);
  const der = toDerSig(r, s);
  const parsed = parseDerEcdsaSignature(der);
  assert.equal(Buffer.from(parsed.r).toString("hex"), r);
  assert.equal(Buffer.from(parsed.s).toString("hex"), s);
});

test("normalizeSignatureS: low s stays low, high s gets flipped", () => {
  const lowS = new Uint8Array(32);
  lowS[31] = 1; // s = 1
  const result1 = normalizeSignatureS(lowS);
  assert.equal(result1.flipped, false);
  assert.deepEqual(result1.s, lowS);

  // Build a "high" s = N - 1
  const highSBig = SECP256K1_N - 1n;
  const highS = Buffer.from(highSBig.toString(16).padStart(64, "0"), "hex");
  const result2 = normalizeSignatureS(new Uint8Array(highS));
  assert.equal(result2.flipped, true);
  // After flipping N - (N - 1) = 1
  assert.equal(Buffer.from(result2.s).toString("hex"), "0".repeat(63) + "1");
});
