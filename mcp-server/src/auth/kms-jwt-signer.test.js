// Unit tests for kms-jwt-signer.js.
//
// Strategy: build a FakeKMSClient that holds a Node-generated P-256
// keypair internally. On GetPublicKey it returns the SPKI DER; on Sign
// it produces a real DER ECDSA signature over the supplied digest. This
// exercises the full sign + verify pipeline — base64url encoding, DER
// parsing, JWS raw conversion, public-key cross-check — without an AWS
// account, and the resulting JWT round-trips through both our verifier
// and the standalone `jose` library (cross-library conformance check
// called out in design doc §10).
//
// The FakeKMSClient is duplicated from mcp-server/src/blockchain/
// kms-signer.test.js rather than imported across `blockchain/` and
// `auth/` — keeping each test self-contained avoids awkward
// cross-package test-helper coupling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";

import * as jose from "jose";
import { p256 } from "@noble/curves/nist.js";

import { KmsJwtSigner } from "./kms-jwt-signer.js";
import { signToken as signHmacToken } from "./jwt.js";

// ───────────────────────────────────────────────────────────────────
// Fake KMS — single P-256 keypair generated at module load.
// ───────────────────────────────────────────────────────────────────

// Generate a P-256 keypair via Node's crypto so we get a stable SPKI /
// PEM for the verify path. Then extract the raw 32-byte private scalar
// (from the JWK form) for use with @noble/curves' p256 — only noble
// supports the "sign a pre-computed digest" mode that mirrors AWS KMS's
// `MessageType=DIGEST` semantics. (Node's `crypto.sign` with EC keys
// will re-hash the digest internally; `subtle.sign` also re-hashes.)
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
const KMS_SPKI_DER = new Uint8Array(KMS_PUBLIC_KEY.export({ type: "spki", format: "der" }));
const KMS_PUBLIC_PEM = KMS_PUBLIC_KEY.export({ type: "spki", format: "pem" });
const KMS_RAW_PRIVATE = extractRawPrivateScalar(KMS_PRIVATE_KEY);

// Wrong key (different P-256 keypair) — used in tests for tampered /
// cross-signing scenarios.
const { privateKey: OTHER_PRIVATE_KEY } = generateKeyPairSync(
  "ec",
  { namedCurve: "prime256v1" },
);
const OTHER_RAW_PRIVATE = extractRawPrivateScalar(OTHER_PRIVATE_KEY);

const KEY_ARN = "arn:aws:kms:eu-central-2:079209845430:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const KID = "jwt-1";
const ISSUER = "averray-backend-testnet";
const AUDIENCE = "averray-backend";
const SUBJECT = "0x000000000000000000000000000000000000abcd";
const ROLES = ["admin", "verifier"];
const TTL_SECONDS = 900; // 15 min

class FakeKMSClient {
  constructor({ failNextSign = false, signWithRawKey = KMS_RAW_PRIVATE, emptySignature = false } = {}) {
    this.calls = [];
    this.failNextSign = failNextSign;
    this.signWithRawKey = signWithRawKey;
    this.emptySignature = emptySignature;
  }
  async send(command) {
    this.calls.push(command);
    const name = command.constructor.name;
    if (name === "GetPublicKeyCommand") {
      return { PublicKey: KMS_SPKI_DER, KeyId: command.input.KeyId };
    }
    if (name === "SignCommand") {
      if (this.failNextSign) {
        this.failNextSign = false;
        const err = new Error("AccessDeniedException: simulated KMS Sign denied");
        err.name = "AccessDeniedException";
        throw err;
      }
      if (command.input.SigningAlgorithm !== "ECDSA_SHA_256") {
        const err = new Error(`AccessDeniedException: SigningAlgorithm "${command.input.SigningAlgorithm}" not allowed`);
        err.name = "AccessDeniedException";
        throw err;
      }
      if (command.input.MessageType !== "DIGEST") {
        const err = new Error(`AccessDeniedException: MessageType "${command.input.MessageType}" not allowed`);
        err.name = "AccessDeniedException";
        throw err;
      }
      if (this.emptySignature) {
        return {};
      }
      // Sign the digest. KMS in DIGEST mode treats `Message` as a
      // pre-computed SHA-256 digest — it does NOT re-hash. Node's
      // `crypto.sign(null, digest, ecKey)` and `subtle.sign` both
      // re-hash, so they're unsuitable here. `@noble/curves`'s p256
      // exposes a `{ prehash: false }` mode that matches KMS exactly:
      // it signs the raw bytes as the ECDSA integer-to-sign. The
      // resulting DER signature verifies under Node's standard
      // `createVerify("SHA256").update(message).verify(...)` path,
      // i.e. it is RFC-compliant ES256.
      const digest = new Uint8Array(command.input.Message);
      const der = p256.sign(digest, this.signWithRawKey, {
        prehash: false,
        format: "der",
        lowS: false,
      });
      return { Signature: der };
    }
    throw new Error(`FakeKMSClient: unknown command ${name}`);
  }
}

// ───────────────────────────────────────────────────────────────────
// Helpers — token (re)construction for tampering tests.
// ───────────────────────────────────────────────────────────────────

function buildSigner(overrides = {}) {
  return new KmsJwtSigner({
    kmsClient: overrides.kmsClient ?? new FakeKMSClient(),
    keyId: overrides.keyId ?? KEY_ARN,
    kid: overrides.kid ?? KID,
    publicKeyPem: overrides.publicKeyPem ?? KMS_PUBLIC_PEM,
    expectedIssuer: overrides.expectedIssuer ?? ISSUER,
    expectedAudience: overrides.expectedAudience ?? AUDIENCE,
    expectedRoles: overrides.expectedRoles ?? ROLES,
    maxTtlSeconds: overrides.maxTtlSeconds ?? 3600,
    clockSkewSeconds: overrides.clockSkewSeconds ?? 60,
    now: overrides.now,
    logger: overrides.logger,
  });
}

function defaultSignOpts() {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: SUBJECT,
    role: "admin",
    expiresInSeconds: TTL_SECONDS,
  };
}

function b64uEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function b64uDecode(input) {
  return Buffer.from(input, "base64url");
}

// Re-sign a payload + header pair, used to construct attacker-shaped
// tokens (e.g., wrong header) where we still want the signature to
// verify under the configured public key so the test isolates the
// header / claims check rather than failing on the signature step.
// Uses @noble/curves' p256 in `prehash: false` mode for the same
// reason the FakeKMSClient does (see comment there).
async function forgeTokenWithKey(header, claims, rawPrivateKey = KMS_RAW_PRIVATE) {
  const headerB64 = b64uEncode(JSON.stringify(header));
  const claimsB64 = b64uEncode(JSON.stringify(claims));
  const input = `${headerB64}.${claimsB64}`;
  const { createHash } = await import("node:crypto");
  const digest = new Uint8Array(createHash("sha256").update(input).digest());
  const derSig = p256.sign(digest, rawPrivateKey, {
    prehash: false,
    format: "der",
    lowS: false,
  });
  const { jwsRawFromDer } = await import("./jws-ecdsa.js");
  const rawSig = jwsRawFromDer(derSig);
  return `${input}.${b64uEncode(rawSig)}`;
}

function makeClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: SUBJECT,
    role: "admin",
    iat: now,
    nbf: now,
    exp: now + TTL_SECONDS,
    jti: randomUUID(),
    ...overrides,
  };
}

function makeHeader(overrides = {}) {
  return {
    alg: "ES256",
    typ: "averray-auth+jwt",
    kid: KID,
    ...overrides,
  };
}

function collectingLogger() {
  const records = [];
  return {
    records,
    info(fields, message) {
      records.push({ level: "info", fields, message });
    },
    warn(fields, message) {
      records.push({ level: "warn", fields, message });
    },
  };
}

// ───────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────

test("KmsJwtSigner: sign + verify happy-path round-trip", async () => {
  const signer = buildSigner();
  const token = await signer.signAsync({}, defaultSignOpts());
  const claims = signer.verify(token);
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.aud, AUDIENCE);
  assert.equal(claims.sub, SUBJECT);
  // Stage 2B canonical shape: emitted as `roles` array, not singular `role`.
  assert.deepEqual(claims.roles, ["admin"]);
  assert.equal(claims.role, undefined);
  assert.equal(typeof claims.iat, "number");
  assert.equal(typeof claims.nbf, "number");
  assert.equal(typeof claims.exp, "number");
  assert.equal(claims.exp - claims.iat, TTL_SECONDS);
  assert.match(claims.jti, /^[0-9a-f-]{36}$/u);
});

test("KmsJwtSigner: signAsync emits a structured kms:Sign duration log", async () => {
  const logger = collectingLogger();
  const signer = buildSigner({ logger });
  await signer.signAsync({}, defaultSignOpts());

  const record = logger.records.find((entry) => entry.message === "kms.sign.duration");
  assert.ok(record, "expected kms.sign.duration log record");
  assert.equal(record.level, "info");
  assert.equal(record.fields.event, "kms.sign.duration");
  assert.equal(record.fields.signer, "jwt");
  assert.equal(record.fields.operation, "kms:Sign");
  assert.equal(record.fields.keyId, KEY_ARN);
  assert.equal(record.fields.kid, KID);
  assert.equal(record.fields.messageType, "DIGEST");
  assert.equal(record.fields.signingAlgorithm, "ECDSA_SHA_256");
  assert.equal(record.fields.success, true);
  assert.equal(typeof record.fields.durationMs, "number");
  assert.ok(record.fields.durationMs >= 0);
});

test("KmsJwtSigner: signAsync accepts multi-role array and emits canonical roles claim", async () => {
  const signer = buildSigner({ expectedRoles: ["admin", "verifier"] });
  const token = await signer.signAsync(
    {},
    {
      ...defaultSignOpts(),
      role: ["admin", "verifier"],
    },
  );
  const claims = signer.verify(token);
  assert.deepEqual(claims.roles, ["admin", "verifier"]);
});

test("KmsJwtSigner: signAsync with an empty role array mints a roleless token (roles: [])", async () => {
  // Roleless ordinary-worker wallet — the common case for external
  // agents. An empty role array is no longer an error; it mints a token
  // carrying `roles: []`, which round-trips through verify.
  const signer = buildSigner();
  const token = await signer.signAsync({}, { ...defaultSignOpts(), role: [] });
  const claims = signer.verify(token);
  assert.deepEqual(claims.roles, []);
  assert.equal(claims.role, undefined);
  assert.equal(claims.sub, SUBJECT);
});

test("KmsJwtSigner: signAsync with no role at all mints a roleless token that verifies", async () => {
  // Mirrors the dispatcher path where opts.role is undefined for a
  // roleless wallet. signAsync must NOT throw and must emit roles: [].
  const signer = buildSigner();
  const { role: _role, ...optsWithoutRole } = defaultSignOpts();
  const token = await signer.signAsync({}, optsWithoutRole);
  const claims = signer.verify(token);
  assert.deepEqual(claims.roles, []);
});

test("KmsJwtSigner: verify accepts a roleless token even with a non-empty expectedRoles allowlist", async () => {
  // The verifier-side allowlist is configured (prod = VALID_ROLES), but
  // a roleless token's empty array makes the allowlist check a no-op —
  // it must still verify.
  const signer = buildSigner({ expectedRoles: ["admin", "verifier"] });
  const token = await signer.signAsync({}, { ...defaultSignOpts(), role: [] });
  const claims = signer.verify(token);
  assert.deepEqual(claims.roles, []);
});

test("KmsJwtSigner: signAsync still rejects a non-string role value", async () => {
  // Guard against regressing the validation for genuinely malformed
  // input — a number is neither a string, an array, nor "absent".
  const signer = buildSigner();
  await assert.rejects(
    () => signer.signAsync({}, { ...defaultSignOpts(), role: 42 }),
    /role must be a string, an array of strings, or absent/,
  );
});

test("KmsJwtSigner: signAsync rejects non-string entries inside role array", async () => {
  const signer = buildSigner({ expectedRoles: ["admin", "verifier"] });
  await assert.rejects(
    () => signer.signAsync({}, { ...defaultSignOpts(), role: ["admin", 42] }),
    /every entry of role must be a non-empty string/,
  );
});

test("KmsJwtSigner: verify rejects a token whose roles include an unknown value", async () => {
  // Build the signer with a permissive sign-side allowlist so we can
  // craft a multi-role token, then verify it through a stricter signer
  // (which only allows admin) — that's the realistic prod shape where
  // expectedRoles is the verifier-side allowlist.
  const permissive = buildSigner({ expectedRoles: ["admin", "verifier", "weirdo"] });
  const token = await permissive.signAsync(
    {},
    { ...defaultSignOpts(), role: ["admin", "weirdo"] },
  );
  const strict = buildSigner({ expectedRoles: ["admin", "verifier"] });
  assert.throws(
    () => strict.verify(token),
    /role "weirdo" not in allowlist/,
  );
});

test("KmsJwtSigner: legacy claims.role-only token (pre-2B emission) still verifies", async () => {
  // Backward compat — a token issued by the pre-Stage-2B signer carries
  // `role: "admin"` (singular) and no `roles` array. The Stage 2B
  // verifier must continue to accept these until they expire so we
  // don't brick any active op://prod-smoke/admin-jwt mid-cutover.
  // Hand-craft via forgeTokenWithKey (the same helper other negative
  // tests use) so we can produce a claims shape KmsJwtSigner.signAsync
  // no longer emits.
  const header = makeHeader();
  const legacyClaims = makeClaims(); // makeClaims already includes role:"admin"
  delete legacyClaims.roles; // belt-and-suspenders — make sure no `roles` snuck in
  const token = await forgeTokenWithKey(header, legacyClaims);
  const signer = buildSigner();
  const verified = signer.verify(token);
  assert.equal(verified.role, "admin");
  // Signer does NOT add `roles` array here — that normalization happens
  // in the dispatcher (jwt.js verifyEs256) which bridges role → roles
  // for downstream consumers.
  assert.equal(verified.roles, undefined);
});

test("KmsJwtSigner: cross-library verify via `jose` (RFC conformance)", async () => {
  const signer = buildSigner();
  const token = await signer.signAsync({}, defaultSignOpts());
  // jose imports our PEM, verifies signature, and returns claims.
  const pubKey = await jose.importSPKI(KMS_PUBLIC_PEM, "ES256");
  const { payload, protectedHeader } = await jose.jwtVerify(token, pubKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
    typ: "averray-auth+jwt",
  });
  assert.equal(protectedHeader.alg, "ES256");
  assert.equal(protectedHeader.typ, "averray-auth+jwt");
  assert.equal(protectedHeader.kid, KID);
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, AUDIENCE);
  assert.equal(payload.sub, SUBJECT);
});

test("KmsJwtSigner: HS256 token (from existing jwt.js) is rejected", () => {
  const signer = buildSigner();
  const secret = "a".repeat(64);
  const { token } = signHmacToken(
    { iss: ISSUER, aud: AUDIENCE, sub: SUBJECT, role: "admin" },
    { secret, expiresInSeconds: TTL_SECONDS },
  );
  assert.throws(
    () => signer.verify(token),
    /unsupported alg "HS256"/,
  );
});

test("KmsJwtSigner: alg=none token is rejected", async () => {
  const header = makeHeader({ alg: "none" });
  const claims = makeClaims();
  const headerB64 = b64uEncode(JSON.stringify(header));
  const claimsB64 = b64uEncode(JSON.stringify(claims));
  // Empty signature segment — the canonical "alg:none" attack shape.
  const token = `${headerB64}.${claimsB64}.`;
  const signer = buildSigner();
  assert.throws(() => signer.verify(token), /unsupported alg "none"/);
});

test("KmsJwtSigner: mixed-case alg values are rejected", async () => {
  const signer = buildSigner();
  for (const badAlg of ["None", "NONE", "es256", "ES384", "RS256", "HS256"]) {
    const token = await forgeTokenWithKey(makeHeader({ alg: badAlg }), makeClaims());
    assert.throws(
      () => signer.verify(token),
      new RegExp(`unsupported alg "${badAlg}"`),
      `should reject alg=${badAlg}`,
    );
  }
});

test("KmsJwtSigner: wrong typ is rejected (generic 'JWT' fails)", async () => {
  const signer = buildSigner();
  const token = await forgeTokenWithKey(makeHeader({ typ: "JWT" }), makeClaims());
  assert.throws(() => signer.verify(token), /unsupported typ "JWT"/);
});

test("KmsJwtSigner: correct typ accepted (positive control)", async () => {
  const signer = buildSigner();
  const token = await signer.signAsync({}, defaultSignOpts());
  const decoded = signer.verify(token);
  assert.equal(decoded.sub, SUBJECT);
});

test("KmsJwtSigner: wrong kid is rejected", async () => {
  const signer = buildSigner();
  const token = await forgeTokenWithKey(makeHeader({ kid: "jwt-99" }), makeClaims());
  assert.throws(() => signer.verify(token), /kid "jwt-99" not in allowlist/);
});

test("KmsJwtSigner: jku header rejected", async () => {
  const signer = buildSigner();
  const token = await forgeTokenWithKey(
    makeHeader({ jku: "https://attacker.example/keys.json" }),
    makeClaims(),
  );
  assert.throws(() => signer.verify(token), /forbidden header "jku"/);
});

test("KmsJwtSigner: jwk header rejected", async () => {
  const signer = buildSigner();
  const token = await forgeTokenWithKey(
    makeHeader({ jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" } }),
    makeClaims(),
  );
  assert.throws(() => signer.verify(token), /forbidden header "jwk"/);
});

test("KmsJwtSigner: x5u header rejected", async () => {
  const signer = buildSigner();
  const token = await forgeTokenWithKey(
    makeHeader({ x5u: "https://attacker.example/cert.pem" }),
    makeClaims(),
  );
  assert.throws(() => signer.verify(token), /forbidden header "x5u"/);
});

test("KmsJwtSigner: x5c header rejected", async () => {
  const signer = buildSigner();
  const token = await forgeTokenWithKey(
    makeHeader({ x5c: ["MIIBxx...attacker..."] }),
    makeClaims(),
  );
  assert.throws(() => signer.verify(token), /forbidden header "x5c"/);
});

test("KmsJwtSigner: crit header rejected", async () => {
  const signer = buildSigner();
  const token = await forgeTokenWithKey(
    makeHeader({ crit: ["exp"] }),
    makeClaims(),
  );
  assert.throws(() => signer.verify(token), /forbidden header "crit"/);
});

test("KmsJwtSigner: tampered signature (bit flip) is rejected", async () => {
  const signer = buildSigner();
  const token = await signer.signAsync({}, defaultSignOpts());
  const [h, c, s] = token.split(".");
  const sigBytes = b64uDecode(s);
  sigBytes[0] ^= 0x01; // flip a bit in R
  const tampered = `${h}.${c}.${b64uEncode(sigBytes)}`;
  assert.throws(() => signer.verify(tampered), /signature mismatch/);
});

test("KmsJwtSigner: tampered claims (modified sub) are rejected", async () => {
  const signer = buildSigner();
  const token = await signer.signAsync({}, defaultSignOpts());
  const [h, c, s] = token.split(".");
  const claims = JSON.parse(b64uDecode(c).toString("utf8"));
  claims.sub = "0x000000000000000000000000000000000000ffff"; // attacker rewrites sub
  const tampered = `${h}.${b64uEncode(JSON.stringify(claims))}.${s}`;
  assert.throws(() => signer.verify(tampered), /signature mismatch/);
});

test("KmsJwtSigner: expired token (exp far in the past) is rejected", async () => {
  const past = Math.floor(Date.now() / 1000) - 10_000;
  const signer = buildSigner({ now: () => past });
  const token = await signer.signAsync({}, defaultSignOpts());
  // Now jump the verifier forward in real time — token is now expired
  // way beyond clock-skew.
  const verifier = buildSigner();
  assert.throws(() => verifier.verify(token), /token expired/);
});

test("KmsJwtSigner: not-yet-valid token (nbf in the far future) is rejected", async () => {
  const future = Math.floor(Date.now() / 1000) + 10_000;
  const signer = buildSigner({ now: () => future });
  const token = await signer.signAsync({}, defaultSignOpts());
  // Verifier uses real clock — token's nbf is way beyond skew.
  const verifier = buildSigner();
  assert.throws(() => verifier.verify(token), /not yet valid/);
});

test("KmsJwtSigner: exp - iat > maxTtlSeconds is rejected", async () => {
  // Forge a token directly with an out-of-range TTL — the signer's
  // signAsync would itself reject this at construction, so we forge
  // around it to test verify-side enforcement.
  const signer = buildSigner({ maxTtlSeconds: 900 });
  const now = Math.floor(Date.now() / 1000);
  const claims = makeClaims({ iat: now, nbf: now, exp: now + 2000 });
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(
    () => signer.verify(token),
    /exp - iat \(2000\) exceeds maxTtlSeconds \(900\)/,
  );
});

test("KmsJwtSigner.signAsync: rejects expiresInSeconds > maxTtlSeconds", async () => {
  const signer = buildSigner({ maxTtlSeconds: 900 });
  await assert.rejects(
    () => signer.signAsync({}, { ...defaultSignOpts(), expiresInSeconds: 1000 }),
    /exceeds maxTtlSeconds/,
  );
});

test("KmsJwtSigner: wrong iss is rejected", async () => {
  const signer = buildSigner();
  const claims = makeClaims({ iss: "evil-backend" });
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(() => signer.verify(token), /unexpected iss "evil-backend"/);
});

test("KmsJwtSigner: wrong aud is rejected", async () => {
  const signer = buildSigner();
  const claims = makeClaims({ aud: "averray-indexer" });
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(() => signer.verify(token), /unexpected aud "averray-indexer"/);
});

test("KmsJwtSigner: missing sub is rejected", async () => {
  const signer = buildSigner();
  const claims = makeClaims();
  delete claims.sub;
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(() => signer.verify(token), /sub claim missing or empty/);
});

test("KmsJwtSigner: empty sub is rejected", async () => {
  const signer = buildSigner();
  const claims = makeClaims({ sub: "" });
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(() => signer.verify(token), /sub claim missing or empty/);
});

test("KmsJwtSigner: non-lowercase sub is rejected", async () => {
  const signer = buildSigner();
  const claims = makeClaims({ sub: "0xABCDEF0000000000000000000000000000000123" });
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(() => signer.verify(token), /sub claim must be lowercase/);
});

test("KmsJwtSigner: role not in allowlist is rejected", async () => {
  const signer = buildSigner({ expectedRoles: ["admin"] });
  const claims = makeClaims({ role: "verifier" });
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(() => signer.verify(token), /role "verifier" not in allowlist/);
});

test("KmsJwtSigner: missing jti is rejected", async () => {
  const signer = buildSigner();
  const claims = makeClaims();
  delete claims.jti;
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(() => signer.verify(token), /jti missing or not a UUIDv4/);
});

test("KmsJwtSigner: wrong-shape jti is rejected (e.g., UUIDv1)", async () => {
  const signer = buildSigner();
  // UUIDv1 has a "1" instead of "4" as the version nibble.
  const claims = makeClaims({ jti: "00000000-0000-1000-8000-000000000000" });
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(() => signer.verify(token), /jti missing or not a UUIDv4/);
});

test("KmsJwtSigner: non-string jti is rejected", async () => {
  const signer = buildSigner();
  const claims = makeClaims({ jti: 12345 });
  const token = await forgeTokenWithKey(makeHeader(), claims);
  assert.throws(() => signer.verify(token), /jti missing or not a UUIDv4/);
});

test("KmsJwtSigner: many round-trips exercise R/S padding diversity", async () => {
  // Sign many tokens — over a batch we'll hit signatures with R or S
  // requiring left-padding (natural < 32-byte values) and some with
  // the DER sign byte (high bit set). Each round-trip must succeed.
  const signer = buildSigner();
  for (let i = 0; i < 20; i++) {
    const token = await signer.signAsync(
      { iter: i },
      { ...defaultSignOpts(), subject: `0x${i.toString(16).padStart(40, "0")}` },
    );
    const claims = signer.verify(token);
    assert.equal(claims.iter, i);
  }
});

test("KmsJwtSigner: signature with high-bit-set R round-trips (DER sign byte stripped)", async () => {
  // Find a perturbation of the signed message that yields a DER R with
  // a leading 0x00 sign byte (i.e., 33-byte R, high bit set after
  // stripping). Searching the perturbation space is overwhelmingly
  // likely to hit it in a handful of tries (~50% per attempt).
  const signer = buildSigner();
  let foundHighBit = false;
  let foundLeadingZero = false;
  for (let salt = 0; salt < 50; salt++) {
    const token = await signer.signAsync(
      { salt },
      { ...defaultSignOpts(), subject: `0x${salt.toString(16).padStart(40, "0")}` },
    );
    // Re-derive what the underlying DER signature would have looked
    // like, by re-signing the same input via the fake's logic. We
    // don't need to actually inspect — the round-trip itself is the
    // test. But we also verify that across many round-trips the
    // distribution covers both "R requires left-padding" (length < 32
    // before pad) and "R has DER 0x00 sign byte" cases. For that we
    // re-run the noble sign against the same digest and inspect R.
    const { createHash } = await import("node:crypto");
    const [h, c] = token.split(".");
    const digest = new Uint8Array(createHash("sha256").update(`${h}.${c}`).digest());
    const der = p256.sign(digest, KMS_RAW_PRIVATE, {
      prehash: false,
      format: "der",
      lowS: false,
    });
    // R length is at byte 3 of `0x30 LEN 0x02 R_LEN ...`
    const rLen = der[3];
    if (rLen === 33) foundHighBit = true;
    if (rLen < 32) foundLeadingZero = true;
    // Round-trip must succeed regardless of R/S shape.
    const decoded = signer.verify(token);
    assert.equal(decoded.salt, salt);
    if (foundHighBit && foundLeadingZero) break;
  }
  // We assert only the high-bit case here (the natural distribution
  // hits this within ~50 tries with overwhelming probability). The
  // "many round-trips" test above covers a leading-zero R case as a
  // softer empirical check.
  assert.ok(foundHighBit, "should have observed at least one R with DER sign-padding byte");
});

test("KmsJwtSigner: KMS Sign called with exactly the expected parameters", async () => {
  const kms = new FakeKMSClient();
  const signer = buildSigner({ kmsClient: kms });
  await signer.signAsync({}, defaultSignOpts());
  const signCalls = kms.calls.filter((c) => c.constructor.name === "SignCommand");
  assert.equal(signCalls.length, 1, "exactly one Sign call");
  const input = signCalls[0].input;
  assert.equal(input.KeyId, KEY_ARN, "KeyId is the configured ARN");
  assert.equal(input.MessageType, "DIGEST", "MessageType is DIGEST");
  assert.equal(input.SigningAlgorithm, "ECDSA_SHA_256", "SigningAlgorithm is ECDSA_SHA_256");
  assert.equal(input.Message.length, 32, "Message is a 32-byte SHA-256 digest");
});

test("KmsJwtSigner: failed KMS Sign emits a structured duration log", async () => {
  const logger = collectingLogger();
  const kms = new FakeKMSClient({ failNextSign: true });
  const signer = buildSigner({ kmsClient: kms, logger });

  await assert.rejects(
    () => signer.signAsync({}, defaultSignOpts()),
    /AccessDeniedException: simulated KMS Sign denied/,
  );
  const record = logger.records.find((entry) => entry.message === "kms.sign.duration");
  assert.ok(record, "expected failed kms.sign.duration log record");
  assert.equal(record.level, "warn");
  assert.equal(record.fields.signer, "jwt");
  assert.equal(record.fields.success, false);
  assert.equal(record.fields.errorName, "AccessDeniedException");
  assert.equal(record.fields.errorCode, "AccessDeniedException");
  assert.match(record.fields.errorMessage, /simulated KMS Sign denied/);
});

test("KmsJwtSigner: empty KMS Sign response emits a failed duration log", async () => {
  const logger = collectingLogger();
  const kms = new FakeKMSClient({ emptySignature: true });
  const signer = buildSigner({ kmsClient: kms, logger });

  await assert.rejects(
    () => signer.signAsync({}, defaultSignOpts()),
    /KmsJwtSigner: KMS Sign returned empty Signature/,
  );
  const record = logger.records.find((entry) => entry.message === "kms.sign.duration");
  assert.ok(record, "expected failed kms.sign.duration log record");
  assert.equal(record.level, "warn");
  assert.equal(record.fields.signer, "jwt");
  assert.equal(record.fields.success, false);
  assert.equal(record.fields.errorName, "Error");
  assert.equal(record.fields.errorCode, "Error");
  assert.match(record.fields.errorMessage, /empty Signature/);
});

test("KmsJwtSigner: FakeKMS denies wrong SigningAlgorithm (mirrors IAM policy)", async () => {
  // Sanity-check the fake itself: a SignCommand with a non-allowed
  // algorithm must throw. (The real adapter never sends a wrong
  // algorithm — this test asserts the fake's denial semantics so future
  // tests that intentionally try to trigger it can rely on the throw.)
  const kms = new FakeKMSClient();
  const { SignCommand } = await import("@aws-sdk/client-kms");
  await assert.rejects(
    () =>
      kms.send(
        new SignCommand({
          KeyId: KEY_ARN,
          Message: Buffer.alloc(32),
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_384",
        }),
      ),
    /SigningAlgorithm "ECDSA_SHA_384" not allowed/,
  );
});

test("KmsJwtSigner constructor: rejects alias as keyId", () => {
  assert.throws(
    () =>
      new KmsJwtSigner({
        kmsClient: new FakeKMSClient(),
        keyId: "alias/averray-jwt-signer-testnet",
        kid: KID,
        publicKeyPem: KMS_PUBLIC_PEM,
      }),
    /must be the full KMS key ARN, not an alias/,
  );
});

test("KmsJwtSigner constructor: rejects PEM that isn't a P-256 key (secp256k1)", () => {
  const { publicKey: k256pub } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const wrongPem = k256pub.export({ type: "spki", format: "pem" });
  assert.throws(
    () =>
      new KmsJwtSigner({
        kmsClient: new FakeKMSClient(),
        keyId: KEY_ARN,
        kid: KID,
        publicKeyPem: wrongPem,
      }),
    /Curve OID:.*expected P-256/,
  );
});

test("KmsJwtSigner constructor: rejects RSA PEM", () => {
  const { publicKey: rsaPub } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrongPem = rsaPub.export({ type: "spki", format: "pem" });
  assert.throws(
    () =>
      new KmsJwtSigner({
        kmsClient: new FakeKMSClient(),
        keyId: KEY_ARN,
        kid: KID,
        publicKeyPem: wrongPem,
      }),
    /expected ecPublicKey|Curve OID/,
  );
});

test("KmsJwtSigner constructor: rejects missing keyId", () => {
  assert.throws(
    () =>
      new KmsJwtSigner({
        kmsClient: new FakeKMSClient(),
        kid: KID,
        publicKeyPem: KMS_PUBLIC_PEM,
      }),
    /keyId is required/,
  );
});

test("KmsJwtSigner constructor: rejects missing kid", () => {
  assert.throws(
    () =>
      new KmsJwtSigner({
        kmsClient: new FakeKMSClient(),
        keyId: KEY_ARN,
        publicKeyPem: KMS_PUBLIC_PEM,
      }),
    /kid is required/,
  );
});

test("KmsJwtSigner constructor: rejects missing publicKeyPem", () => {
  assert.throws(
    () =>
      new KmsJwtSigner({
        kmsClient: new FakeKMSClient(),
        keyId: KEY_ARN,
        kid: KID,
      }),
    /publicKeyPem is required/,
  );
});

test("KmsJwtSigner constructor: rejects when neither kmsClient nor region is provided", () => {
  assert.throws(
    () =>
      new KmsJwtSigner({
        keyId: KEY_ARN,
        kid: KID,
        publicKeyPem: KMS_PUBLIC_PEM,
      }),
    /either kmsClient or region must be provided/,
  );
});

test("KmsJwtSigner.verify: malformed token (not 3 segments) rejected", () => {
  const signer = buildSigner();
  assert.throws(() => signer.verify("only.two"), /malformed token/);
  assert.throws(() => signer.verify("a.b.c.d"), /malformed token/);
});

test("KmsJwtSigner.verify: invalid signature length is rejected pre-DER-convert", async () => {
  const signer = buildSigner();
  const token = await signer.signAsync({}, defaultSignOpts());
  const [h, c] = token.split(".");
  // Truncate signature to 32 bytes.
  const shortSig = b64uEncode(new Uint8Array(32));
  assert.throws(() => signer.verify(`${h}.${c}.${shortSig}`), /invalid signature length 32/);
});

test("KmsJwtSigner.verify: per-call verify options override constructor defaults", async () => {
  const signer = buildSigner({ expectedIssuer: "x", expectedAudience: "y", expectedRoles: ["admin"] });
  // signAsync uses opts.issuer/audience, not constructor; sign with the
  // "real" values but verify with per-call overrides matching them.
  const token = await signer.signAsync({}, defaultSignOpts());
  const claims = signer.verify(token, {
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
    expectedRoles: ROLES,
  });
  assert.equal(claims.sub, SUBJECT);
});

test("KmsJwtSigner.verify: token signed by a different P-256 key fails signature check", async () => {
  // Sign using the WRONG private key, but everything else (header,
  // claims) is well-formed. Our verifier holds the right public key, so
  // the signature must fail.
  const signer = buildSigner();
  const token = await forgeTokenWithKey(makeHeader(), makeClaims(), OTHER_RAW_PRIVATE);
  assert.throws(() => signer.verify(token), /signature mismatch/);
});
