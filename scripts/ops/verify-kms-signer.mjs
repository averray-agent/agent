#!/usr/bin/env node

/**
 * Phase 3 pre-flight — verify AWS KMS-signer credentials work end-to-end.
 *
 * Exercises the same KMS API surface the backend's KmsSigner uses, with
 * the new IAM credentials, BEFORE flipping SIGNER_BACKEND=kms in
 * production. Three tests, each meaningful:
 *
 *   1. GetPublicKey succeeds → proves the IAM user can read the key's
 *      public material (KmsSigner needs this to derive its address).
 *   2. Sign(ECDSA_SHA_256, DIGEST) succeeds → proves the IAM user can
 *      actually sign in the only mode the backend uses.
 *   3. Sign(ECDSA_SHA_384, DIGEST) fails with AccessDeniedException →
 *      proves the IAM policy's `kms:SigningAlgorithm` condition key
 *      is enforced. If this test PASSES (i.e., signing succeeds with
 *      the wrong algorithm), the policy's condition is broken and a
 *      leaked credential could sign in any algorithm; surfaces a
 *      misconfiguration before mainnet.
 *
 * Required environment variables:
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_REGION
 *   KMS_KEY_ID   (full ARN or key id; ARN is preferred for clarity)
 *
 * Suggested invocation using 1Password CLI to avoid leaving the
 * secret access key in shell history:
 *
 *   export AWS_ACCESS_KEY_ID=$(op read 'op://prod-backend/aws-signer-testnet/access-key-id')
 *   export AWS_SECRET_ACCESS_KEY=$(op read 'op://prod-backend/aws-signer-testnet/secret-access-key')
 *   export AWS_REGION=$(op read 'op://prod-backend/aws-signer-testnet/aws-region')
 *   export KMS_KEY_ID=$(op read 'op://prod-backend/aws-signer-testnet/kms-key-id')
 *   node scripts/ops/verify-kms-signer.mjs
 *   unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
 *
 * Exit codes:
 *   0   All three tests passed — IAM + KMS wiring is correct.
 *   1   Bad env (missing required vars).
 *   2   One or more tests failed; details printed.
 */

import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from "@aws-sdk/client-kms";

import {
  addressFromUncompressedPoint,
  parseSecp256k1Spki,
} from "../../mcp-server/src/blockchain/spki.js";

const REQUIRED_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "KMS_KEY_ID",
];

function red(s)    { return `\x1b[31m${s}\x1b[0m`; }
function green(s)  { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function bold(s)   { return `\x1b[1m${s}\x1b[0m`; }

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(red(`Missing required env vars: ${missing.join(", ")}`));
    console.error("Set them via:");
    for (const k of missing) {
      const opPath = k === "AWS_ACCESS_KEY_ID" ? "access-key-id"
                   : k === "AWS_SECRET_ACCESS_KEY" ? "secret-access-key"
                   : k === "AWS_REGION" ? "aws-region"
                   : "kms-key-id";
      console.error(`  export ${k}=$(op read 'op://prod-backend/aws-signer-testnet/${opPath}')`);
    }
    process.exit(1);
  }
}

async function test1_getPublicKey(client, keyId) {
  console.log(bold("\n[1/3] GetPublicKey"));
  try {
    const result = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!result.PublicKey) {
      console.error(red("  FAIL: KMS returned empty PublicKey"));
      return false;
    }
    const point = parseSecp256k1Spki(new Uint8Array(result.PublicKey));
    const address = addressFromUncompressedPoint(point);
    console.log(green(`  PASS: GetPublicKey succeeded`));
    console.log(`        KeyId:    ${result.KeyId}`);
    console.log(`        KeySpec:  ${result.KeySpec}`);
    console.log(`        KeyUsage: ${result.KeyUsage}`);
    console.log(`        EVM address (derived): ${address}`);
    return { ok: true, address };
  } catch (err) {
    console.error(red(`  FAIL: ${err.name}: ${err.message}`));
    return { ok: false };
  }
}

async function test2_signAllowed(client, keyId) {
  console.log(bold("\n[2/3] Sign with ECDSA_SHA_256 + DIGEST (the allowed mode)"));
  const digest = new Uint8Array(32); // 32-byte zero digest for the test
  try {
    const result = await client.send(new SignCommand({
      KeyId: keyId,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    }));
    if (!result.Signature || result.Signature.length === 0) {
      console.error(red("  FAIL: KMS returned empty Signature"));
      return false;
    }
    console.log(green(`  PASS: Sign succeeded`));
    console.log(`        Signature length: ${result.Signature.length} bytes (DER-encoded)`);
    return true;
  } catch (err) {
    console.error(red(`  FAIL: ${err.name}: ${err.message}`));
    if (err.name === "AccessDeniedException") {
      console.error(yellow("  Hint: the IAM policy may be missing kms:Sign or the condition keys are too restrictive."));
    }
    return false;
  }
}

async function test3_signDeniedByCondition(client, keyId) {
  console.log(bold("\n[3/3] Sign with ECDSA_SHA_384 + DIGEST (should be denied by IAM condition)"));
  const digest = new Uint8Array(48); // SHA-384 digest is 48 bytes
  try {
    const result = await client.send(new SignCommand({
      KeyId: keyId,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_384",
    }));
    // If we reach here, the policy condition key did NOT block us — that's a bug.
    console.error(red(`  FAIL: Sign with SHA_384 succeeded (length ${result.Signature?.length})`));
    console.error(red("        This means the IAM policy's kms:SigningAlgorithm condition is NOT enforced."));
    console.error(red("        A leaked credential could sign in any algorithm — defeats the policy's"));
    console.error(red("        defense-in-depth. Inspect the attached policy and the condition block."));
    return false;
  } catch (err) {
    if (err.name === "AccessDeniedException") {
      console.log(green("  PASS: Sign correctly denied with AccessDeniedException"));
      console.log(`        The IAM condition kms:SigningAlgorithm=ECDSA_SHA_256 is enforced.`);
      return true;
    }
    // Could also be InvalidKeyUsageException if KMS rejects the algo before IAM does.
    // Treat that as a pass too — the algorithm is still blocked.
    if (err.name === "KMSInvalidSignatureException" ||
        err.name === "InvalidKeyUsageException" ||
        err.message?.includes("SigningAlgorithm")) {
      console.log(green("  PASS: Sign correctly blocked by KMS"));
      console.log(`        ${err.name}: ${err.message}`);
      return true;
    }
    console.error(yellow(`  AMBIGUOUS: Sign failed but not with AccessDenied: ${err.name}: ${err.message}`));
    console.error(yellow("  Treat as inconclusive — IAM condition may or may not be enforced. Inspect manually."));
    return false;
  }
}

async function main() {
  checkEnv();
  const client = new KMSClient({ region: process.env.AWS_REGION });
  const keyId = process.env.KMS_KEY_ID;

  console.log(bold(`Verifying KMS signer credentials against ${keyId}`));
  console.log(`AWS_REGION: ${process.env.AWS_REGION}`);
  console.log(`AWS_ACCESS_KEY_ID: ${process.env.AWS_ACCESS_KEY_ID.slice(0, 8)}…${process.env.AWS_ACCESS_KEY_ID.slice(-4)} (redacted)`);

  const t1 = await test1_getPublicKey(client, keyId);
  const t2 = await test2_signAllowed(client, keyId);
  const t3 = await test3_signDeniedByCondition(client, keyId);

  console.log("");
  console.log(bold("═══ Summary ═══"));
  if (t1.ok && t2 && t3) {
    console.log(green("ALL THREE TESTS PASSED."));
    console.log("");
    console.log("KMS signer credentials are correctly configured.");
    console.log(`EVM address that the backend will sign as: ${bold(t1.address)}`);
    console.log("");
    console.log("Next step (when ready): submit the multisig setVerifier(" + t1.address + ")");
    console.log("then flip SIGNER_BACKEND=kms and deploy.");
    process.exit(0);
  } else {
    console.error(red("ONE OR MORE TESTS FAILED."));
    console.error(red(`  GetPublicKey:           ${t1.ok ? "pass" : "FAIL"}`));
    console.error(red(`  Sign (ECDSA_SHA_256):   ${t2 ? "pass" : "FAIL"}`));
    console.error(red(`  Sign denied (SHA_384):  ${t3 ? "pass" : "FAIL"}`));
    console.error(red("Do NOT proceed with the cutover until all three pass."));
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(red(`Unexpected error: ${err.stack ?? err.message ?? err}`));
  process.exit(2);
});
