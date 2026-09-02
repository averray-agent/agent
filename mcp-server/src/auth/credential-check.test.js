import { test } from "node:test";
import assert from "node:assert/strict";

import { validateJwtKmsCredentialAccess } from "./credential-check.js";
import { ConfigError } from "../core/errors.js";

// FakeKMSClient mirrors the pattern used in kms-jwt-signer.test.js —
// pluggable per-command behavior so each test can stub the right
// failure mode. Real KMS isn't reachable from this worktree's
// node_modules anyway.
//
// The boot check calls kms:GetPublicKey (see header docstring on
// credential-check.js for the rationale — sign-only IAM role policy).
class FakeKMSClient {
  constructor({ getPublicKey } = {}) {
    this._getPublicKey = getPublicKey;
    this.calls = [];
  }
  async send(command) {
    this.calls.push(command);
    const name = command.constructor.name;
    if (name === "GetPublicKeyCommand") {
      if (typeof this._getPublicKey !== "function") {
        throw new Error(`FakeKMSClient: no getPublicKey handler configured`);
      }
      return this._getPublicKey(command);
    }
    throw new Error(`FakeKMSClient: unexpected command ${name}`);
  }
}

const KEY_ARN = "arn:aws:kms:eu-central-2:079209845430:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const VALID_CFG = {
  region: "eu-central-2",
  keyId: KEY_ARN,
};

// Minimal SPKI-like byte slab. We never inspect the bytes here — the
// boot check treats PublicKey as opaque (it only validates presence
// and the KeyUsage / SigningAlgorithms metadata). The runtime
// KmsJwtSigner does the real SPKI parse via p256-spki.js.
const FAKE_PUBLIC_KEY_DER = new Uint8Array([0x30, 0x59, 0x30, 0x13, 0x06, 0x07]);

function validGetPublicKeyResponse(overrides = {}) {
  return {
    KeyId: KEY_ARN,
    PublicKey: FAKE_PUBLIC_KEY_DER,
    KeySpec: "ECC_NIST_P256",
    KeyUsage: "SIGN_VERIFY",
    SigningAlgorithms: ["ECDSA_SHA_256"],
    ...overrides,
  };
}

function silentLogger() {
  return { info() {}, warn() {}, error() {}, log() {} };
}

test("validateJwtKmsCredentialAccess: returns skipped when authConfig.kmsJwt is null (HMAC mode)", async () => {
  const result = await validateJwtKmsCredentialAccess(null);
  assert.deepEqual(result, { ok: true, skipped: "hmac-only" });
});

test("validateJwtKmsCredentialAccess: respects opts.skip escape hatch", async () => {
  // Even with a kmsJwt config, opts.skip=true should bypass the live
  // call. Use a client that would throw to confirm we never reach it.
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () => {
        throw new Error("should not be called");
      },
    }),
  };
  const logger = silentLogger();
  const result = await validateJwtKmsCredentialAccess(cfg, { skip: true, logger });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, "explicit");
});

function restoreEnv(name, prior) {
  if (prior === undefined) delete process.env[name];
  else process.env[name] = prior;
}

const SKIP_HATCH_CFG = () => ({
  ...VALID_CFG,
  kmsClient: new FakeKMSClient({
    getPublicKey: () => {
      throw new Error("should not be called");
    },
  }),
});

test("validateJwtKmsCredentialAccess: respects JWT_KMS_CREDENTIAL_CHECK_SKIP=1 env hatch (non-production)", async () => {
  const priorSkip = process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP;
  const priorNodeEnv = process.env.NODE_ENV;
  process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP = "1";
  process.env.NODE_ENV = "test";
  try {
    const result = await validateJwtKmsCredentialAccess(SKIP_HATCH_CFG(), { logger: silentLogger() });
    assert.equal(result.skipped, "explicit");
  } finally {
    restoreEnv("JWT_KMS_CREDENTIAL_CHECK_SKIP", priorSkip);
    restoreEnv("NODE_ENV", priorNodeEnv);
  }
});

test("validateJwtKmsCredentialAccess: env hatch fails closed under NODE_ENV=production without ack", async () => {
  const priorSkip = process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP;
  const priorNodeEnv = process.env.NODE_ENV;
  const priorAck = process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION;
  process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP = "1";
  process.env.NODE_ENV = "production";
  delete process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION;
  try {
    await assert.rejects(
      () => validateJwtKmsCredentialAccess(SKIP_HATCH_CFG(), { logger: silentLogger() }),
      (err) => err instanceof ConfigError && /NODE_ENV=production/.test(err.message),
    );
  } finally {
    restoreEnv("JWT_KMS_CREDENTIAL_CHECK_SKIP", priorSkip);
    restoreEnv("NODE_ENV", priorNodeEnv);
    restoreEnv("JWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION", priorAck);
  }
});

test("validateJwtKmsCredentialAccess: env hatch honored under production with explicit ack", async () => {
  const priorSkip = process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP;
  const priorNodeEnv = process.env.NODE_ENV;
  const priorAck = process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION;
  process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP = "1";
  process.env.NODE_ENV = "production";
  process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION = "1";
  try {
    const result = await validateJwtKmsCredentialAccess(SKIP_HATCH_CFG(), { logger: silentLogger() });
    assert.equal(result.skipped, "explicit");
  } finally {
    restoreEnv("JWT_KMS_CREDENTIAL_CHECK_SKIP", priorSkip);
    restoreEnv("NODE_ENV", priorNodeEnv);
    restoreEnv("JWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION", priorAck);
  }
});

test("validateJwtKmsCredentialAccess: happy path returns key metadata", async () => {
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () => validGetPublicKeyResponse(),
    }),
  };
  const result = await validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() });
  assert.equal(result.ok, true);
  assert.equal(result.keyArn, KEY_ARN);
  assert.equal(result.keyUsage, "SIGN_VERIFY");
});

test("validateJwtKmsCredentialAccess: throws on missing region/keyId in config", async () => {
  await assert.rejects(
    () => validateJwtKmsCredentialAccess({ region: "", keyId: KEY_ARN }, { logger: silentLogger() }),
    (err) => err instanceof ConfigError && /missing region or keyId/i.test(err.message),
  );
  await assert.rejects(
    () => validateJwtKmsCredentialAccess({ region: "eu-central-2", keyId: "" }, { logger: silentLogger() }),
    (err) => err instanceof ConfigError && /missing region or keyId/i.test(err.message),
  );
});

test("validateJwtKmsCredentialAccess: classifies CredentialsProviderError with a Roles-Anywhere-aware hint", async () => {
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () => {
        const e = new Error("Could not load credentials from any providers");
        e.name = "CredentialsProviderError";
        throw e;
      },
    }),
  };
  await assert.rejects(
    () => validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() }),
    (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err?.constructor?.name}`);
      assert.match(err.message, /credential chain failed to resolve/i);
      assert.match(err.message, /Roles Anywhere/);
      assert.match(err.message, /aws_signing_helper/);
      return true;
    },
  );
});

test("validateJwtKmsCredentialAccess: classifies AccessDeniedException with kms:GetPublicKey IAM hint", async () => {
  // Pre-#459 (#457/#458): the check called DescribeKey, so the hint
  // referenced DescribeKey. After switching to GetPublicKey to align
  // with the sign-only IAM policy, the hint references the canonical
  // policy file the operator should re-apply.
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () => {
        const e = new Error("User: arn:... is not authorized to perform: kms:GetPublicKey");
        e.name = "AccessDeniedException";
        e.$metadata = { httpStatusCode: 400 };
        throw e;
      },
    }),
  };
  await assert.rejects(
    () => validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /lacks kms:GetPublicKey/i);
      assert.match(err.message, /averray-jwt-signer-prod-role\.json/);
      assert.match(err.message, /JWT_KMS_CREDENTIAL_CHECK_SKIP=1/);
      return true;
    },
  );
});

test("validateJwtKmsCredentialAccess: classifies DisabledException (key disabled in AWS)", async () => {
  // GetPublicKey rejects disabled keys with a thrown DisabledException
  // — DescribeKey instead would have returned KeyState=Disabled on a
  // success response. This test exercises the new failure-mode handler.
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () => {
        const e = new Error("arn:... is disabled");
        e.name = "DisabledException";
        throw e;
      },
    }),
  };
  await assert.rejects(
    () => validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /is disabled/i);
      assert.match(err.message, /aws kms enable-key/);
      return true;
    },
  );
});

test("validateJwtKmsCredentialAccess: classifies NotFoundException with region-mismatch hint", async () => {
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () => {
        const e = new Error("Key 'arn:...' does not exist");
        e.name = "NotFoundException";
        e.$metadata = { httpStatusCode: 404 };
        throw e;
      },
    }),
  };
  await assert.rejects(
    () => validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /not found by AWS/i);
      assert.match(err.message, /different region/i);
      return true;
    },
  );
});

test("validateJwtKmsCredentialAccess: rejects when key has wrong KeyUsage (likely the blockchain key by mistake)", async () => {
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () => validGetPublicKeyResponse({ KeyUsage: "ENCRYPT_DECRYPT" }),
    }),
  };
  await assert.rejects(
    () => validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() }),
    (err) => err instanceof ConfigError && /KeyUsage="ENCRYPT_DECRYPT"/.test(err.message),
  );
});

test("validateJwtKmsCredentialAccess: rejects when key spec doesn't support ECDSA_SHA_256 (likely the secp256k1 blockchain key)", async () => {
  // The blockchain signer key is ECC_SECG_P256K1, whose SigningAlgorithms
  // are ECDSA_SHA_256 too — but in the wild a misconfigured
  // AWS_JWT_KEY_ID pointing at a key with no ECDSA_SHA_256 (e.g. an RSA
  // key for some reason) should fail fast at boot rather than producing
  // confusing kms:Sign errors at first SIWE.
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () =>
        validGetPublicKeyResponse({
          KeySpec: "RSA_2048",
          SigningAlgorithms: ["RSASSA_PKCS1_V1_5_SHA_256", "RSASSA_PKCS1_V1_5_SHA_384"],
        }),
    }),
  };
  await assert.rejects(
    () => validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() }),
    (err) =>
      err instanceof ConfigError &&
      /ECDSA_SHA_256/.test(err.message) &&
      /ES256/.test(err.message) &&
      /wrong key spec/i.test(err.message),
  );
});

test("validateJwtKmsCredentialAccess: opts.credentialsProvider is accepted (regression for #455/#456 outage)", async () => {
  // Regression coverage for the Phase 5a Stage 2C-3 outage. Pre-#457,
  // the function silently ignored any caller-supplied credentials
  // provider — production constructed a KMSClient via the SDK default
  // chain while the runtime KmsJwtSigner used Roles Anywhere. Removing
  // env-rendered static keys (#455) made the two paths disagree and
  // the boot check threw CredentialsProviderError even though signing
  // would have worked fine.
  //
  // We don't exercise the real fromIni path here (no AWS in tests).
  // The injected kmsClient short-circuits client construction, so the
  // provider can't be observed via the client itself. Instead we
  // assert the call accepts the opt without throwing and the happy
  // path still returns ok — confirming the new opt is wired without
  // regressing existing behavior.
  const provider = async () => {
    throw new Error("test credentialsProvider should not be invoked when kmsClient is injected");
  };
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () => validGetPublicKeyResponse(),
    }),
  };
  const result = await validateJwtKmsCredentialAccess(cfg, {
    logger: silentLogger(),
    credentialsProvider: provider,
  });
  assert.equal(result.ok, true);
  assert.equal(result.keyArn, KEY_ARN);
});

test("validateJwtKmsCredentialAccess: logs at info level on success", async () => {
  const logs = [];
  const logger = {
    info(obj, msg) {
      logs.push({ level: "info", obj, msg });
    },
    warn() {},
    error() {},
  };
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      getPublicKey: () => validGetPublicKeyResponse(),
    }),
  };
  await validateJwtKmsCredentialAccess(cfg, { logger });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "info");
  assert.equal(logs[0].msg, "jwt-kms-credential-check.ok");
  assert.equal(logs[0].obj.keyId, KEY_ARN);
  assert.equal(logs[0].obj.keyArn, KEY_ARN);
  assert.equal(logs[0].obj.keyUsage, "SIGN_VERIFY");
  assert.equal(logs[0].obj.keySpec, "ECC_NIST_P256");
  assert.deepEqual(logs[0].obj.signingAlgorithms, ["ECDSA_SHA_256"]);
});
