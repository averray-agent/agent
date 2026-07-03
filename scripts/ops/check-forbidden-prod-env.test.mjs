// Tests for scripts/ops/check-forbidden-prod-env.mjs.
//
// This guard is the deploy-time half of H1 (the runtime half lives in
// mcp-server/src/auth/credential-check.js). It must catch an *enabled* emergency
// bypass in a committed env file while NOT tripping on documentation (commented
// mentions) or explicit disables — otherwise it's either useless or so noisy it
// gets disabled.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { scanEnvText, FORBIDDEN_PROD_ENV_KEYS, DEFAULT_TARGETS } from "./check-forbidden-prod-env.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("flags an actively-enabled JWT_KMS_CREDENTIAL_CHECK_SKIP", () => {
  const v = scanEnvText("NODE_ENV=production\nJWT_KMS_CREDENTIAL_CHECK_SKIP=1\n", "x.env");
  assert.equal(v.length, 1);
  assert.equal(v[0].key, "JWT_KMS_CREDENTIAL_CHECK_SKIP");
  assert.equal(v[0].line, 2);
  assert.equal(v[0].source, "x.env");
});

test("flags true/yes/on and quoted truthy values", () => {
  for (const val of ["true", "TRUE", "yes", "on", '"1"', "'1'"]) {
    assert.equal(scanEnvText(`JWT_KMS_CREDENTIAL_CHECK_SKIP=${val}`).length, 1, val);
  }
});

test("flags every guarded key", () => {
  for (const key of Object.keys(FORBIDDEN_PROD_ENV_KEYS)) {
    const v = scanEnvText(`${key}=1`);
    assert.equal(v.length, 1, key);
    assert.equal(v[0].key, key);
  }
});

test("does NOT flag commented documentation mentions", () => {
  const text = [
    "# JWT_KMS_CREDENTIAL_CHECK_SKIP=1 is an emergency hatch — never ship it enabled",
    "#JWT_KMS_CREDENTIAL_CHECK_SKIP=1",
    "  # AUTH_ALLOW_PERMISSIVE_BROKERING=1 overrides the guard for local dev",
  ].join("\n");
  assert.deepEqual(scanEnvText(text), []);
});

test("does NOT flag explicit disables or empty values", () => {
  const text = "JWT_KMS_CREDENTIAL_CHECK_SKIP=0\nAUTH_ALLOW_PERMISSIVE_BROKERING=false\nJWT_KMS_CREDENTIAL_CHECK_SKIP_ACK_PRODUCTION=\n";
  assert.deepEqual(scanEnvText(text), []);
});

test("does NOT flag unrelated keys, and matches keys exactly (no substring)", () => {
  const text = "SIGNER_BACKEND=kms\nMY_JWT_KMS_CREDENTIAL_CHECK_SKIP=1\nJWT_KMS_CREDENTIAL_CHECK_SKIP_EXTRA=1\n";
  assert.deepEqual(scanEnvText(text), []);
});

test("catches an enabled flag on an indented (non-comment) line", () => {
  assert.equal(scanEnvText("  JWT_KMS_CREDENTIAL_CHECK_SKIP=1").length, 1);
});

test("reports multiple violations across a file", () => {
  const v = scanEnvText("JWT_KMS_CREDENTIAL_CHECK_SKIP=1\nAUTH_ALLOW_PERMISSIVE_BROKERING=1\n");
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => x.key).sort(), ["AUTH_ALLOW_PERMISSIVE_BROKERING", "JWT_KMS_CREDENTIAL_CHECK_SKIP"]);
});

// --- regression: the real committed env artifacts are clean -----------------

test("the committed env templates + mainnet example carry NO enabled bypass flag", () => {
  let scanned = 0;
  for (const rel of DEFAULT_TARGETS) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue; // mainnet templates may not exist on this branch
    scanned++;
    assert.deepEqual(scanEnvText(readFileSync(abs, "utf8"), rel), [], `${rel} must have no enabled bypass flag`);
  }
  assert.ok(scanned > 0, "expected at least one committed env artifact to scan");
});
