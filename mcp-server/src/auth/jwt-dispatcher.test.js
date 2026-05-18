// Tests for the Phase 4b (PR 4b.4) JWT dispatcher in jwt.js.
//
// The dispatcher routes sign/verify operations between the existing
// HMAC code path and the new KmsJwtSigner based on
// authConfig.jwtBackend ∈ {"hmac", "kms", "both"}. Default = "hmac",
// which must be byte-for-byte equivalent to the pre-4b API; that
// invariant is covered by auth.test.js (existing) — these tests add
// the dispatcher-specific cases.
//
// Strategy mirrors kms-jwt-signer.test.js: a FakeKMSClient backed by a
// real Node-generated P-256 keypair, and @noble/curves' p256 in
// prehash:false mode for the actual ECDSA signature (Node's
// crypto.sign over EC keys re-hashes, which doesn't match KMS's
// MessageType=DIGEST semantics).

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { p256 } from "@noble/curves/nist.js";

import { loadAuthConfig } from "./config.js";
import {
  signToken,
  signTokenFromConfig,
  verifyTokenFromConfig,
} from "./jwt.js";
import { createAuthMiddleware } from "./middleware.js";
import { ConfigError, AuthenticationError } from "../core/errors.js";

// ───────────────────────────────────────────────────────────────────
// Test fixtures — one P-256 keypair shared by all KMS-mode tests.
// ───────────────────────────────────────────────────────────────────

function extractRawPrivateScalar(nodePrivateKey) {
  const jwk = nodePrivateKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
    throw new Error("expected a P-256 EC private key with a d field");
  }
  return new Uint8Array(Buffer.from(jwk.d, "base64url"));
}

const { privateKey: KMS_PRIVATE_KEY, publicKey: KMS_PUBLIC_KEY } = generateKeyPairSync(
  "ec",
  { namedCurve: "prime256v1" },
);
const KMS_PUBLIC_PEM = KMS_PUBLIC_KEY.export({ type: "spki", format: "pem" });
const KMS_RAW_PRIVATE = extractRawPrivateScalar(KMS_PRIVATE_KEY);

const KEY_ARN = "arn:aws:kms:eu-central-2:079209845430:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const KID = "jwt-1";
const ISSUER = "averray-backend-testnet";
const AUDIENCE = "averray-backend";
const SUBJECT = "0x000000000000000000000000000000000000abcd";
const ROLES = ["admin", "verifier"];
const HMAC_SECRET = "h".repeat(48);
const LONG_HMAC_SECRET = "L".repeat(48);

class FakeKMSClient {
  constructor() {
    this.calls = [];
  }
  async send(command) {
    this.calls.push(command);
    const name = command.constructor.name;
    if (name === "GetPublicKeyCommand") {
      const KMS_SPKI_DER = new Uint8Array(
        KMS_PUBLIC_KEY.export({ type: "spki", format: "der" }),
      );
      return { PublicKey: KMS_SPKI_DER, KeyId: command.input.KeyId };
    }
    if (name === "SignCommand") {
      const digest = new Uint8Array(command.input.Message);
      const der = p256.sign(digest, KMS_RAW_PRIVATE, {
        prehash: false,
        format: "der",
        lowS: false,
      });
      return { Signature: der };
    }
    throw new Error(`FakeKMSClient: unknown command ${name}`);
  }
}

function silentLogger() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

/**
 * Build an authConfig literal of the shape loadAuthConfig() returns —
 * lets each test customize backend / primaryAlg / kmsJwt without
 * threading a whole real config through process.env.
 */
function buildAuthConfig({
  jwtBackend = "hmac",
  jwtPrimaryAlg = "hmac",
  secrets = [HMAC_SECRET],
  withKms = false,
  kmsClient,
} = {}) {
  const config = {
    mode: "strict",
    permissive: false,
    strict: true,
    secrets,
    signingSecret: secrets[0],
    domain: "localhost",
    chainId: 0,
    tokenTtlSeconds: 900,
    nonceTtlSeconds: 300,
    adminWallets: new Set(),
    verifierWallets: new Set(),
    jwtBackend,
    jwtPrimaryAlg,
    kmsJwt: null,
  };
  if (withKms) {
    config.kmsJwt = {
      region: "eu-central-2",
      keyId: KEY_ARN,
      kid: KID,
      publicKeyPem: KMS_PUBLIC_PEM,
      publicKeyFingerprint: "deadbeef",
      expectedIssuer: ISSUER,
      expectedAudience: AUDIENCE,
      expectedRoles: ROLES,
      maxTtlSeconds: 3600,
      clockSkewSeconds: 60,
      // FakeKMSClient is injected into the signer via the dispatcher's
      // KmsJwtSigner construction path. Each call to buildAuthConfig
      // creates a fresh kmsJwt object so the dispatcher's WeakMap
      // signer cache also stays fresh per test.
      kmsClient: kmsClient ?? new FakeKMSClient(),
    };
  }
  return config;
}

function b64uEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function b64uDecode(input) {
  return Buffer.from(input, "base64url");
}

// ───────────────────────────────────────────────────────────────────
// 1. HMAC mode — default behavior preserved
// ───────────────────────────────────────────────────────────────────

test("dispatcher hmac: signTokenFromConfig produces HS256", async () => {
  const cfg = buildAuthConfig({ jwtBackend: "hmac" });
  const { token, claims } = await signTokenFromConfig(
    { sub: SUBJECT },
    { expiresInSeconds: 60 },
    cfg,
  );
  const [headerB64] = token.split(".");
  const header = JSON.parse(b64uDecode(headerB64).toString("utf8"));
  assert.equal(header.alg, "HS256");
  assert.equal(header.typ, "JWT");
  assert.equal(claims.sub, SUBJECT);
});

test("dispatcher hmac: verifyTokenFromConfig accepts HS256", async () => {
  const cfg = buildAuthConfig({ jwtBackend: "hmac" });
  const { token } = signToken(
    { sub: SUBJECT },
    { secret: HMAC_SECRET, expiresInSeconds: 60 },
  );
  const claims = await verifyTokenFromConfig(token, cfg);
  assert.equal(claims.sub, SUBJECT);
});

test("dispatcher hmac: verifyTokenFromConfig rejects ES256 with clear error", async () => {
  // Mint an ES256 token using a KMS-mode signer, then try to verify
  // under JWT_BACKEND=hmac. The dispatcher must reject before the
  // KMS signer is even constructed.
  const kmsCfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const { token: es256Token } = await signTokenFromConfig(
    { sub: SUBJECT },
    { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, role: "admin", expiresInSeconds: 60 },
    kmsCfg,
  );
  const hmacCfg = buildAuthConfig({ jwtBackend: "hmac" });
  await assert.rejects(
    () => verifyTokenFromConfig(es256Token, hmacCfg),
    (err) => {
      assert.ok(err instanceof AuthenticationError);
      assert.equal(err.code, "unsupported_alg");
      assert.match(err.message, /ES256.*hmac/u);
      return true;
    },
  );
});

test("dispatcher hmac: alg:none token is rejected", async () => {
  const cfg = buildAuthConfig({ jwtBackend: "hmac" });
  const header = b64uEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  const claims = b64uEncode(JSON.stringify({ sub: SUBJECT, iat: 0, exp: 9_999_999_999 }));
  const token = `${header}.${claims}.`;
  await assert.rejects(
    () => verifyTokenFromConfig(token, cfg),
    (err) => err instanceof AuthenticationError && err.code === "unsupported_alg",
  );
});

test("dispatcher hmac: alg:None / NONE mixed-case rejected at dispatcher", async () => {
  const cfg = buildAuthConfig({ jwtBackend: "hmac" });
  for (const badAlg of ["None", "NONE"]) {
    const header = b64uEncode(JSON.stringify({ alg: badAlg, typ: "JWT" }));
    const claims = b64uEncode(JSON.stringify({ sub: SUBJECT, iat: 0, exp: 9_999_999_999 }));
    const token = `${header}.${claims}.deadbeef`;
    await assert.rejects(
      () => verifyTokenFromConfig(token, cfg),
      (err) => err instanceof AuthenticationError && err.code === "unsupported_alg",
      `should reject alg=${badAlg}`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────
// 2. KMS mode
// ───────────────────────────────────────────────────────────────────

test("dispatcher kms: signTokenFromConfig produces ES256", async () => {
  const cfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const { token, claims } = await signTokenFromConfig(
    {},
    { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, role: "admin", expiresInSeconds: 60 },
    cfg,
  );
  const [headerB64] = token.split(".");
  const header = JSON.parse(b64uDecode(headerB64).toString("utf8"));
  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "averray-auth+jwt");
  assert.equal(header.kid, KID);
  assert.equal(claims.sub, SUBJECT);
  assert.equal(claims.role, "admin");
});

test("dispatcher kms: verifyTokenFromConfig accepts ES256", async () => {
  const cfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const { token } = await signTokenFromConfig(
    {},
    { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, role: "admin", expiresInSeconds: 60 },
    cfg,
  );
  const claims = await verifyTokenFromConfig(token, cfg);
  assert.equal(claims.sub, SUBJECT);
  assert.equal(claims.role, "admin");
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.aud, AUDIENCE);
  // Normalization: ES256 emits singular `role` per design doc §6 but
  // downstream auth code (capabilities, hasRole) reads plural `roles`.
  // The dispatcher bridges the two so middleware/handler code is
  // algorithm-agnostic.
  assert.deepEqual(claims.roles, ["admin"]);
});

test("dispatcher kms: verifyTokenFromConfig normalizes role → roles for verifier role", async () => {
  // Same path as above but with a different role value — proves the
  // normalization isn't hardcoded to "admin".
  const cfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const { token } = await signTokenFromConfig(
    {},
    { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, role: "verifier", expiresInSeconds: 60 },
    cfg,
  );
  const claims = await verifyTokenFromConfig(token, cfg);
  assert.equal(claims.role, "verifier");
  assert.deepEqual(claims.roles, ["verifier"]);
});

test("dispatcher kms: verifyTokenFromConfig preserves an existing claims.roles array (does not overwrite)", async () => {
  // Defense-in-depth: if a future ES256 variant carries a `roles`
  // array alongside `role`, the dispatcher must NOT overwrite the
  // explicit roles array with `[role]`. Mint with both.
  const cfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  // Use signAsync directly to inject an extra claim (roles) that the
  // dispatcher's signTokenFromConfig strips by default.
  const signer = await (async () => {
    const { KmsJwtSigner } = await import("./kms-jwt-signer.js");
    return new KmsJwtSigner({
      kmsClient: cfg.kmsJwt.kmsClient,
      region: cfg.kmsJwt.region,
      keyId: cfg.kmsJwt.keyId,
      kid: cfg.kmsJwt.kid,
      publicKeyPem: cfg.kmsJwt.publicKeyPem,
      expectedIssuer: cfg.kmsJwt.expectedIssuer,
      expectedAudience: cfg.kmsJwt.expectedAudience,
      expectedRoles: ["admin", "verifier"],
      maxTtlSeconds: cfg.kmsJwt.maxTtlSeconds,
    });
  })();
  const token = await signer.signAsync(
    { roles: ["admin", "verifier"] },
    { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, role: "admin", expiresInSeconds: 60 },
  );
  const claims = await verifyTokenFromConfig(token, cfg);
  assert.equal(claims.role, "admin");
  // The explicit roles array is preserved as-is — NOT replaced by [claims.role].
  assert.deepEqual(claims.roles, ["admin", "verifier"]);
});

test("dispatcher kms: verifyTokenFromConfig rejects HS256 with clear error", async () => {
  const cfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const { token: hs256Token } = signToken(
    { sub: SUBJECT },
    { secret: HMAC_SECRET, expiresInSeconds: 60 },
  );
  await assert.rejects(
    () => verifyTokenFromConfig(hs256Token, cfg),
    (err) => {
      assert.ok(err instanceof AuthenticationError);
      assert.equal(err.code, "unsupported_alg");
      assert.match(err.message, /HS256.*kms/u);
      return true;
    },
  );
});

test("dispatcher kms: alg:none token is rejected", async () => {
  const cfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const header = b64uEncode(JSON.stringify({ alg: "none", typ: "averray-auth+jwt", kid: KID }));
  const claims = b64uEncode(JSON.stringify({ sub: SUBJECT, iat: 0, exp: 9_999_999_999 }));
  const token = `${header}.${claims}.`;
  await assert.rejects(
    () => verifyTokenFromConfig(token, cfg),
    (err) => err instanceof AuthenticationError && err.code === "unsupported_alg",
  );
});

// ───────────────────────────────────────────────────────────────────
// 3. Both mode
// ───────────────────────────────────────────────────────────────────

test("dispatcher both: primaryAlg=hmac signs HS256 and verifies both algs", async () => {
  const cfg = buildAuthConfig({
    jwtBackend: "both",
    jwtPrimaryAlg: "hmac",
    withKms: true,
  });
  // Sign defaults to HMAC under primaryAlg=hmac.
  const { token: hmacToken } = await signTokenFromConfig(
    { sub: SUBJECT },
    { expiresInSeconds: 60 },
    cfg,
  );
  const [hmacHeaderB64] = hmacToken.split(".");
  const hmacHeader = JSON.parse(b64uDecode(hmacHeaderB64).toString("utf8"));
  assert.equal(hmacHeader.alg, "HS256");

  // Verify a separately-signed ES256 token under the same authConfig.
  const kmsOnlyCfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const { token: es256Token } = await signTokenFromConfig(
    {},
    { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, role: "admin", expiresInSeconds: 60 },
    kmsOnlyCfg,
  );

  // both-mode config accepts both — same config object holds the KMS
  // verification material AND the HMAC secrets list.
  const hmacClaims = await verifyTokenFromConfig(hmacToken, cfg);
  assert.equal(hmacClaims.sub, SUBJECT);
  // For the ES256 token to verify against `cfg`, the kmsJwt must be
  // configured against the *same* keypair we used to sign — buildAuthConfig
  // generates the keypair once at module load, so this holds.
  const es256Claims = await verifyTokenFromConfig(es256Token, cfg);
  assert.equal(es256Claims.sub, SUBJECT);
  assert.equal(es256Claims.role, "admin");
});

test("dispatcher both: primaryAlg=kms signs ES256 and verifies both algs", async () => {
  const cfg = buildAuthConfig({
    jwtBackend: "both",
    jwtPrimaryAlg: "kms",
    withKms: true,
  });
  const { token: es256Token } = await signTokenFromConfig(
    { sub: SUBJECT },
    {
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: SUBJECT,
      role: "admin",
      expiresInSeconds: 60,
    },
    cfg,
  );
  const [es256HeaderB64] = es256Token.split(".");
  const es256Header = JSON.parse(b64uDecode(es256HeaderB64).toString("utf8"));
  assert.equal(es256Header.alg, "ES256");

  // Existing HMAC tokens still verify.
  const { token: hmacToken } = signToken(
    { sub: SUBJECT },
    { secret: HMAC_SECRET, expiresInSeconds: 60 },
  );
  const hmacClaims = await verifyTokenFromConfig(hmacToken, cfg);
  assert.equal(hmacClaims.sub, SUBJECT);
  const es256Claims = await verifyTokenFromConfig(es256Token, cfg);
  assert.equal(es256Claims.sub, SUBJECT);
});

test("dispatcher both: HS256 token routes to HMAC path (not KMS)", async () => {
  const cfg = buildAuthConfig({
    jwtBackend: "both",
    jwtPrimaryAlg: "hmac",
    withKms: true,
  });
  // Sign HS256 against a secret that is in the rotation list. Verify
  // succeeds, which proves the HMAC path was used (KMS verification
  // could not possibly accept an HS256 token).
  const { token } = signToken(
    { sub: SUBJECT },
    { secret: HMAC_SECRET, expiresInSeconds: 60 },
  );
  const claims = await verifyTokenFromConfig(token, cfg);
  assert.equal(claims.sub, SUBJECT);
});

test("dispatcher both: ES256 token routes to KMS path (not HMAC)", async () => {
  const cfg = buildAuthConfig({
    jwtBackend: "both",
    jwtPrimaryAlg: "hmac",
    withKms: true,
  });
  const kmsOnlyCfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const { token } = await signTokenFromConfig(
    {},
    { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, role: "admin", expiresInSeconds: 60 },
    kmsOnlyCfg,
  );
  // Verify against the `both` config — only the KMS path can produce
  // a match because HMAC has no concept of ES256 signatures.
  const claims = await verifyTokenFromConfig(token, cfg);
  assert.equal(claims.sub, SUBJECT);
  assert.equal(claims.role, "admin");
});

test("dispatcher both: alg:none still rejected", async () => {
  const cfg = buildAuthConfig({
    jwtBackend: "both",
    jwtPrimaryAlg: "hmac",
    withKms: true,
  });
  const header = b64uEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  const claims = b64uEncode(JSON.stringify({ sub: SUBJECT, iat: 0, exp: 9_999_999_999 }));
  const token = `${header}.${claims}.`;
  await assert.rejects(
    () => verifyTokenFromConfig(token, cfg),
    (err) => err instanceof AuthenticationError && err.code === "unsupported_alg",
  );
});

test("dispatcher both: algorithm-confusion — HS256 token with KMS public key as HMAC secret is rejected", async () => {
  // RFC 8725 §3.1: an attacker who controls the JWT public key (it's
  // public, after all) might try to forge an HS256 token using the
  // public-key bytes as the HMAC secret, hoping a naive verifier
  // routes by alg and uses whatever key material happens to be
  // configured. Our dispatcher routes HS256 → HMAC verify and HMAC
  // verify uses ONLY the configured AUTH_JWT_SECRETS, not the public
  // key. This test asserts that: build a forged HS256 token whose
  // signature is computed with the PEM bytes as the secret, then
  // verify — expect rejection because the HMAC backend's secrets
  // list does NOT contain the public PEM.
  const cfg = buildAuthConfig({
    jwtBackend: "both",
    jwtPrimaryAlg: "hmac",
    secrets: [HMAC_SECRET], // explicitly NOT the public PEM
    withKms: true,
  });
  // Forge an HS256 token signed with the JWT public key (PEM bytes)
  // as the "secret". Replicate the existing jwt.js sign() routine
  // exactly so the signature is valid for that key.
  const { createHmac } = await import("node:crypto");
  const headerB64 = b64uEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = { sub: SUBJECT, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 };
  const payloadB64 = b64uEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = createHmac("sha256", KMS_PUBLIC_PEM).update(signingInput).digest("base64url");
  const forged = `${signingInput}.${sig}`;

  await assert.rejects(
    () => verifyTokenFromConfig(forged, cfg),
    (err) => err instanceof AuthenticationError && err.code === "bad_signature",
    "HS256 forged with public key as secret must fail under HMAC verify",
  );
});

// ───────────────────────────────────────────────────────────────────
// 4. Config validation
// ───────────────────────────────────────────────────────────────────

test("config: JWT_BACKEND=invalid throws ConfigError at boot", () => {
  assert.throws(
    () =>
      loadAuthConfig({
        AUTH_MODE: "strict",
        AUTH_JWT_SECRETS: LONG_HMAC_SECRET,
        JWT_BACKEND: "asymmetric", // not a valid value
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /JWT_BACKEND/u);
      assert.match(err.message, /hmac.*kms.*both|hmac.*both.*kms/u);
      return true;
    },
  );
});

test("config: JWT_BACKEND=kms with missing AWS_JWT_KEY_ID throws ConfigError listing the missing var", () => {
  assert.throws(
    () =>
      loadAuthConfig({
        AUTH_MODE: "strict",
        AUTH_JWT_SECRETS: LONG_HMAC_SECRET,
        JWT_BACKEND: "kms",
        AWS_JWT_REGION: "eu-central-2",
        // AWS_JWT_KEY_ID intentionally missing
        JWT_PUBLIC_KEY_PEM: KMS_PUBLIC_PEM,
        JWT_PUBLIC_KEY_FINGERPRINT: "deadbeef",
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /AWS_JWT_KEY_ID/u);
      return true;
    },
  );
});

test("config: JWT_BACKEND=both with multiple missing KMS vars lists them all", () => {
  assert.throws(
    () =>
      loadAuthConfig({
        AUTH_MODE: "strict",
        AUTH_JWT_SECRETS: LONG_HMAC_SECRET,
        JWT_BACKEND: "both",
        // All four required vars missing
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /AWS_JWT_REGION/u);
      assert.match(err.message, /AWS_JWT_KEY_ID/u);
      assert.match(err.message, /JWT_PUBLIC_KEY_PEM/u);
      assert.match(err.message, /JWT_PUBLIC_KEY_FINGERPRINT/u);
      return true;
    },
  );
});

test("config: JWT_BACKEND=hmac (default) with KMS vars present does not throw", () => {
  const config = loadAuthConfig({
    AUTH_MODE: "strict",
    AUTH_JWT_SECRETS: LONG_HMAC_SECRET,
    // No JWT_BACKEND → default "hmac"
    // KMS-required vars intentionally absent.
  });
  assert.equal(config.jwtBackend, "hmac");
  assert.equal(config.kmsJwt, null);
});

test("config: JWT_BACKEND=hmac with KMS vars present is ignored (no throw, kmsJwt null)", () => {
  const config = loadAuthConfig({
    AUTH_MODE: "strict",
    AUTH_JWT_SECRETS: LONG_HMAC_SECRET,
    JWT_BACKEND: "hmac",
    AWS_JWT_REGION: "eu-central-2",
    AWS_JWT_KEY_ID: KEY_ARN,
    JWT_PUBLIC_KEY_PEM: KMS_PUBLIC_PEM,
    JWT_PUBLIC_KEY_FINGERPRINT: "deadbeef",
  });
  assert.equal(config.jwtBackend, "hmac");
  assert.equal(config.kmsJwt, null);
});

test("config: JWT_BACKEND=kms with all required vars populates kmsJwt with defaults", () => {
  const config = loadAuthConfig({
    AUTH_MODE: "strict",
    AUTH_JWT_SECRETS: LONG_HMAC_SECRET,
    JWT_BACKEND: "kms",
    AWS_JWT_REGION: "eu-central-2",
    AWS_JWT_KEY_ID: KEY_ARN,
    JWT_PUBLIC_KEY_PEM: KMS_PUBLIC_PEM,
    JWT_PUBLIC_KEY_FINGERPRINT: "deadbeef",
  });
  assert.equal(config.jwtBackend, "kms");
  assert.equal(config.jwtPrimaryAlg, "kms");
  assert.ok(config.kmsJwt);
  assert.equal(config.kmsJwt.region, "eu-central-2");
  assert.equal(config.kmsJwt.keyId, KEY_ARN);
  assert.equal(config.kmsJwt.kid, "jwt-1"); // default
  assert.equal(config.kmsJwt.expectedIssuer, "averray-backend-testnet"); // default
  assert.equal(config.kmsJwt.expectedAudience, "averray-backend"); // default
});

test("config: JWT_BACKEND=kms with AWS_JWT_KEY_ID as alias is rejected at boot", () => {
  assert.throws(
    () =>
      loadAuthConfig({
        AUTH_MODE: "strict",
        AUTH_JWT_SECRETS: LONG_HMAC_SECRET,
        JWT_BACKEND: "kms",
        AWS_JWT_REGION: "eu-central-2",
        AWS_JWT_KEY_ID: "alias/averray-jwt-signer-testnet",
        JWT_PUBLIC_KEY_PEM: KMS_PUBLIC_PEM,
        JWT_PUBLIC_KEY_FINGERPRINT: "deadbeef",
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /alias/u);
      return true;
    },
  );
});

test("config: JWT_PRIMARY_ALG=invalid is rejected", () => {
  assert.throws(
    () =>
      loadAuthConfig({
        AUTH_MODE: "strict",
        AUTH_JWT_SECRETS: LONG_HMAC_SECRET,
        JWT_BACKEND: "both",
        JWT_PRIMARY_ALG: "rs256",
        AWS_JWT_REGION: "eu-central-2",
        AWS_JWT_KEY_ID: KEY_ARN,
        JWT_PUBLIC_KEY_PEM: KMS_PUBLIC_PEM,
        JWT_PUBLIC_KEY_FINGERPRINT: "deadbeef",
      }),
    (err) => err instanceof ConfigError && /JWT_PRIMARY_ALG/u.test(err.message),
  );
});

// ───────────────────────────────────────────────────────────────────
// 5. Middleware integration — JWT_BACKEND=both authenticates both
// ───────────────────────────────────────────────────────────────────

test("middleware integration: JWT_BACKEND=both authenticates both HS256 and ES256 tokens", async () => {
  const cfg = buildAuthConfig({
    jwtBackend: "both",
    jwtPrimaryAlg: "hmac",
    withKms: true,
  });
  const middleware = createAuthMiddleware({ authConfig: cfg, logger: silentLogger() });

  // HS256 token via legacy signToken.
  const { token: hmacToken } = signToken(
    { sub: SUBJECT },
    { secret: HMAC_SECRET, expiresInSeconds: 60 },
  );
  const hmacReq = { method: "GET", headers: { authorization: `Bearer ${hmacToken}` } };
  const hmacResult = await middleware(hmacReq, new URL("http://localhost/api/account"));
  assert.equal(hmacResult.wallet.toLowerCase(), SUBJECT.toLowerCase());

  // ES256 token via the dispatcher's ES256 path.
  const kmsOnlyCfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const { token: es256Token } = await signTokenFromConfig(
    {},
    { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, role: "admin", expiresInSeconds: 60 },
    kmsOnlyCfg,
  );
  const es256Req = { method: "GET", headers: { authorization: `Bearer ${es256Token}` } };
  const es256Result = await middleware(es256Req, new URL("http://localhost/api/account"));
  assert.equal(es256Result.wallet.toLowerCase(), SUBJECT.toLowerCase());
});

test("middleware integration: JWT_BACKEND=hmac (default) rejects ES256 with AuthenticationError", async () => {
  const hmacCfg = buildAuthConfig({ jwtBackend: "hmac" });
  const middleware = createAuthMiddleware({ authConfig: hmacCfg, logger: silentLogger() });

  // Mint an ES256 token under a separate kms-mode config.
  const kmsCfg = buildAuthConfig({ jwtBackend: "kms", withKms: true });
  const { token } = await signTokenFromConfig(
    {},
    { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, role: "admin", expiresInSeconds: 60 },
    kmsCfg,
  );

  const request = { method: "GET", headers: { authorization: `Bearer ${token}` } };
  await assert.rejects(
    () => middleware(request, new URL("http://localhost/api/account")),
    (err) => {
      assert.ok(err instanceof AuthenticationError);
      assert.equal(err.code, "unsupported_alg");
      return true;
    },
  );
});
