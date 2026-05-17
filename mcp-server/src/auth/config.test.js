import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePublicKeyPem } from "./config.js";
import { ConfigError } from "../core/errors.js";

// A minimal PEM-shaped string for tests. We don't need a real P-256
// key here — resolvePublicKeyPem only checks for BEGIN/END markers; the
// actual SPKI parse happens later in KmsJwtSigner and is exercised by
// kms-jwt-signer.test.js with real test keys.
const SAMPLE_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy==",
  "-----END PUBLIC KEY-----",
].join("\n");

const SAMPLE_PEM_BASE64 = Buffer.from(SAMPLE_PEM, "utf8").toString("base64");

test("resolvePublicKeyPem: returns null when neither env var is set", () => {
  assert.equal(resolvePublicKeyPem({}), null);
  assert.equal(
    resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM: "", JWT_PUBLIC_KEY_PEM_BASE64: "" }),
    null,
  );
  assert.equal(
    resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM: "   ", JWT_PUBLIC_KEY_PEM_BASE64: "  " }),
    null,
  );
});

test("resolvePublicKeyPem: returns the raw PEM when JWT_PUBLIC_KEY_PEM is set", () => {
  const pem = resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM: SAMPLE_PEM });
  assert.equal(pem, SAMPLE_PEM);
});

test("resolvePublicKeyPem: decodes JWT_PUBLIC_KEY_PEM_BASE64 when only base64 is set", () => {
  const pem = resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM_BASE64: SAMPLE_PEM_BASE64 });
  assert.equal(pem, SAMPLE_PEM);
  assert.ok(pem.includes("BEGIN PUBLIC KEY"));
  assert.ok(pem.includes("END PUBLIC KEY"));
});

test("resolvePublicKeyPem: tolerates surrounding whitespace in the base64 input", () => {
  const padded = `\n  ${SAMPLE_PEM_BASE64}\n  `;
  const pem = resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM_BASE64: padded });
  assert.equal(pem, SAMPLE_PEM);
});

test("resolvePublicKeyPem: explicit PEM wins when both are set (operator override)", () => {
  // Construct a DISTINCT second PEM so we can tell which one was returned.
  const overridePem = SAMPLE_PEM.replace("xxxxxxxx", "ZZZZZZZZ");
  const pem = resolvePublicKeyPem({
    JWT_PUBLIC_KEY_PEM: overridePem,
    JWT_PUBLIC_KEY_PEM_BASE64: SAMPLE_PEM_BASE64,
  });
  assert.equal(pem, overridePem);
});

test("resolvePublicKeyPem: rejects decoded bytes that don't contain BEGIN/END markers", () => {
  // base64 of "this is not a pem" — round-trips cleanly but won't carry markers.
  const notPemBase64 = Buffer.from("this is not a pem", "utf8").toString("base64");
  assert.throws(
    () => resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM_BASE64: notPemBase64 }),
    /BEGIN\/END markers/,
  );
});

test("resolvePublicKeyPem: rejects decoded bytes missing the END marker", () => {
  const truncated = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n";
  const truncatedB64 = Buffer.from(truncated, "utf8").toString("base64");
  assert.throws(
    () => resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM_BASE64: truncatedB64 }),
    /BEGIN\/END markers/,
  );
});

test("resolvePublicKeyPem: rejects non-string env values gracefully", () => {
  // Object / number / boolean — none should be accepted; they fall through
  // to the "neither set" path and return null.
  assert.equal(resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM: 42 }), null);
  assert.equal(resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM_BASE64: true }), null);
  assert.equal(resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM_BASE64: {} }), null);
});

test("resolvePublicKeyPem: surfaces a ConfigError (not a generic Error) on bad base64 contents", () => {
  // The "bad PEM content" path explicitly throws ConfigError so loadAuthConfig
  // can use the normal config-error reporting flow.
  try {
    resolvePublicKeyPem({ JWT_PUBLIC_KEY_PEM_BASE64: Buffer.from("nope", "utf8").toString("base64") });
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err?.constructor?.name}`);
  }
});
