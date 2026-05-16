import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import { loadAuthConfig, resolveRoles, hasRole } from "./config.js";
import { signToken, verifyToken } from "./jwt.js";
import { buildSiweMessage, parseSiweMessage, verifySiweMessage } from "./siwe.js";
import { createAuthMiddleware } from "./middleware.js";
import { MemoryStateStore } from "../core/state-store.js";
import { AuthenticationError, AuthorizationError, ConfigError } from "../core/errors.js";

const LONG_SECRET = "x".repeat(40);
const OTHER_SECRET = "y".repeat(40);

function silentLogger() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

test("loadAuthConfig strict mode requires secrets", () => {
  assert.throws(
    () => loadAuthConfig({ NODE_ENV: "production" }),
    ConfigError
  );
});

test("loadAuthConfig permissive mode tolerates missing secrets", () => {
  const config = loadAuthConfig({ NODE_ENV: "development", AUTH_MODE: "permissive" });
  assert.equal(config.mode, "permissive");
  assert.equal(config.permissive, true);
  assert.deepEqual(config.secrets, []);
});

test("loadAuthConfig rejects short secrets", () => {
  assert.throws(
    () => loadAuthConfig({ AUTH_MODE: "strict", AUTH_JWT_SECRETS: "short" }),
    ConfigError
  );
});

test("loadAuthConfig parses rotation secrets", () => {
  const config = loadAuthConfig({
    AUTH_MODE: "strict",
    AUTH_JWT_SECRETS: `${LONG_SECRET},${OTHER_SECRET}`,
    AUTH_DOMAIN: "example.com",
    AUTH_CHAIN_ID: "1"
  });
  assert.deepEqual(config.secrets, [LONG_SECRET, OTHER_SECRET]);
  assert.equal(config.signingSecret, LONG_SECRET);
  assert.equal(config.domain, "example.com");
  assert.equal(config.chainId, 1);
});

test("signToken/verifyToken round-trip", () => {
  const { token, claims } = signToken({ sub: "0xabc" }, { secret: LONG_SECRET, expiresInSeconds: 60 });
  const verified = verifyToken(token, { secrets: [LONG_SECRET] });
  assert.equal(verified.sub, "0xabc");
  assert.equal(verified.jti, claims.jti);
});

test("verifyToken rejects tampered payload", () => {
  const { token } = signToken({ sub: "0xabc" }, { secret: LONG_SECRET, expiresInSeconds: 60 });
  const parts = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ sub: "0xattacker", iat: 0, exp: 9_999_999_999 }))
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
  const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
  assert.throws(
    () => verifyToken(tamperedToken, { secrets: [LONG_SECRET] }),
    AuthenticationError
  );
});

test("verifyToken rejects expired token", () => {
  const { token } = signToken({ sub: "0xabc" }, { secret: LONG_SECRET, expiresInSeconds: 1 });
  const [header, payloadPart, signature] = token.split(".");
  const decoded = JSON.parse(Buffer.from(payloadPart.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8"));
  decoded.exp = Math.floor(Date.now() / 1000) - 120;
  const reencoded = Buffer.from(JSON.stringify(decoded))
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
  const expired = `${header}.${reencoded}.${signature}`;
  assert.throws(
    () => verifyToken(expired, { secrets: [LONG_SECRET] }),
    (error) => error instanceof AuthenticationError && error.code === "bad_signature"
  );
});

test("verifyToken supports key rotation", () => {
  const { token } = signToken({ sub: "0xabc" }, { secret: LONG_SECRET, expiresInSeconds: 60 });
  const verified = verifyToken(token, { secrets: [OTHER_SECRET, LONG_SECRET] });
  assert.equal(verified.sub, "0xabc");
});

test("parseSiweMessage round-trip", () => {
  const wallet = Wallet.createRandom();
  const message = buildSiweMessage({
    domain: "example.com",
    address: wallet.address,
    statement: "Sign in to Agent Platform.",
    uri: "https://example.com",
    chainId: 1,
    nonce: "abc123",
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 300_000).toISOString()
  });
  const parsed = parseSiweMessage(message);
  assert.equal(parsed.domain, "example.com");
  assert.equal(parsed.address, wallet.address);
  assert.equal(parsed.statement, "Sign in to Agent Platform.");
  assert.equal(parsed.chainId, 1);
  assert.equal(parsed.nonce, "abc123");
});

test("verifySiweMessage recovers signer and validates fields", async () => {
  const wallet = Wallet.createRandom();
  const message = buildSiweMessage({
    domain: "example.com",
    address: wallet.address,
    statement: "Sign in.",
    uri: "https://example.com",
    chainId: 1,
    nonce: "nonce-xyz",
    issuedAt: new Date().toISOString()
  });
  const signature = await wallet.signMessage(message);

  const verified = verifySiweMessage(message, signature, { expectedDomain: "example.com", expectedChainId: 1 });
  assert.equal(verified.recoveredAddress, wallet.address);
  assert.equal(verified.nonce, "nonce-xyz");
});

test("verifySiweMessage rejects domain mismatch", async () => {
  const wallet = Wallet.createRandom();
  const message = buildSiweMessage({
    domain: "evil.com",
    address: wallet.address,
    statement: "Sign in.",
    uri: "https://evil.com",
    chainId: 1,
    nonce: "nonce-xyz",
    issuedAt: new Date().toISOString()
  });
  const signature = await wallet.signMessage(message);
  assert.throws(
    () => verifySiweMessage(message, signature, { expectedDomain: "example.com", expectedChainId: 1 }),
    (error) => error instanceof AuthenticationError && error.code === "siwe_domain_mismatch"
  );
});

test("verifySiweMessage rejects wrong signer", async () => {
  const signerA = Wallet.createRandom();
  const signerB = Wallet.createRandom();
  const message = buildSiweMessage({
    domain: "example.com",
    address: signerA.address,
    statement: "Sign in.",
    uri: "https://example.com",
    chainId: 1,
    nonce: "nonce-xyz",
    issuedAt: new Date().toISOString()
  });
  const signature = await signerB.signMessage(message);
  assert.throws(
    () => verifySiweMessage(message, signature, { expectedDomain: "example.com", expectedChainId: 1 }),
    (error) => error instanceof AuthenticationError && error.code === "siwe_signature_mismatch"
  );
});

test("MemoryStateStore nonce store/consume round-trip", async () => {
  const store = new MemoryStateStore();
  const stored = await store.storeNonce("nonce-1", "0xabc", 60);
  assert.equal(stored, true);
  const double = await store.storeNonce("nonce-1", "0xdef", 60);
  assert.equal(double, false);

  const wallet = await store.consumeNonce("nonce-1");
  assert.equal(wallet, "0xabc");

  const again = await store.consumeNonce("nonce-1");
  assert.equal(again, undefined);
});

test("MemoryStateStore nonce expires after TTL", async () => {
  const store = new MemoryStateStore();
  await store.storeNonce("nonce-x", "0xabc", 0.001);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const wallet = await store.consumeNonce("nonce-x");
  assert.equal(wallet, undefined);
});

test("requireAuth accepts valid bearer token", async () => {
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const { token } = signToken({ sub: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, {
    secret: LONG_SECRET,
    expiresInSeconds: 60
  });

  const request = { method: "GET", headers: { authorization: `Bearer ${token}` } };
  const url = new URL("http://localhost/api/account");
  const result = await middleware(request, url);
  assert.equal(result.wallet.toLowerCase(), "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(result.via, "header");
});

test("requireAuth rejects missing token in strict mode", async () => {
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const request = { method: "GET", headers: {} };
  const url = new URL("http://localhost/api/account?wallet=0xabc");
  await assert.rejects(
    () => middleware(request, url),
    (error) => {
      assert.ok(error instanceof AuthenticationError);
      assert.equal(error.code, "missing_token");
      assert.equal(error.details.requiresAuth, true);
      assert.equal(error.details.requiredAction, "wallet_sign_in");
      assert.equal(error.details.authScheme, "SIWE_JWT");
      assert.deepEqual(error.details.authEntrypoints, ["/auth/nonce", "/auth/verify", "/auth/logout"]);
      return true;
    }
  );
});

test("requireAuth permissive mode falls back to ?wallet=", async () => {
  const authConfig = {
    secrets: [],
    signingSecret: undefined,
    permissive: true,
    strict: false
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const request = { method: "GET", headers: {} };
  const url = new URL("http://localhost/api/account?wallet=0xdef");
  const result = await middleware(request, url);
  assert.equal(result.wallet, "0xdef");
  assert.equal(result.via, "permissive_query");
});

test("requireAuth accepts ?token= when allowQueryToken is true", async () => {
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const { token } = signToken({ sub: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, {
    secret: LONG_SECRET,
    expiresInSeconds: 60
  });
  const request = { method: "GET", headers: {} };
  const url = new URL(`http://localhost/api/events?token=${encodeURIComponent(token)}`);
  const result = await middleware(request, url, { allowQueryToken: true });
  assert.equal(result.wallet.toLowerCase(), "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(result.via, "query_token");
});

test("loadAuthConfig parses admin and verifier wallet lists", () => {
  const config = loadAuthConfig({
    AUTH_MODE: "strict",
    AUTH_JWT_SECRETS: LONG_SECRET,
    AUTH_DOMAIN: "example.com",
    AUTH_CHAIN_ID: "1",
    AUTH_ADMIN_WALLETS: "0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222",
    AUTH_VERIFIER_WALLETS: "0x3333333333333333333333333333333333333333"
  });
  assert.equal(config.adminWallets.size, 2);
  assert.equal(config.verifierWallets.size, 1);
  assert.deepEqual(config.resolveRoles("0x1111111111111111111111111111111111111111"), ["admin"]);
  assert.deepEqual(config.resolveRoles("0x3333333333333333333333333333333333333333"), ["verifier"]);
  assert.deepEqual(config.resolveRoles("0x4444444444444444444444444444444444444444"), []);
});

test("loadAuthConfig rejects malformed admin wallet entries", () => {
  assert.throws(
    () =>
      loadAuthConfig({
        AUTH_MODE: "strict",
        AUTH_JWT_SECRETS: LONG_SECRET,
        AUTH_ADMIN_WALLETS: "not-an-address"
      }),
    ConfigError
  );
});

test("resolveRoles is case-insensitive and deduplicates via set membership", () => {
  const roles = resolveRoles("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", {
    adminWallets: new Set(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]),
    verifierWallets: new Set(["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])
  });
  assert.deepEqual(roles, ["admin", "verifier"]);
});

test("hasRole returns false for invalid role names", () => {
  assert.equal(hasRole({ roles: ["admin"] }, "superuser"), false);
  assert.equal(hasRole({ roles: ["admin"] }, "admin"), true);
  assert.equal(hasRole({}, "admin"), false);
  assert.equal(hasRole(undefined, "admin"), false);
});

test("requireAuth accepts token with required role", async () => {
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true,
    adminWallets: new Set(),
    verifierWallets: new Set()
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const { token } = signToken(
    { sub: "0xcccccccccccccccccccccccccccccccccccccccc", roles: ["admin"] },
    { secret: LONG_SECRET, expiresInSeconds: 60 }
  );
  const request = { method: "POST", headers: { authorization: `Bearer ${token}` } };
  const url = new URL("http://localhost/api/admin/jobs");
  const result = await middleware(request, url, { requireRole: "admin" });
  assert.deepEqual(result.claims.roles, ["admin"]);
});

test("requireAuth rejects token missing required role", async () => {
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true,
    adminWallets: new Set(),
    verifierWallets: new Set()
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const { token } = signToken(
    { sub: "0xcccccccccccccccccccccccccccccccccccccccc", roles: [] },
    { secret: LONG_SECRET, expiresInSeconds: 60 }
  );
  const request = { method: "POST", headers: { authorization: `Bearer ${token}` } };
  const url = new URL("http://localhost/api/admin/jobs");
  await assert.rejects(
    () => middleware(request, url, { requireRole: "admin" }),
    (error) => {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.code, "missing_role");
      assert.equal(error.details.requiresAuth, true);
      assert.equal(error.details.requiredRole, "admin");
      assert.equal(error.details.requiredAction, "admin_wallet_sign_in");
      return true;
    }
  );
});

test("requireAuth rejects token missing route capability", async () => {
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true,
    adminWallets: new Set(),
    verifierWallets: new Set()
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const { token } = signToken(
    { sub: "0xcccccccccccccccccccccccccccccccccccccccc", roles: [] },
    { secret: LONG_SECRET, expiresInSeconds: 60 }
  );
  const request = { method: "GET", headers: { authorization: `Bearer ${token}` } };
  const url = new URL("http://localhost/admin/status");
  await assert.rejects(
    () => middleware(request, url),
    (error) => {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.code, "missing_capability");
      assert.deepEqual(error.details.requiredCapabilities, ["admin:status", "ops:view"]);
      assert.deepEqual(error.details.missingCapabilities, ["admin:status", "ops:view"]);
      return true;
    }
  );
});

test("requireAuth accepts explicit capability scopes without a role", async () => {
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true,
    adminWallets: new Set(),
    verifierWallets: new Set()
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const { token } = signToken(
    {
      sub: "0xcccccccccccccccccccccccccccccccccccccccc",
      roles: [],
      capabilities: ["ops:view"]
    },
    { secret: LONG_SECRET, expiresInSeconds: 60 }
  );
  const request = { method: "GET", headers: { authorization: `Bearer ${token}` } };
  const url = new URL("http://localhost/admin/jobs");
  const result = await middleware(request, url);
  assert.deepEqual(result.capabilityRequirements, ["ops:view"]);
  assert.ok(result.capabilities.includes("ops:view"));
});

test("requireAuth in permissive mode resolves roles from env wallet lists", async () => {
  const adminWallet = "0xdddddddddddddddddddddddddddddddddddddddd";
  const authConfig = {
    secrets: [],
    signingSecret: undefined,
    permissive: true,
    strict: false,
    adminWallets: new Set([adminWallet]),
    verifierWallets: new Set()
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const request = { method: "POST", headers: {} };
  const url = new URL(`http://localhost/api/admin/jobs?wallet=${adminWallet}`);
  const result = await middleware(request, url, { requireRole: "admin" });
  assert.equal(result.via, "permissive_query");
  assert.deepEqual(result.claims.roles, ["admin"]);
});

test("requireAuth in permissive mode rejects unauthorized wallets for role-gated routes", async () => {
  const authConfig = {
    secrets: [],
    signingSecret: undefined,
    permissive: true,
    strict: false,
    adminWallets: new Set(),
    verifierWallets: new Set()
  };
  const middleware = createAuthMiddleware({ authConfig, logger: silentLogger() });
  const request = { method: "POST", headers: {} };
  const url = new URL("http://localhost/api/admin/jobs?wallet=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  await assert.rejects(
    () => middleware(request, url, { requireRole: "admin" }),
    (error) => error instanceof AuthorizationError && error.code === "missing_role"
  );
});

test("requireAuth rejects a token whose jti has been revoked", async () => {
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true,
    adminWallets: new Set(),
    verifierWallets: new Set()
  };
  const store = new MemoryStateStore();
  const middleware = createAuthMiddleware({ authConfig, stateStore: store, logger: silentLogger() });
  const { token, claims } = signToken(
    { sub: "0xffffffffffffffffffffffffffffffffffffffff", roles: [] },
    { secret: LONG_SECRET, expiresInSeconds: 60 }
  );
  await store.revokeToken(claims.jti, 60);
  const request = { method: "GET", headers: { authorization: `Bearer ${token}` } };
  const url = new URL("http://localhost/api/account");
  await assert.rejects(
    () => middleware(request, url),
    (error) => error instanceof AuthenticationError && error.code === "token_revoked"
  );
});

test("MemoryStateStore revokeToken expires after its TTL", async () => {
  const store = new MemoryStateStore();
  await store.revokeToken("jti-x", 0.01);
  assert.equal(await store.isTokenRevoked("jti-x"), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await store.isTokenRevoked("jti-x"), false);
});

test("MemoryStateStore isTokenRevoked is false for unknown jti", async () => {
  const store = new MemoryStateStore();
  assert.equal(await store.isTokenRevoked("never-seen"), false);
});

test("MemoryStateStore capability grants round-trip + filter by subject and status", async () => {
  const store = new MemoryStateStore();
  const subjectA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const subjectB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await store.upsertCapabilityGrant({ id: "g-a1", subject: subjectA, status: "active", capabilities: ["jobs:lifecycle"], issuedAt: "2026-01-01T00:00:00.000Z" });
  await store.upsertCapabilityGrant({ id: "g-a2", subject: subjectA, status: "revoked", capabilities: ["jobs:lifecycle"], issuedAt: "2026-01-02T00:00:00.000Z" });
  await store.upsertCapabilityGrant({ id: "g-b1", subject: subjectB, status: "active", capabilities: ["policies:propose"], issuedAt: "2026-01-03T00:00:00.000Z" });

  const all = await store.listCapabilityGrants({});
  assert.equal(all.length, 3);
  // Newest-first ordering.
  assert.deepEqual(all.map((g) => g.id), ["g-b1", "g-a2", "g-a1"]);

  const onlyA = await store.listCapabilityGrants({ subject: subjectA });
  assert.deepEqual(onlyA.map((g) => g.id).sort(), ["g-a1", "g-a2"]);

  const onlyActive = await store.listCapabilityGrants({ status: "active" });
  assert.deepEqual(onlyActive.map((g) => g.id).sort(), ["g-a1", "g-b1"]);

  const aActive = await store.listCapabilityGrants({ subject: subjectA, status: "active" });
  assert.deepEqual(aActive.map((g) => g.id), ["g-a1"]);
});

test("requireAuth merges active capability grants for the subject", async () => {
  const subject = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const stateStore = new MemoryStateStore();
  await stateStore.upsertCapabilityGrant({
    id: "grant-x",
    subject,
    status: "active",
    capabilities: ["jobs:lifecycle"],
    issuedAt: new Date().toISOString(),
    issuedBy: "0x1111111111111111111111111111111111111111"
  });
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true
  };
  const middleware = createAuthMiddleware({ authConfig, stateStore, logger: silentLogger() });
  const { token } = signToken({ sub: subject, roles: [] }, {
    secret: LONG_SECRET,
    expiresInSeconds: 60
  });
  const request = { method: "POST", headers: { authorization: `Bearer ${token}` } };
  const url = new URL("http://localhost/admin/jobs/lifecycle");
  // Without the grant the request would fail capability enforcement
  // because base capabilities do not include jobs:lifecycle. The
  // grant promotes the subject above the route requirement.
  const result = await middleware(request, url);
  assert.ok(result.capabilities.includes("jobs:lifecycle"));
});

test("requireAuth ignores revoked grants when expanding capabilities", async () => {
  const subject = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const stateStore = new MemoryStateStore();
  await stateStore.upsertCapabilityGrant({
    id: "grant-y",
    subject,
    status: "revoked",
    capabilities: ["jobs:lifecycle"],
    issuedAt: new Date().toISOString(),
    revokedAt: new Date().toISOString(),
    issuedBy: "0x1111111111111111111111111111111111111111"
  });
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true
  };
  const middleware = createAuthMiddleware({ authConfig, stateStore, logger: silentLogger() });
  const { token } = signToken({ sub: subject, roles: [] }, {
    secret: LONG_SECRET,
    expiresInSeconds: 60
  });
  const request = { method: "POST", headers: { authorization: `Bearer ${token}` } };
  const url = new URL("http://localhost/admin/jobs/lifecycle");
  await assert.rejects(
    () => middleware(request, url),
    (error) => error instanceof AuthorizationError && error.code === "missing_capability"
  );
});

test("requireAuth exposes grant-cache invalidation for immediate operator revokes", async () => {
  const subject = "0xcccccccccccccccccccccccccccccccccccccccc";
  const issuedBy = "0x1111111111111111111111111111111111111111";
  const stateStore = new MemoryStateStore();
  await stateStore.upsertCapabilityGrant({
    id: "grant-cache",
    subject,
    status: "active",
    capabilities: ["jobs:lifecycle"],
    issuedAt: new Date().toISOString(),
    issuedBy
  });
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true
  };
  const middleware = createAuthMiddleware({ authConfig, stateStore, logger: silentLogger() });
  const { token } = signToken({ sub: subject, roles: [] }, {
    secret: LONG_SECRET,
    expiresInSeconds: 60
  });
  const request = { method: "POST", headers: { authorization: `Bearer ${token}` } };
  const url = new URL("http://localhost/admin/jobs/lifecycle");

  assert.ok((await middleware(request, url)).capabilities.includes("jobs:lifecycle"));

  await stateStore.upsertCapabilityGrant({
    id: "grant-cache",
    subject,
    status: "revoked",
    capabilities: ["jobs:lifecycle"],
    issuedAt: new Date().toISOString(),
    issuedBy,
    revokedAt: new Date().toISOString(),
    revokedBy: issuedBy
  });
  middleware.invalidateCapabilityGrantCache(subject);

  await assert.rejects(
    () => middleware(request, url),
    (error) => error instanceof AuthorizationError && error.code === "missing_capability"
  );
});

test("requireAuth binds service tokens to exactly one active grant without base capabilities", async () => {
  const subject = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const stateStore = new MemoryStateStore();
  await stateStore.upsertCapabilityGrant({
    id: "grant-service",
    subject,
    status: "active",
    capabilities: ["jobs:lifecycle"],
    issuedAt: new Date().toISOString(),
    issuedBy: "0x1111111111111111111111111111111111111111"
  });
  await stateStore.upsertCapabilityGrant({
    id: "grant-other",
    subject,
    status: "active",
    capabilities: ["policies:propose"],
    issuedAt: new Date().toISOString(),
    issuedBy: "0x1111111111111111111111111111111111111111"
  });
  const authConfig = {
    secrets: [LONG_SECRET],
    signingSecret: LONG_SECRET,
    permissive: false,
    strict: true
  };
  const middleware = createAuthMiddleware({ authConfig, stateStore, logger: silentLogger() });
  const { token } = signToken({
    sub: subject,
    roles: [],
    tokenKind: "service",
    serviceToken: true,
    capabilityGrantId: "grant-service"
  }, {
    secret: LONG_SECRET,
    expiresInSeconds: 60
  });
  const request = { method: "POST", headers: { authorization: `Bearer ${token}` } };

  const lifecycle = await middleware(request, new URL("http://localhost/admin/jobs/lifecycle"));
  assert.deepEqual(lifecycle.claims.roles, []);
  assert.ok(lifecycle.capabilities.includes("jobs:lifecycle"));
  assert.equal(lifecycle.capabilities.includes("account:read"), false);
  assert.equal(lifecycle.capabilities.includes("policies:propose"), false);

  await assert.rejects(
    () => middleware({ method: "GET", headers: request.headers }, new URL("http://localhost/account")),
    (error) => {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.code, "missing_capability");
      assert.deepEqual(error.details.missingCapabilities, ["account:read"]);
      return true;
    }
  );

  await assert.rejects(
    () => middleware({ method: "POST", headers: request.headers }, new URL("http://localhost/policies")),
    (error) => {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.code, "missing_capability");
      assert.deepEqual(error.details.missingCapabilities, ["policies:propose"]);
      return true;
    }
  );

  await stateStore.upsertCapabilityGrant({
    id: "grant-service",
    subject,
    status: "revoked",
    capabilities: ["jobs:lifecycle"],
    issuedAt: new Date().toISOString(),
    revokedAt: new Date().toISOString(),
    issuedBy: "0x1111111111111111111111111111111111111111"
  });
  await assert.rejects(
    () => middleware(request, new URL("http://localhost/admin/jobs/lifecycle")),
    (error) => error instanceof AuthorizationError && error.code === "missing_capability"
  );
});
