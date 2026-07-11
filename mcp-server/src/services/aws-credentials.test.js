import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildKmsCredentialsProvider,
  buildRequiredKmsCredentialsProvider,
  PROFILE_BADGE_RECEIPT_SIGNER,
  PROFILE_BLOCKCHAIN_SIGNER,
  PROFILE_JWT_SIGNER,
  ROLES_ANYWHERE_FLAG_ENV_VAR,
} from "./aws-credentials.js";
import { ConfigError } from "../core/errors.js";

test("buildKmsCredentialsProvider: returns null when flag is unset (default chain)", () => {
  const provider = buildKmsCredentialsProvider({
    profile: PROFILE_BLOCKCHAIN_SIGNER,
    env: {},
  });
  assert.equal(provider, null);
});

test("buildKmsCredentialsProvider: returns null when flag is explicitly 'false'", () => {
  const provider = buildKmsCredentialsProvider({
    profile: PROFILE_BLOCKCHAIN_SIGNER,
    env: { [ROLES_ANYWHERE_FLAG_ENV_VAR]: "false" },
  });
  assert.equal(provider, null);
});

test("buildKmsCredentialsProvider: returns null on arbitrary non-true values", () => {
  for (const value of ["0", "no", "off", "FALSE", "True   ", " true", "1", ""]) {
    const provider = buildKmsCredentialsProvider({
      profile: PROFILE_BLOCKCHAIN_SIGNER,
      env: { [ROLES_ANYWHERE_FLAG_ENV_VAR]: value },
    });
    // Only "true" (case-insensitive, trimmed) enables. Everything else
    // is null — fail-safe default.
    if (value.trim().toLowerCase() === "true") {
      assert.notEqual(provider, null, `expected non-null for value=${JSON.stringify(value)}`);
    } else {
      assert.equal(provider, null, `expected null for value=${JSON.stringify(value)}`);
    }
  }
});

test("buildKmsCredentialsProvider: returns a fromIni-shaped provider function when flag is 'true'", () => {
  const provider = buildKmsCredentialsProvider({
    profile: PROFILE_JWT_SIGNER,
    env: { [ROLES_ANYWHERE_FLAG_ENV_VAR]: "true" },
  });
  // fromIni returns a function the SDK calls to refresh credentials.
  // We don't invoke it here (would attempt to spawn aws_signing_helper
  // against a real config file we don't have in tests). The presence
  // of a function-shaped return is the contract.
  assert.equal(typeof provider, "function");
});

test("buildKmsCredentialsProvider: 'TRUE' is also accepted (case-insensitive)", () => {
  const provider = buildKmsCredentialsProvider({
    profile: PROFILE_BLOCKCHAIN_SIGNER,
    env: { [ROLES_ANYWHERE_FLAG_ENV_VAR]: "TRUE" },
  });
  assert.equal(typeof provider, "function");
});

test("buildKmsCredentialsProvider: ' true ' (with whitespace) is accepted", () => {
  const provider = buildKmsCredentialsProvider({
    profile: PROFILE_BLOCKCHAIN_SIGNER,
    env: { [ROLES_ANYWHERE_FLAG_ENV_VAR]: "  true\n" },
  });
  assert.equal(typeof provider, "function");
});

test("buildKmsCredentialsProvider: throws ConfigError when profile is missing under flag=true", () => {
  assert.throws(
    () =>
      buildKmsCredentialsProvider({
        env: { [ROLES_ANYWHERE_FLAG_ENV_VAR]: "true" },
      }),
    (err) =>
      err instanceof ConfigError &&
      /profile is required/i.test(err.message) &&
      /AWS_USE_ROLES_ANYWHERE=true/.test(err.message),
  );
});

test("buildKmsCredentialsProvider: throws ConfigError on empty/non-string profile under flag=true", () => {
  for (const profile of ["", "   ", 42, null, undefined, {}]) {
    assert.throws(
      () =>
        buildKmsCredentialsProvider({
          profile,
          env: { [ROLES_ANYWHERE_FLAG_ENV_VAR]: "true" },
        }),
      (err) => err instanceof ConfigError && /profile is required/i.test(err.message),
      `expected throw for profile=${JSON.stringify(profile)}`,
    );
  }
});

test("buildKmsCredentialsProvider: with default env arg, reads process.env", () => {
  // Smoke-test the default-arg path. process.env.AWS_USE_ROLES_ANYWHERE
  // is almost certainly unset in the test runner, so we expect null.
  // (We explicitly unset to be safe.)
  const prior = process.env[ROLES_ANYWHERE_FLAG_ENV_VAR];
  delete process.env[ROLES_ANYWHERE_FLAG_ENV_VAR];
  try {
    const provider = buildKmsCredentialsProvider({ profile: PROFILE_JWT_SIGNER });
    assert.equal(provider, null);
  } finally {
    if (prior !== undefined) process.env[ROLES_ANYWHERE_FLAG_ENV_VAR] = prior;
  }
});

test("buildKmsCredentialsProvider: exported profile constants match the §5.3 aws-config", () => {
  // These names are baked into the VPS /etc/agent-stack/aws-config
  // produced during Phase 5a operator setup. Renaming either constant
  // here without renaming the profile section in the aws-config would
  // make Roles Anywhere silently fall back to default chain.
  assert.equal(PROFILE_BLOCKCHAIN_SIGNER, "averray-signer");
  assert.equal(PROFILE_JWT_SIGNER, "averray-jwt-signer");
  assert.equal(PROFILE_BADGE_RECEIPT_SIGNER, "averray-badge-receipt-signer");
});

test("buildRequiredKmsCredentialsProvider never needs the global fallback-chain flag", () => {
  const provider = buildRequiredKmsCredentialsProvider({ profile: PROFILE_BADGE_RECEIPT_SIGNER });
  assert.equal(typeof provider, "function");
  assert.throws(
    () => buildRequiredKmsCredentialsProvider({ profile: "" }),
    (error) => error instanceof ConfigError && /dedicated PROFILE/u.test(error.message),
  );
});
