import { test } from "node:test";
import assert from "node:assert/strict";

import { validateJwtKmsCredentialAccess } from "./credential-check.js";
import { ConfigError } from "../core/errors.js";

// FakeKMSClient mirrors the pattern used in kms-jwt-signer.test.js —
// pluggable per-command behavior so each test can stub the right
// failure mode. Real KMS isn't reachable from this worktree's
// node_modules anyway.
class FakeKMSClient {
  constructor({ describeKey } = {}) {
    this._describeKey = describeKey;
    this.calls = [];
  }
  async send(command) {
    this.calls.push(command);
    const name = command.constructor.name;
    if (name === "DescribeKeyCommand") {
      if (typeof this._describeKey !== "function") {
        throw new Error(`FakeKMSClient: no describeKey handler configured`);
      }
      return this._describeKey(command);
    }
    throw new Error(`FakeKMSClient: unexpected command ${name}`);
  }
}

const KEY_ARN = "arn:aws:kms:eu-central-2:079209845430:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const VALID_CFG = {
  region: "eu-central-2",
  keyId: KEY_ARN,
};

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
      describeKey: () => {
        throw new Error("should not be called");
      },
    }),
  };
  const logger = silentLogger();
  const result = await validateJwtKmsCredentialAccess(cfg, { skip: true, logger });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, "explicit");
});

test("validateJwtKmsCredentialAccess: respects JWT_KMS_CREDENTIAL_CHECK_SKIP=1 env hatch", async () => {
  const prior = process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP;
  process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP = "1";
  try {
    const cfg = {
      ...VALID_CFG,
      kmsClient: new FakeKMSClient({
        describeKey: () => {
          throw new Error("should not be called");
        },
      }),
    };
    const result = await validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() });
    assert.equal(result.skipped, "explicit");
  } finally {
    if (prior === undefined) delete process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP;
    else process.env.JWT_KMS_CREDENTIAL_CHECK_SKIP = prior;
  }
});

test("validateJwtKmsCredentialAccess: happy path returns key metadata", async () => {
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      describeKey: () => ({
        KeyMetadata: {
          Arn: KEY_ARN,
          KeyState: "Enabled",
          KeyUsage: "SIGN_VERIFY",
          KeySpec: "ECC_NIST_P256",
        },
      }),
    }),
  };
  const result = await validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() });
  assert.equal(result.ok, true);
  assert.equal(result.keyArn, KEY_ARN);
  assert.equal(result.keyState, "Enabled");
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
      describeKey: () => {
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

test("validateJwtKmsCredentialAccess: classifies AccessDeniedException with kms:DescribeKey IAM hint", async () => {
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      describeKey: () => {
        const e = new Error("User: arn:... is not authorized to perform: kms:DescribeKey");
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
      assert.match(err.message, /lacks kms:DescribeKey/i);
      assert.match(err.message, /JWT_KMS_CREDENTIAL_CHECK_SKIP=1/);
      return true;
    },
  );
});

test("validateJwtKmsCredentialAccess: classifies NotFoundException with region-mismatch hint", async () => {
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      describeKey: () => {
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

test("validateJwtKmsCredentialAccess: rejects when key is disabled", async () => {
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      describeKey: () => ({
        KeyMetadata: {
          Arn: KEY_ARN,
          KeyState: "Disabled",
          KeyUsage: "SIGN_VERIFY",
        },
      }),
    }),
  };
  await assert.rejects(
    () => validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() }),
    (err) => err instanceof ConfigError && /state "Disabled"/.test(err.message),
  );
});

test("validateJwtKmsCredentialAccess: rejects when key has wrong KeyUsage (likely the blockchain key by mistake)", async () => {
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      describeKey: () => ({
        KeyMetadata: {
          Arn: KEY_ARN,
          KeyState: "Enabled",
          KeyUsage: "ENCRYPT_DECRYPT", // wrong shape for a JWT signer
        },
      }),
    }),
  };
  await assert.rejects(
    () => validateJwtKmsCredentialAccess(cfg, { logger: silentLogger() }),
    (err) => err instanceof ConfigError && /KeyUsage="ENCRYPT_DECRYPT"/.test(err.message),
  );
});

test("validateJwtKmsCredentialAccess: opts.credentialsProvider is accepted (regression for #455/#456 outage)", async () => {
  // Regression coverage for the Phase 5a Stage 2C-3 outage. Pre-fix,
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
  // regressing existing behavior. The structural fix (passing the
  // provider into `new KMSClient`) is exercised end-to-end on the
  // first prod boot after merge: a failure there would resurface the
  // same CredentialsProviderError seen in the outage.
  const provider = async () => {
    throw new Error("test credentialsProvider should not be invoked when kmsClient is injected");
  };
  const cfg = {
    ...VALID_CFG,
    kmsClient: new FakeKMSClient({
      describeKey: () => ({
        KeyMetadata: { Arn: KEY_ARN, KeyState: "Enabled", KeyUsage: "SIGN_VERIFY" },
      }),
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
      describeKey: () => ({
        KeyMetadata: { Arn: KEY_ARN, KeyState: "Enabled", KeyUsage: "SIGN_VERIFY" },
      }),
    }),
  };
  await validateJwtKmsCredentialAccess(cfg, { logger });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, "info");
  assert.equal(logs[0].msg, "jwt-kms-credential-check.ok");
  assert.equal(logs[0].obj.keyId, KEY_ARN);
  assert.equal(logs[0].obj.keyState, "Enabled");
});
