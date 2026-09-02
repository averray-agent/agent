#!/usr/bin/env node

/**
 * Phase 4b pre-flight — verify AWS KMS JWT-signer credentials and detect
 * drift between the env-rendered public key and the live KMS key.
 *
 * Exercises the same KMS API surface the future KmsJwtSigner (PR 4b.2)
 * will use, with the new IAM credentials provisioned in PR 4b.3, BEFORE
 * any backend code path is wired up. Five tests, each meaningful:
 *
 *   1. GetPublicKey succeeds → proves the IAM user can read the key's
 *      public material AND the key is the expected ECC_NIST_P256
 *      sign-and-verify key (not ECC_SECG_P256K1, not RSA, not encrypt-only).
 *   2. Public-key drift detection → the SPKI bytes returned by KMS
 *      match BOTH the SHA-256 fingerprint in JWT_PUBLIC_KEY_FINGERPRINT
 *      AND the SPKI decoded from JWT_PUBLIC_KEY_PEM. If 1Password and
 *      KMS ever diverge (rotation done in one place but not the other,
 *      operator paste mistake, IAM user pointed at a different key)
 *      this check catches it loudly. The cached public key in env is
 *      what every backend will verify against — drift means tokens
 *      we mint won't verify, or worse, we trust the wrong key.
 *   3. Sign(ECDSA_SHA_256, DIGEST) succeeds → proves the IAM user can
 *      actually mint signatures in the only mode the backend uses.
 *   4. Sign(ECDSA_SHA_384, DIGEST) is denied → proves the IAM policy's
 *      `kms:SigningAlgorithm` condition is enforced. If this PASSES
 *      (i.e., signing succeeds), the policy condition is broken and
 *      a leaked credential could sign in any algorithm.
 *
 * Required environment variables:
 *   AWS_JWT_ACCESS_KEY_ID
 *   AWS_JWT_SECRET_ACCESS_KEY
 *   AWS_JWT_REGION
 *   AWS_JWT_KEY_ID                (full ARN — not alias; alias retargeting is an attack vector, see PHASE_4B_KMS_JWT_PLAN.md §3)
 *   JWT_PUBLIC_KEY_PEM            (PEM-wrapped SPKI of the KMS public key)
 *   JWT_PUBLIC_KEY_FINGERPRINT    (SHA-256 of the SPKI DER bytes, format "sha256:<hex>")
 *
 * Suggested invocation using 1Password CLI to avoid leaving credentials
 * in shell history:
 *
 *   export AWS_JWT_ACCESS_KEY_ID=$(op read 'op://prod-backend/aws-jwt-signer-testnet/access-key-id')
 *   export AWS_JWT_SECRET_ACCESS_KEY=$(op read 'op://prod-backend/aws-jwt-signer-testnet/secret-access-key')
 *   export AWS_JWT_REGION=$(op read 'op://prod-backend/aws-jwt-signer-testnet/aws-region')
 *   export AWS_JWT_KEY_ID=$(op read 'op://prod-backend/aws-jwt-signer-testnet/kms-key-id')
 *   export JWT_PUBLIC_KEY_PEM=$(op read 'op://prod-backend/aws-jwt-signer-testnet/public-key-pem')
 *   export JWT_PUBLIC_KEY_FINGERPRINT=$(op read 'op://prod-backend/aws-jwt-signer-testnet/public-key-fingerprint')
 *   node scripts/ops/verify-jwt-kms-signer.mjs
 *   unset AWS_JWT_ACCESS_KEY_ID AWS_JWT_SECRET_ACCESS_KEY
 *
 * Output rules (enforced in this script):
 *   - Never print private key material (there is none — KMS keys are
 *     non-exportable — but the rule is explicit).
 *   - Never print AWS credentials. AWS_JWT_ACCESS_KEY_ID is redacted to
 *     first 4 + last 4 characters; AWS_JWT_SECRET_ACCESS_KEY is never
 *     printed at all (even by accident).
 *   - The only public-key bytes printed are the SHA-256 fingerprint
 *     and the SPKI byte length.
 *
 * Exit codes:
 *   0    All checks passed — IAM + KMS wiring is correct, no drift.
 *   1    Missing required env var (lists which ones + how to render them).
 *   2    One or more tests failed; details printed.
 *   99   Unexpected error (uncaught exception inside the script).
 */

import { createHash } from "node:crypto";

import { parseP256Spki } from "../../mcp-server/src/auth/p256-spki.js";

// `@aws-sdk/client-kms` is imported lazily inside `makeClient` and the
// `*Command` factories below. Two reasons:
//
//   1. Tests for the pure logic (drift detection, KeySpec rejection,
//      env redaction) drive `runChecks` with a FakeKMSClient and do
//      NOT need the AWS SDK on the import path.
//   2. The SDK loads slowly (~hundreds of ms of v3 modular wiring);
//      delaying the import until we actually need it keeps the
//      `--help` / missing-env failure path snappy.
//
// `test1_getPublicKey` and the two sign tests use the loaded
// commandFactories at call time, supplied via runChecks's parameter.

// ── Env contract ────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "AWS_JWT_ACCESS_KEY_ID",
  "AWS_JWT_SECRET_ACCESS_KEY",
  "AWS_JWT_REGION",
  "AWS_JWT_KEY_ID",
  "JWT_PUBLIC_KEY_PEM",
  "JWT_PUBLIC_KEY_FINGERPRINT",
];

const OP_FIELD_FOR_ENV = {
  AWS_JWT_ACCESS_KEY_ID:        "access-key-id",
  AWS_JWT_SECRET_ACCESS_KEY:    "secret-access-key",
  AWS_JWT_REGION:               "aws-region",
  AWS_JWT_KEY_ID:               "kms-key-id",
  JWT_PUBLIC_KEY_PEM:           "public-key-pem",
  JWT_PUBLIC_KEY_FINGERPRINT:   "public-key-fingerprint",
};

// ── Color helpers (same palette as the Phase 3 script) ─────────────────────

function red(s)    { return `\x1b[31m${s}\x1b[0m`; }
function green(s)  { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function bold(s)   { return `\x1b[1m${s}\x1b[0m`; }

// ── Helpers ─────────────────────────────────────────────────────────────────

function redactAccessKeyId(akid) {
  if (typeof akid !== "string" || akid.length < 8) return "<redacted>";
  return `${akid.slice(0, 4)}…${akid.slice(-4)}`;
}

/**
 * Decode a PEM-encoded SPKI block to its DER bytes.
 *
 * PEM = base64-encoded DER between -----BEGIN/END PUBLIC KEY-----.
 * We do not use node's `createPublicKey` here because we want the raw
 * SPKI bytes for the fingerprint comparison — `KeyObject.export()` would
 * re-encode and may differ in trailing whitespace / line-wrap.
 */
function pemToDer(pem) {
  if (typeof pem !== "string") {
    throw new Error("JWT_PUBLIC_KEY_PEM is not a string");
  }
  const match = pem.match(
    /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/,
  );
  if (!match) {
    throw new Error(
      "JWT_PUBLIC_KEY_PEM does not contain a PUBLIC KEY PEM block (missing BEGIN/END markers)",
    );
  }
  const b64 = match[1].replace(/\s+/g, "");
  if (b64.length === 0) {
    throw new Error("JWT_PUBLIC_KEY_PEM has an empty PUBLIC KEY block");
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Normalize a SHA-256 fingerprint string for comparison.
 *
 * Accepts the form `sha256:<hex>` (operator runbook output) and bare hex
 * for forgiveness; produces lowercase hex without prefix.
 */
function normalizeFingerprint(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  const hex = trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return hex;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── Env preflight ──────────────────────────────────────────────────────────

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(red(`Missing required env vars: ${missing.join(", ")}`));
    console.error("Render them via:");
    for (const k of missing) {
      const field = OP_FIELD_FOR_ENV[k];
      console.error(`  export ${k}=$(op read 'op://prod-backend/aws-jwt-signer-testnet/${field}')`);
    }
    process.exit(1);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function test1_getPublicKey(client, keyId, { GetPublicKeyCommand }) {
  console.log(bold("\n[1/4] GetPublicKey"));
  try {
    const result = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!result.PublicKey) {
      console.error(red("  FAIL: KMS returned empty PublicKey"));
      return { ok: false };
    }
    const spki = new Uint8Array(result.PublicKey);

    // KeySpec — MUST be ECC_NIST_P256.
    if (result.KeySpec !== "ECC_NIST_P256") {
      console.error(red(`  FAIL: KeySpec is ${result.KeySpec}, expected ECC_NIST_P256`));
      console.error(red("        JWT signer must use P-256 (NIST), NOT the secp256k1 curve"));
      console.error(red("        used by the blockchain signer. Different key, different curve,"));
      console.error(red("        different algorithm — re-read PHASE_4B_KMS_JWT_PLAN.md §2-3."));
      return { ok: false };
    }
    // KeyUsage — MUST be SIGN_VERIFY (not ENCRYPT_DECRYPT, not GENERATE_VERIFY_MAC).
    if (result.KeyUsage !== "SIGN_VERIFY") {
      console.error(red(`  FAIL: KeyUsage is ${result.KeyUsage}, expected SIGN_VERIFY`));
      return { ok: false };
    }
    // SigningAlgorithms — MUST include ECDSA_SHA_256.
    const algos = result.SigningAlgorithms ?? [];
    if (!algos.includes("ECDSA_SHA_256")) {
      console.error(red(`  FAIL: SigningAlgorithms ${JSON.stringify(algos)} does not include ECDSA_SHA_256`));
      return { ok: false };
    }

    // Sanity-parse the SPKI through our P-256 parser — refuses to operate
    // on any non-P-256 curve, catches malformed DER, and proves the key is
    // structurally what `parseP256Spki` (used at backend boot in PR 4b.4+)
    // will accept.
    parseP256Spki(spki);

    console.log(green(`  PASS: GetPublicKey succeeded`));
    console.log(`        KeyId:               ${result.KeyId}`);
    console.log(`        KeySpec:             ${result.KeySpec}`);
    console.log(`        KeyUsage:            ${result.KeyUsage}`);
    console.log(`        SigningAlgorithms:   ${algos.join(", ")}`);
    console.log(`        SPKI byte length:    ${spki.length}`);
    return { ok: true, spki };
  } catch (err) {
    console.error(red(`  FAIL: ${err.name}: ${err.message}`));
    return { ok: false };
  }
}

async function test2_publicKeyDrift(kmsSpki) {
  console.log(bold("\n[2/4] Public-key drift detection (env vs KMS)"));
  // Compute the canonical fingerprint of the KMS-returned SPKI bytes.
  const actualHex = sha256Hex(kmsSpki);

  // Compare against the env-provided fingerprint.
  const expectedHex = normalizeFingerprint(process.env.JWT_PUBLIC_KEY_FINGERPRINT);
  if (!expectedHex) {
    console.error(red(`  FAIL: JWT_PUBLIC_KEY_FINGERPRINT is not in the expected "sha256:<64-hex>" form`));
    console.error(red("        Recompute with:  openssl pkey -pubin -in <pemfile> -outform DER | shasum -a 256"));
    return false;
  }
  if (actualHex !== expectedHex) {
    console.error(red(bold("  FAIL: PUBLIC-KEY FINGERPRINT MISMATCH — env drift detected")));
    console.error(red(`        Expected (env): sha256:${expectedHex}`));
    console.error(red(`        Actual (KMS):   sha256:${actualHex}`));
    console.error(red("        The cached public key in env does NOT match the live KMS key."));
    console.error(red("        Tokens signed by KMS will NOT verify against the env-cached key."));
    console.error(red("        Possible causes:"));
    console.error(red("          - JWT key was rotated in KMS but 1Password not updated"));
    console.error(red("          - 1Password was updated but AWS_JWT_KEY_ID points at a different key"));
    console.error(red("          - JWT_PUBLIC_KEY_FINGERPRINT was hand-edited / copy-paste error"));
    console.error(red("        Do NOT proceed with cutover until this resolves."));
    return false;
  }

  // Also verify that JWT_PUBLIC_KEY_PEM decodes to the same SPKI bytes as KMS.
  let pemDer;
  try {
    pemDer = pemToDer(process.env.JWT_PUBLIC_KEY_PEM);
  } catch (err) {
    console.error(red(`  FAIL: ${err.message}`));
    return false;
  }
  if (pemDer.length !== kmsSpki.length || !pemDer.every((b, i) => b === kmsSpki[i])) {
    console.error(red("  FAIL: JWT_PUBLIC_KEY_PEM decodes to SPKI bytes that DIFFER from KMS GetPublicKey"));
    console.error(red(`        PEM-decoded SPKI sha256: sha256:${sha256Hex(pemDer)}`));
    console.error(red(`        KMS SPKI sha256:         sha256:${actualHex}`));
    console.error(red("        Even though the fingerprint env var matches KMS, the PEM env var"));
    console.error(red("        does not — one of the two was rendered from a stale 1Password field."));
    return false;
  }

  // Final structural check on the PEM-decoded SPKI.
  try {
    parseP256Spki(pemDer);
  } catch (err) {
    console.error(red(`  FAIL: JWT_PUBLIC_KEY_PEM does not parse as a P-256 SPKI: ${err.message}`));
    return false;
  }

  console.log(green("  PASS: Public-key fingerprint matches KMS and JWT_PUBLIC_KEY_PEM"));
  console.log(`        SHA-256 (SPKI DER): sha256:${actualHex}`);
  console.log(`        SPKI byte length:   ${kmsSpki.length}`);
  return true;
}

async function test3_signAllowed(client, keyId, { SignCommand }) {
  console.log(bold("\n[3/4] Sign with ECDSA_SHA_256 + DIGEST (the allowed mode)"));
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
      console.error(yellow("  Hint: IAM policy may be missing kms:Sign or the condition keys are too restrictive."));
    }
    return false;
  }
}

async function test4_signDeniedByCondition(client, keyId, { SignCommand }) {
  console.log(bold("\n[4/4] Sign with ECDSA_SHA_384 + DIGEST (should be denied)"));
  const digest = new Uint8Array(48); // SHA-384 digest is 48 bytes
  try {
    const result = await client.send(new SignCommand({
      KeyId: keyId,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_384",
    }));
    // If we reach here, the policy condition key did NOT block us.
    console.error(red(`  FAIL: Sign with SHA_384 succeeded (length ${result.Signature?.length})`));
    console.error(red("        The IAM policy's kms:SigningAlgorithm condition is NOT enforced."));
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

// ── Wiring ─────────────────────────────────────────────────────────────────

/**
 * Lazy-load the AWS SDK and build a KMSClient. The dependency-injection
 * seam (`makeClient` plus the explicit `commands` parameter on `runChecks`)
 * lets the test suite stub out the AWS SDK without ever loading
 * `@aws-sdk/client-kms` on the import path.
 */
export async function makeClient({ region, credentials } = {}) {
  const { KMSClient, GetPublicKeyCommand, SignCommand } = await import("@aws-sdk/client-kms");
  const client = new KMSClient({
    region: region ?? process.env.AWS_JWT_REGION,
    credentials: credentials ?? {
      accessKeyId:     process.env.AWS_JWT_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_JWT_SECRET_ACCESS_KEY,
    },
  });
  return { client, commands: { GetPublicKeyCommand, SignCommand } };
}

/**
 * Run all four checks. Returns an object with a boolean per test; the
 * caller decides exit code. Exported so the test suite can drive it
 * with a fake client.
 *
 * `commands` MUST expose the `GetPublicKeyCommand` and `SignCommand`
 * constructors. In production this comes from `makeClient`; in tests
 * we pass minimal stubs that match the AWS SDK's command-object shape
 * (the FakeKMSClient dispatches on `command.constructor.name`).
 */
export async function runChecks({ client, keyId, commands }) {
  const t1 = await test1_getPublicKey(client, keyId, commands);
  let t2 = false;
  if (t1.ok) {
    t2 = await test2_publicKeyDrift(t1.spki);
  } else {
    console.log(bold("\n[2/4] Public-key drift detection (env vs KMS)"));
    console.error(red("  SKIP: GetPublicKey failed — cannot compare against KMS"));
  }
  const t3 = await test3_signAllowed(client, keyId, commands);
  const t4 = await test4_signDeniedByCondition(client, keyId, commands);
  return { t1: t1.ok, t2, t3, t4 };
}

async function main() {
  checkEnv();
  const keyId = process.env.AWS_JWT_KEY_ID;

  console.log(bold(`Verifying JWT KMS signer credentials against ${keyId}`));
  console.log(`AWS_JWT_REGION:        ${process.env.AWS_JWT_REGION}`);
  console.log(`AWS_JWT_ACCESS_KEY_ID: ${redactAccessKeyId(process.env.AWS_JWT_ACCESS_KEY_ID)} (redacted)`);
  // AWS_JWT_SECRET_ACCESS_KEY is never printed at all — not even redacted.

  const { client, commands } = await makeClient();
  const { t1, t2, t3, t4 } = await runChecks({ client, keyId, commands });

  console.log("");
  console.log(bold("═══ Summary ═══"));
  if (t1 && t2 && t3 && t4) {
    console.log(green("ALL FOUR TESTS PASSED."));
    console.log("");
    console.log("KMS JWT signer credentials are correctly configured and the cached");
    console.log("public key matches the live KMS key. Safe to proceed to PR 4b.4 (the");
    console.log("dispatcher + JWT_BACKEND flag wiring).");
    process.exit(0);
  } else {
    console.error(red("ONE OR MORE TESTS FAILED."));
    console.error(red(`  GetPublicKey + KeySpec/KeyUsage check:  ${t1 ? "pass" : "FAIL"}`));
    console.error(red(`  Public-key drift (env vs KMS):          ${t2 ? "pass" : "FAIL"}`));
    console.error(red(`  Sign (ECDSA_SHA_256):                   ${t3 ? "pass" : "FAIL"}`));
    console.error(red(`  Sign denied (SHA_384):                  ${t4 ? "pass" : "FAIL"}`));
    console.error(red("Do NOT proceed with the cutover until all four pass."));
    process.exit(2);
  }
}

// Only run main() when this file is executed directly (not when imported
// for tests). The `import.meta.url` vs argv check is the idiomatic
// ESM equivalent of `require.main === module`.
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");

if (isDirectInvocation) {
  main().catch((err) => {
    console.error(red(`Unexpected error: ${err.stack ?? err.message ?? err}`));
    process.exit(99);
  });
}
