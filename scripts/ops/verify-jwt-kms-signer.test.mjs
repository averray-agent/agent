// Unit tests for verify-jwt-kms-signer.mjs.
//
// Strategy:
//   - The drift-detection and KeySpec checks are exercised in-process
//     using a FakeKMSClient (no real AWS calls).
//   - The "missing env var" and "credential redaction" output behaviors
//     are exercised by spawning the script as a child process with a
//     controlled env, capturing stdout/stderr, and asserting on the
//     emitted strings.
//
// No real AWS network calls are made; no real KMS key is required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runChecks } from "./verify-jwt-kms-signer.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, "verify-jwt-kms-signer.mjs");

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Generate a real P-256 keypair, return the SPKI (DER) bytes, the PEM
 * wrapping, and the SHA-256 fingerprint hex. We re-derive these on
 * every test so we never hardcode a "good" public key.
 */
function p256Fixture() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const fingerprintHex = createHash("sha256").update(der).digest("hex");
  return { der, pem, fingerprintHex };
}

function secp256k1Fixture() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  return { der };
}

/**
 * Stub command constructors. The real `@aws-sdk/client-kms` SDK has its
 * own classes; the script under test never loads them in test mode
 * (the runChecks dependency-injection seam takes them as a parameter).
 * We just need objects whose `.constructor.name` matches the strings
 * the FakeKMSClient dispatches on.
 */
class GetPublicKeyCommand {
  constructor(input) { this.input = input; }
}
class SignCommand {
  constructor(input) { this.input = input; }
}
const STUB_COMMANDS = { GetPublicKeyCommand, SignCommand };

/**
 * Minimal fake KMS client. Mirrors the pattern in
 * mcp-server/src/blockchain/kms-signer.test.js's FakeKMSClient: dispatches
 * on the command's constructor name (`GetPublicKeyCommand` /
 * `SignCommand`).
 */
class FakeKMSClient {
  constructor({ keySpec = "ECC_NIST_P256", spki, signResults = {} }) {
    this.keySpec = keySpec;
    this.spki = spki;
    // signResults maps SigningAlgorithm → "success" | "deny" (default deny).
    // Default: ECDSA_SHA_256 returns a 64-byte buffer; everything else
    // throws AccessDeniedException.
    this.signResults = signResults;
  }
  async send(command) {
    const name = command.constructor.name;
    if (name === "GetPublicKeyCommand") {
      return {
        PublicKey: this.spki,
        KeyId: command.input.KeyId,
        KeySpec: this.keySpec,
        KeyUsage: "SIGN_VERIFY",
        SigningAlgorithms: ["ECDSA_SHA_256"],
      };
    }
    if (name === "SignCommand") {
      const algo = command.input.SigningAlgorithm;
      const planned = this.signResults[algo];
      if (planned === "success" || (planned === undefined && algo === "ECDSA_SHA_256")) {
        return { Signature: new Uint8Array(72), SigningAlgorithm: algo };
      }
      // Default: deny.
      const err = new Error("User is not authorized to perform: kms:Sign");
      err.name = "AccessDeniedException";
      throw err;
    }
    throw new Error(`FakeKMSClient: unexpected command ${name}`);
  }
}

/**
 * Hide console output during a section of test code. We swallow logs so
 * the test runner output stays readable (the script under test is very
 * chatty by design). The script's pass/fail decisions are returned via
 * `runChecks` directly, so we don't lose any assertion signal.
 */
function withQuietConsole(fn) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

// ── In-process drift / KeySpec tests ───────────────────────────────────────

test("drift detection: fingerprint mismatch fails check 2 (env has different SPKI than KMS)", async () => {
  const a = p256Fixture();
  const b = p256Fixture();
  // Env points at SPKI A (PEM + fingerprint of A), but KMS returns SPKI B.
  process.env.JWT_PUBLIC_KEY_PEM = a.pem;
  process.env.JWT_PUBLIC_KEY_FINGERPRINT = `sha256:${a.fingerprintHex}`;
  const client = new FakeKMSClient({ spki: b.der });

  const result = await withQuietConsole(() =>
    runChecks({ client, keyId: "arn:aws:kms:eu-central-2:0:key/fake", commands: STUB_COMMANDS }),
  );

  assert.equal(result.t1, true, "GetPublicKey itself succeeds — KMS returned a valid P-256 SPKI");
  assert.equal(result.t2, false, "drift check MUST fail when env fingerprint != KMS fingerprint");
});

test("drift detection: matching fingerprint passes check 2", async () => {
  const a = p256Fixture();
  process.env.JWT_PUBLIC_KEY_PEM = a.pem;
  process.env.JWT_PUBLIC_KEY_FINGERPRINT = `sha256:${a.fingerprintHex}`;
  const client = new FakeKMSClient({ spki: a.der });

  const result = await withQuietConsole(() =>
    runChecks({ client, keyId: "arn:aws:kms:eu-central-2:0:key/fake", commands: STUB_COMMANDS }),
  );

  assert.equal(result.t1, true);
  assert.equal(result.t2, true, "drift check MUST pass when env fingerprint == KMS fingerprint");
});

test("drift detection: env PEM does not match env fingerprint also fails (caught by SPKI byte compare)", async () => {
  const a = p256Fixture();
  const b = p256Fixture();
  // KMS + fingerprint agree (both point at A), but PEM env var was rendered
  // from a stale 1Password field and decodes to B's bytes.
  process.env.JWT_PUBLIC_KEY_PEM = b.pem;
  process.env.JWT_PUBLIC_KEY_FINGERPRINT = `sha256:${a.fingerprintHex}`;
  const client = new FakeKMSClient({ spki: a.der });

  const result = await withQuietConsole(() =>
    runChecks({ client, keyId: "arn:aws:kms:eu-central-2:0:key/fake", commands: STUB_COMMANDS }),
  );

  assert.equal(result.t1, true);
  assert.equal(result.t2, false, "drift check MUST fail when env PEM disagrees with KMS SPKI");
});

test("KeySpec rejection: wrong curve (ECC_SECG_P256K1) fails check 1", async () => {
  // KMS is reporting a secp256k1 key — that's the BLOCKCHAIN signer's curve,
  // not the JWT signer's. Operator pointed AWS_JWT_KEY_ID at the wrong key.
  const k = secp256k1Fixture();
  process.env.JWT_PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----";
  process.env.JWT_PUBLIC_KEY_FINGERPRINT = `sha256:${"0".repeat(64)}`;
  const client = new FakeKMSClient({ keySpec: "ECC_SECG_P256K1", spki: k.der });

  const result = await withQuietConsole(() =>
    runChecks({ client, keyId: "arn:aws:kms:eu-central-2:0:key/fake", commands: STUB_COMMANDS }),
  );

  assert.equal(result.t1, false, "check 1 must fail when KeySpec != ECC_NIST_P256");
  assert.equal(result.t2, false, "check 2 is skipped (gated on t1) so reports false");
});

test("ECDSA_SHA_384 sign attempt is denied (check 4 passes when KMS refuses)", async () => {
  const a = p256Fixture();
  process.env.JWT_PUBLIC_KEY_PEM = a.pem;
  process.env.JWT_PUBLIC_KEY_FINGERPRINT = `sha256:${a.fingerprintHex}`;
  const client = new FakeKMSClient({ spki: a.der });
  // Default FakeKMSClient denies anything other than ECDSA_SHA_256.

  const result = await withQuietConsole(() =>
    runChecks({ client, keyId: "arn:aws:kms:eu-central-2:0:key/fake", commands: STUB_COMMANDS }),
  );

  assert.equal(result.t3, true, "ECDSA_SHA_256 sign succeeds");
  assert.equal(result.t4, true, "ECDSA_SHA_384 sign correctly denied");
});

test("ECDSA_SHA_384 sign incorrectly succeeding fails check 4 (policy is broken)", async () => {
  const a = p256Fixture();
  process.env.JWT_PUBLIC_KEY_PEM = a.pem;
  process.env.JWT_PUBLIC_KEY_FINGERPRINT = `sha256:${a.fingerprintHex}`;
  const client = new FakeKMSClient({
    spki: a.der,
    signResults: { ECDSA_SHA_256: "success", ECDSA_SHA_384: "success" },
  });

  const result = await withQuietConsole(() =>
    runChecks({ client, keyId: "arn:aws:kms:eu-central-2:0:key/fake", commands: STUB_COMMANDS }),
  );

  assert.equal(result.t3, true);
  assert.equal(
    result.t4, false,
    "check 4 must FAIL when SHA_384 sign succeeds — IAM condition not enforced",
  );
});

// ── Child-process tests: missing env, redaction ─────────────────────────────

test("missing env var: lists all 6 expected op-read instructions, exits 1", () => {
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    env: { PATH: process.env.PATH }, // no AWS_JWT_* / JWT_* vars
    encoding: "utf8",
  });

  assert.equal(proc.status, 1, "exit code must be 1 for missing env");
  const stderr = proc.stderr;
  for (const v of [
    "AWS_JWT_ACCESS_KEY_ID",
    "AWS_JWT_SECRET_ACCESS_KEY",
    "AWS_JWT_REGION",
    "AWS_JWT_KEY_ID",
    "JWT_PUBLIC_KEY_PEM",
    "JWT_PUBLIC_KEY_FINGERPRINT",
  ]) {
    assert.match(stderr, new RegExp(`export ${v}=`), `expected op-read instruction for ${v}`);
  }
  // The instructions must point at the correct 1Password item.
  assert.match(stderr, /op:\/\/prod-backend\/aws-jwt-signer-testnet\//);
});

test("AWS access key is redacted in script output (banner line)", () => {
  // The script will fail at GetPublicKey (the access key doesn't authenticate
  // against any real AWS endpoint, AND the SDK is constructed to use it), so
  // we only care about the banner line that precedes the test runs. To avoid
  // an actual network attempt slowing the test, point the SDK at an obviously
  // unreachable endpoint — the AWS SDK will still print the banner before
  // attempting any call.
  //
  // We send a real-looking access-key-id (AKIA<12 chars>1234) and assert it
  // does NOT appear in full anywhere in stdout or stderr, but the redacted
  // form (first 4 + last 4) does.
  const fakeAccessKey = "AKIAFAKEKEY1234";
  const env = {
    PATH: process.env.PATH,
    AWS_JWT_ACCESS_KEY_ID:        fakeAccessKey,
    AWS_JWT_SECRET_ACCESS_KEY:    "fake-secret-do-not-print",
    AWS_JWT_REGION:               "eu-central-2",
    AWS_JWT_KEY_ID:               "arn:aws:kms:eu-central-2:0:key/fake",
    JWT_PUBLIC_KEY_PEM:           "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
    JWT_PUBLIC_KEY_FINGERPRINT:   `sha256:${"0".repeat(64)}`,
    // Force the SDK to fail fast rather than wait on a real endpoint.
    AWS_ENDPOINT_URL:             "http://127.0.0.1:1",
  };
  const proc = spawnSync(process.execPath, [SCRIPT_PATH], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

  const allOutput = (proc.stdout ?? "") + (proc.stderr ?? "");
  assert.ok(!allOutput.includes(fakeAccessKey),
    "full access key id must NOT appear in output");
  // Match the redacted shape "AKIA…1234".
  assert.match(allOutput, /AKIA…1234/, "redacted access key id must be present in banner");
  // The secret MUST NEVER appear anywhere.
  assert.ok(!allOutput.includes("fake-secret-do-not-print"),
    "AWS secret access key must NOT appear in output under any circumstance");
});
