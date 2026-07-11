import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";

import {
  canonicalBadgeReceiptBytes,
  KmsBadgeReceiptSigner,
  loadBadgeReceiptSigningConfig,
  verifyBadgeReceiptSignature,
} from "./badge-receipt-signing.js";
import { ConfigError } from "./errors.js";

const KEY_ARN = "arn:aws:kms:eu-central-2:079209845430:key/11111111-2222-3333-4444-555555555555";

function makeFixture({ fingerprint } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const rawPrivateKey = new Uint8Array(Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url"));
  const actualFingerprint = `sha256:${createHash("sha256").update(publicDer).digest("hex")}`;
  const kmsClient = {
    async send(command) {
      if (command.constructor.name === "GetPublicKeyCommand") {
        return {
          KeyId: KEY_ARN,
          PublicKey: publicDer,
          KeySpec: "ECC_NIST_P256",
          KeyUsage: "SIGN_VERIFY",
          SigningAlgorithms: ["ECDSA_SHA_256"],
        };
      }
      if (command.constructor.name === "SignCommand") {
        assert.equal(command.input.KeyId, KEY_ARN);
        assert.equal(command.input.MessageType, "DIGEST");
        assert.equal(command.input.SigningAlgorithm, "ECDSA_SHA_256");
        return {
          Signature: p256.sign(new Uint8Array(command.input.Message), rawPrivateKey, {
            prehash: false,
            format: "der",
            lowS: false,
          }),
        };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
  return {
    config: {
      region: "eu-central-2",
      keyId: KEY_ARN,
      kid: "badge-1",
      publicKeyPem: publicPem,
      publicKeyFingerprint: fingerprint ?? actualFingerprint,
    },
    kmsClient,
  };
}

test("detached ES256 badge signature verifies against the published JWKS and mutation fails", async () => {
  const { config, kmsClient } = makeFixture();
  const signer = new KmsBadgeReceiptSigner(config, {
    kmsClient,
    now: () => new Date("2026-07-11T18:00:00.000Z"),
  });
  await signer.initialize();
  const unsigned = {
    name: "Averray badge",
    attributes: [{ value: "security", trait_type: "Category" }],
    averray: { sessionId: "session-1", outcome: "approved" },
  };
  const signature = await signer.signDocument(unsigned);
  const document = { ...unsigned, signature };
  const jwks = signer.getJwks();

  assert.equal(signature.alg, "ES256");
  assert.equal(signature.kid, "badge-1");
  assert.match(signature.sig, /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/u);
  assert.equal(jwks.keys[0].kid, "badge-1");
  assert.equal(jwks.keys[0].crv, "P-256");
  assert.equal(signer.verifyDocument(document), true);
  assert.equal(verifyBadgeReceiptSignature(document, jwks.keys[0]), true);
  assert.equal(
    verifyBadgeReceiptSignature({ ...document, signature: { ...document.signature, signedAt: "2026-07-12T18:00:00.000Z" } }, jwks.keys[0]),
    false,
  );
  assert.equal(
    verifyBadgeReceiptSignature({ ...document, averray: { ...document.averray, outcome: "rejected" } }, jwks.keys[0]),
    false,
  );
});

test("canonical badge bytes ignore only the root signature and sort object keys", () => {
  const first = { z: 1, nested: { b: true, a: "x" }, signature: { sig: "ignored" }, a: [2, 1] };
  const second = { a: [2, 1], nested: { a: "x", b: true }, z: 1 };
  assert.deepEqual(canonicalBadgeReceiptBytes(first), canonicalBadgeReceiptBytes(second));
  assert.equal(canonicalBadgeReceiptBytes(first).toString("utf8"), '{"a":[2,1],"nested":{"a":"x","b":true},"z":1}');
});

test("fingerprint mismatch fails signer startup loudly", async () => {
  const { config, kmsClient } = makeFixture({ fingerprint: `sha256:${"0".repeat(64)}` });
  const signer = new KmsBadgeReceiptSigner(config, { kmsClient });
  await assert.rejects(
    signer.initialize(),
    (error) => error instanceof ConfigError && /fingerprint mismatch.*refusing startup/is.test(error.message),
  );
});

test("receipt signing config requires a full ARN and the dedicated kid", () => {
  const { config } = makeFixture();
  const base = {
    NODE_ENV: "production",
    AWS_BADGE_RECEIPT_REGION: config.region,
    AWS_BADGE_RECEIPT_KEY_ID: config.keyId,
    BADGE_RECEIPT_PUBLIC_KEY_PEM_BASE64: Buffer.from(config.publicKeyPem).toString("base64"),
    BADGE_RECEIPT_PUBLIC_KEY_FINGERPRINT: config.publicKeyFingerprint,
    BADGE_RECEIPT_KID: "badge-1",
  };
  assert.equal(loadBadgeReceiptSigningConfig(base).keyId, KEY_ARN);
  assert.throws(
    () => loadBadgeReceiptSigningConfig({ ...base, AWS_BADGE_RECEIPT_KEY_ID: "alias/averray-badge-receipt-signer-testnet" }),
    /full KMS key ARN/u,
  );
  assert.throws(() => loadBadgeReceiptSigningConfig({ ...base, BADGE_RECEIPT_KID: "jwt-1" }), /badge-1/u);
});

test("receipt signing config is optional only outside production", () => {
  assert.equal(loadBadgeReceiptSigningConfig({ NODE_ENV: "development" }), null);
  assert.throws(
    () => loadBadgeReceiptSigningConfig({ NODE_ENV: "production" }),
    (error) => error instanceof ConfigError && /required in production/u.test(error.message),
  );
});

test("only the explicit isolated HTTP smoke harness can disable receipt signing", () => {
  assert.throws(
    () => loadBadgeReceiptSigningConfig({ NODE_ENV: "production", BADGE_RECEIPT_SIGNING: "disabled" }),
    /reserved for the isolated HTTP smoke harness/u,
  );
  assert.equal(loadBadgeReceiptSigningConfig({
    NODE_ENV: "production",
    BADGE_RECEIPT_SIGNING: "disabled",
    RUN_HTTP_SMOKE: "1",
    STATE_STORE_ALLOW_MEMORY: "1",
    AUTH_DOMAIN: "smoke.test",
  }), null);
});
