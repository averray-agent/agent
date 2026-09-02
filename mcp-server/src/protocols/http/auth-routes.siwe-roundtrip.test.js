// End-to-end regression for the SIWE `sub`-casing bug, exercising the REAL
// ES256 verifier (KmsJwtSigner.verify — the backend prod runs under).
//
// The bug: ethers' signature recovery returns an EIP-55 *checksummed* address.
// The /auth/verify handler minted that verbatim as the JWT `sub`, but the
// ES256 verifier REJECTS a non-lowercase `sub` ("sub claim must be lowercase").
// verifyTokenFromConfig classifies that exact error as 401 claims_mismatch, so
// /auth/verify returned 200 yet every authed call self-rejected.
//
// What this test does:
//   • Test 1 drives the real /auth/verify handler with a CHECKSUMMED recovered
//     address. The injected signer mints a genuine ES256 token from the claims
//     the handler hands it (signed locally with Node crypto — a faithful stand
//     -in for the KMS signer, producing the exact ES256 shape KmsJwtSigner.verify
//     accepts). The minted token then ROUND-TRIPS through KmsJwtSigner.verify
//     with no error, and its sub is the lowercased address. Before the fix the
//     handler passed the checksummed address through and this verify step threw.
//   • Test 2 is the negative control: a checksummed `sub` ES256 token is
//     REJECTED by KmsJwtSigner.verify with "sub claim must be lowercase" —
//     proving the lowercase fix is load-bearing, not cosmetic.
//
// We verify against KmsJwtSigner directly rather than verifyTokenFromConfig
// because the latter eagerly wires an AWS credentials provider (for the SIGN
// path) that isn't needed — and isn't installable — for a verify-only test.
// The lowercase enforcement under test lives entirely in KmsJwtSigner.verify.
// Minting locally with Node crypto (standard ES256, no AWS / no @noble/curves
// pre-hash dance) keeps the test self-contained while feeding the REAL verifier.
// The HS256 backend does NOT enforce lowercase, so only ES256 reproduces it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";

import { getAddress } from "ethers";

import { createAuthRoutes } from "./auth-routes.js";
import { KmsJwtSigner } from "../../auth/kms-jwt-signer.js";

// P-256 keypair generated at module load — the public PEM goes into the
// verifier, the private key signs the test tokens.
const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const PUBLIC_PEM = PUBLIC_KEY.export({ type: "spki", format: "pem" });

const KID = "jwt-1";
const ISSUER = "averray-backend-testnet";
const AUDIENCE = "averray-backend";
// Mirror KmsJwtSigner's emitted JOSE header (see HEADER_TYP / HEADER_ALG).
const HEADER = { alg: "ES256", typ: "averray-auth+jwt", kid: KID };

// Use the same function siwe.js uses to produce `recoveredAddress`, so the test
// input is exactly what production recovers from a signature.
const LOWER_WALLET = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CHECKSUMMED_WALLET = getAddress(LOWER_WALLET);

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

// Mint a genuine ES256 JWT: ECDSA-P256 over SHA-256 of the signing input, with
// the signature in raw R||S (JOSE / IEEE-P1363) form — exactly what
// KmsJwtSigner.verify expects (64-byte raw sig, alg ES256, typ averray-auth+jwt).
function mintEs256(claims) {
  const signingInput = `${b64url(HEADER)}.${b64url(claims)}`;
  const sig = cryptoSign("sha256", Buffer.from(signingInput), {
    key: PRIVATE_KEY,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${sig.toString("base64url")}`;
}

// A faithful stand-in for production's signTokenFromConfig: mints a real ES256
// token carrying whatever `sub` the caller (the /auth/verify handler) provides.
function mintFromConfigImpl(payload, opts, cfg) {
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: cfg.kmsJwt.expectedIssuer,
    aud: cfg.kmsJwt.expectedAudience,
    sub: payload.sub,
    roles: Array.isArray(payload.roles) ? payload.roles : [],
    iat,
    nbf: iat,
    exp: iat + opts.expiresInSeconds,
    jti: randomUUID(),
  };
  return { token: mintEs256(claims), claims };
}

function buildVerifier() {
  return new KmsJwtSigner({
    // verify uses only publicKeyPem; kmsClient is required by the constructor
    // but never called on the verify path.
    kmsClient: { async send() { throw new Error("sign path not exercised in this test"); } },
    keyId: "arn:aws:kms:eu-central-2:000000000000:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    kid: KID,
    publicKeyPem: PUBLIC_PEM,
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
    expectedRoles: ["admin", "verifier"],
    maxTtlSeconds: 3600,
    clockSkewSeconds: 60,
  });
}

function makeHandlerAuthConfig() {
  return {
    domain: "app.example.test",
    chainId: 420420,
    nonceTtlSeconds: 60,
    tokenTtlSeconds: 900,
    // /auth/verify gates on a truthy signingSecret; the injected ES256 signer
    // never reads it, but prod sets AUTH_JWT_SECRETS alongside JWT_BACKEND=kms.
    signingSecret: "present-but-unused-under-es256",
    resolveRoles: () => [], // fresh wallet → roleless, mirroring the hosted proof
    kmsJwt: { expectedIssuer: ISSUER, expectedAudience: AUDIENCE },
  };
}

async function postAuthVerify(authConfig, recoveredAddress) {
  const route = createAuthRoutes({
    authCapabilities: {
      capabilityMatrix: () => ({}),
      resolveCapabilities: () => [],
    },
    authConfig,
    authMiddleware: async () => ({ wallet: recoveredAddress, claims: {} }),
    clientIp: () => "ip",
    enforceLimit: async () => {},
    logger: { warn: () => {} },
    rateLimitConfig: { authNonce: {}, authVerify: {}, authRefresh: {} },
    readJsonBody: async () => ({ message: "siwe-message", signature: `0x${"1".repeat(130)}` }),
    respond: (res, statusCode, body, headers = {}) => {
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    signTokenFromConfigImpl: mintFromConfigImpl,
    verifySiweMessageImpl: () => ({ nonce: "nonce-1", recoveredAddress }),
    stateStore: {
      consumeNonce: async () => recoveredAddress.toLowerCase(), // nonce stored lowercase
      // no refresh-store methods → cookie path skipped
    },
  });

  const response = {};
  await route({
    request: { method: "POST", headers: {} },
    response,
    url: new URL("http://localhost/auth/verify"),
    pathname: "/auth/verify",
  });
  return response;
}

test("SIWE login with a checksummed wallet mints a token whose sub passes ES256 verify (no claims_mismatch)", async () => {
  // Guard the test's own premise: the input really is mixed-case.
  assert.notEqual(CHECKSUMMED_WALLET, LOWER_WALLET);

  const response = await postAuthVerify(makeHandlerAuthConfig(), CHECKSUMMED_WALLET);

  assert.equal(response.statusCode, 200);
  const token = response.body.token;
  assert.ok(typeof token === "string" && token.split(".").length === 3, "expected a JWT");
  assert.equal(response.body.wallet, LOWER_WALLET); // canonical lowercase form

  // THE REGRESSION: the SIWE-minted token round-trips through the REAL ES256
  // verifier with no error, and its sub is the lowercased address.
  const claims = buildVerifier().verify(token);
  assert.equal(claims.sub, LOWER_WALLET);
  assert.equal(claims.sub, claims.sub.toLowerCase());
  assert.notEqual(claims.sub, CHECKSUMMED_WALLET);
});

test("a checksummed sub is rejected by ES256 verify — proves the lowercase fix is load-bearing", () => {
  // The pre-fix token: a perfectly-signed ES256 JWT whose only flaw is a
  // checksummed (non-lowercase) sub.
  const { token } = mintFromConfigImpl(
    { sub: CHECKSUMMED_WALLET, roles: [] },
    { expiresInSeconds: 900 },
    makeHandlerAuthConfig(),
  );

  assert.throws(
    () => buildVerifier().verify(token),
    /KmsJwtSigner\.verify: sub claim must be lowercase/u,
    "verifier must reject a non-lowercase sub",
  );
});
