import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError, ValidationError } from "../../core/errors.js";
import { createAuthRoutes } from "./auth-routes.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VALID_SIGNATURE = `0x${"1".repeat(130)}`;

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {
    headers: {},
    setHeader(name, value) {
      calls.push(["setHeader", { name, value }]);
      this.headers[name] = value;
    }
  };
  const authConfig = {
    domain: "app.example.test",
    chainId: 420420,
    nonceTtlSeconds: 60,
    tokenTtlSeconds: 900,
    signingSecret: "test-secret",
    resolveRoles: (wallet) => {
      calls.push(["resolveRoles", wallet]);
      return overrides.roles ?? ["admin"];
    },
    ...(overrides.authConfig ?? {})
  };
  const stateStore = {
    storeNonce: async (nonce, wallet, ttlSeconds) => {
      calls.push(["storeNonce", { nonce, wallet, ttlSeconds }]);
      return overrides.storeNonceResult ?? true;
    },
    consumeNonce: async (nonce) => {
      calls.push(["consumeNonce", nonce]);
      return overrides.consumedWallet ?? WALLET;
    },
    revokeToken: async (jti, ttlSeconds) => {
      calls.push(["revokeToken", { jti, ttlSeconds }]);
    },
    ...(overrides.refreshStore
      ? {
          getRefreshRecord: async () => undefined,
          upsertRefreshRecord: async () => undefined,
        }
      : {}),
    ...(overrides.stateStore ?? {})
  };

  const route = createAuthRoutes({
    authCapabilities: {
      capabilityMatrix: () => ({ jobs: { list: ["jobs:list"] } }),
      resolveCapabilities: ({ roles }) => roles.includes("admin") ? ["*"] : ["jobs:list"],
    },
    authConfig,
    authMiddleware: async (_request, _url) => {
      calls.push(["authMiddleware"]);
      return overrides.auth ?? {
        wallet: WALLET,
        claims: { roles: ["admin"], jti: "old-jti", exp: Math.floor(Date.now() / 1000) + 120 },
        capabilities: ["*"],
      };
    },
    buildClearCookieHeaderImpl: () => {
      calls.push(["clearCookie"]);
      return "refresh_token=; Max-Age=0";
    },
    buildSetCookieHeaderImpl: (rawToken) => {
      calls.push(["setCookie", rawToken]);
      return `refresh_token=${rawToken}`;
    },
    buildSiweMessageImpl: (input) => {
      calls.push(["buildSiweMessage", input]);
      return "siwe-message";
    },
    clientIp: (request) => {
      calls.push(["clientIp", request.ip ?? "ip-key"]);
      return request.ip ?? "ip-key";
    },
    consumeRefreshTokenImpl: async ({ rawToken, store }) => {
      calls.push(["consumeRefreshToken", { rawToken, store }]);
      if (overrides.consumeRefreshError) throw overrides.consumeRefreshError;
      return overrides.consumedRefresh ?? {
        hash: "refresh-hash",
        record: { wallet: WALLET, role: "admin" }
      };
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["limit", { bucket, key, limits }]);
    },
    hashRefreshTokenImpl: (rawToken) => {
      calls.push(["hashRefreshToken", rawToken]);
      return "hashed-refresh";
    },
    issueRefreshTokenImpl: async ({ wallet, role, store }) => {
      calls.push(["issueRefreshToken", { wallet, role, store }]);
      return { rawToken: "issued-refresh" };
    },
    logger: {
      warn: (...args) => calls.push(["logger.warn", args])
    },
    makeRefreshStoreAdapterImpl: (store) => {
      calls.push(["makeRefreshStoreAdapter", Boolean(store)]);
      return "refresh-store";
    },
    parseCookieImpl: () => {
      calls.push(["parseCookie"]);
      return overrides.refreshCookie ?? null;
    },
    randomBytesImpl: (size) => {
      calls.push(["randomBytes", size]);
      return Buffer.from("0123456789abcdef");
    },
    rateLimitConfig: {
      authNonce: { max: 2 },
      authVerify: { max: 3 },
      authRefresh: { max: 4 },
    },
    readJsonBody: async () => {
      calls.push(["readJsonBody"]);
      return overrides.payload ?? {};
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = { ...(res.headers ?? {}), ...headers };
    },
    revokeChainImpl: async (input) => {
      calls.push(["revokeChain", input]);
    },
    rotateRefreshTokenImpl: async (input) => {
      calls.push(["rotateRefreshToken", input]);
      return { rawToken: "rotated-refresh" };
    },
    signTokenFromConfigImpl: async (claims, options, config) => {
      calls.push(["signToken", { claims, options, config }]);
      return {
        token: overrides.token ?? "signed-token",
        claims: { ...claims, exp: 1_800_000_000 }
      };
    },
    stateStore,
    verifySiweMessageImpl: (message, signature, options) => {
      calls.push(["verifySiwe", { message, signature, options }]);
      return overrides.verified ?? { nonce: "nonce-1", recoveredAddress: WALLET };
    },
  });

  return { calls, response, route, stateStore };
}

async function callRoute(route, response, method, path, request = {}) {
  return await route({
    request: { method, headers: {}, ...request },
    response,
    url: new URL(`http://localhost${path}`),
    pathname: path.split("?")[0],
  });
}

test("auth routes ignore unrelated paths and methods", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await callRoute(route, response, "GET", "/auth/nonce"), false);
  assert.equal(await callRoute(route, response, "POST", "/not-auth"), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response.body, undefined);
});

test("POST /auth/nonce stores a wallet nonce and returns a SIWE message", async () => {
  const displayWallet = `0x${"A".repeat(40)}`;
  const { calls, response, route } = makeHarness({
    payload: { wallet: displayWallet }
  });

  assert.equal(await callRoute(route, response, "POST", "/auth/nonce"), true);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.wallet, displayWallet);
  assert.equal(response.body.domain, "app.example.test");
  assert.equal(response.body.chainId, 420420);
  assert.equal(response.body.message, "siwe-message");
  assert.deepEqual(calls.slice(0, 5).map(([name]) => name), [
    "clientIp",
    "limit",
    "readJsonBody",
    "randomBytes",
    "storeNonce",
  ]);
  assert.equal(calls.find(([name]) => name === "storeNonce")?.[1].wallet, WALLET);
});

test("POST /auth/nonce rejects malformed wallet before storing", async () => {
  const { calls, response, route } = makeHarness({ payload: { wallet: "not-wallet" } });

  await assert.rejects(
    callRoute(route, response, "POST", "/auth/nonce"),
    (error) => error instanceof ValidationError && error.message.includes("wallet must")
  );
  assert.ok(!calls.some(([name]) => name === "storeNonce"));
});

test("POST /auth/verify consumes nonce, signs token, and issues refresh cookie when supported", async () => {
  const { calls, response, route } = makeHarness({
    payload: { message: "siwe", signature: VALID_SIGNATURE },
    refreshStore: true,
    roles: ["admin", "verifier"],
  });

  assert.equal(await callRoute(route, response, "POST", "/auth/verify"), true);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.token, "signed-token");
  assert.deepEqual(response.body.roles, ["admin", "verifier"]);
  assert.deepEqual(response.body.capabilities, ["*"]);
  assert.equal(response.headers["Set-Cookie"], "refresh_token=issued-refresh");
  assert.deepEqual(calls.map(([name]) => name).slice(0, 8), [
    "clientIp",
    "limit",
    "readJsonBody",
    "verifySiwe",
    "consumeNonce",
    "resolveRoles",
    "signToken",
    "makeRefreshStoreAdapter",
  ]);
  assert.equal(calls.find(([name]) => name === "signToken")?.[1].claims.sub, WALLET);
});

test("POST /auth/verify rejects nonce wallet mismatch", async () => {
  const { calls, response, route } = makeHarness({
    payload: { message: "siwe", signature: VALID_SIGNATURE },
    consumedWallet: OTHER_WALLET,
  });

  await assert.rejects(
    callRoute(route, response, "POST", "/auth/verify"),
    (error) => error instanceof AuthenticationError && error.code === "nonce_wallet_mismatch"
  );
  assert.ok(!calls.some(([name]) => name === "signToken"));
});

test("GET /auth/session returns wallet, token kind, grants, and capability matrix", async () => {
  const { response, route } = makeHarness({
    auth: {
      wallet: WALLET,
      claims: {
        roles: ["agent"],
        tokenKind: "service",
        serviceToken: true,
        capabilityGrantId: "grant-1",
      },
      capabilities: ["jobs:list"],
    }
  });

  assert.equal(await callRoute(route, response, "GET", "/auth/session"), true);

  assert.deepEqual(response.body, {
    wallet: WALLET,
    roles: ["agent"],
    tokenKind: "service",
    serviceToken: true,
    capabilityGrantId: "grant-1",
    capabilities: ["jobs:list"],
    capabilityMatrix: { jobs: { list: ["jobs:list"] } }
  });
});

test("POST /auth/logout revokes JWT and refresh chain then clears cookie", async () => {
  const { calls, response, route } = makeHarness({
    refreshCookie: "refresh-cookie",
    refreshStore: true,
  });

  assert.equal(await callRoute(route, response, "POST", "/auth/logout"), true);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "logged_out");
  assert.equal(response.body.jti, "old-jti");
  assert.equal(response.headers["Set-Cookie"], "refresh_token=; Max-Age=0");
  assert.ok(calls.some(([name]) => name === "revokeToken"));
  assert.deepEqual(calls.find(([name]) => name === "revokeChain")?.[1], {
    hash: "hashed-refresh",
    store: "refresh-store",
    reason: "logout"
  });
});

test("POST /auth/refresh rotates opaque refresh cookies without bearer auth", async () => {
  const { calls, response, route } = makeHarness({
    refreshCookie: "refresh-cookie",
    refreshStore: true,
    roles: ["admin"],
  });

  assert.equal(await callRoute(route, response, "POST", "/auth/refresh"), true);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.wallet, WALLET);
  assert.equal(response.headers["Set-Cookie"], "refresh_token=rotated-refresh");
  assert.ok(!calls.some(([name]) => name === "authMiddleware"));
  assert.deepEqual(calls.find(([name]) => name === "rotateRefreshToken")?.[1], {
    oldRecord: { wallet: WALLET, role: "admin" },
    oldHash: "refresh-hash",
    store: "refresh-store"
  });
});

test("POST /auth/refresh legacy flow revokes old jti and returns rotatedFromJti", async () => {
  const { calls, response, route } = makeHarness({ roles: ["verifier"] });

  assert.equal(await callRoute(route, response, "POST", "/auth/refresh"), true);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.rotatedFromJti, "old-jti");
  assert.deepEqual(response.body.roles, ["verifier"]);
  assert.ok(calls.some(([name]) => name === "authMiddleware"));
  assert.ok(calls.some(([name]) => name === "revokeToken"));
});

test("POST /auth/refresh rejects service-token callers before signing", async () => {
  const { calls, response, route } = makeHarness({
    auth: {
      wallet: WALLET,
      claims: { tokenKind: "service", serviceToken: true },
      capabilities: ["jobs:list"],
    }
  });

  await assert.rejects(
    callRoute(route, response, "POST", "/auth/refresh"),
    (error) => error instanceof AuthenticationError && error.code === "service_token_refresh_unsupported"
  );
  assert.ok(!calls.some(([name]) => name === "signToken"));
});
