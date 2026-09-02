import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError, AuthorizationError } from "../../core/errors.js";
import { buildContentRecord } from "../../core/content-addressed-store.js";
import { createContentRoutes } from "./content-routes.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TX_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeHarness({
  auth = { wallet: OWNER, claims: { roles: [] } },
  authError,
  gateway = {},
  payload,
  records = [],
} = {}) {
  const calls = [];
  const response = {};
  const content = new Map(records.map((record) => [record.hash, record]));
  const logger = {
    warn: (...args) => calls.push(["logger.warn", args])
  };

  const route = createContentRoutes({
    authMiddleware: async (request, url, options = {}) => {
      calls.push(["authMiddleware", { method: request.method, pathname: url.pathname, options }]);
      if (authError) {
        throw authError;
      }
      return auth;
    },
    gateway,
    hasRole: (claims, role) => Array.isArray(claims?.roles) && claims.roles.includes(role),
    logger,
    persistContentRecord: async (record) => {
      calls.push(["persistContentRecord", record.hash]);
      content.set(record.hash, record);
      return record;
    },
    publicBaseUrl: "https://api.example.test",
    readJsonBody: async () => {
      calls.push(["readJsonBody"]);
      return payload;
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    stateStore: {
      getContent: async (hash) => {
        calls.push(["getContent", hash]);
        return content.get(hash);
      }
    },
    walletsMatch: (left, right) => String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase(),
  });

  return { calls, content, response, route };
}

function callRoute(route, { method = "GET", path }) {
  return route({
    request: { method },
    response: {},
    url: new URL(`http://localhost${path}`),
    pathname: path,
  });
}

test("content routes ignore unrelated paths and methods", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/content"),
    pathname: "/content",
  }), false);
  assert.equal(await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/content/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    pathname: "/content/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }), false);

  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("POST /content authenticates, persists, and returns a content URI", async () => {
  const payload = {
    payload: { answer: 42 },
    contentType: "submission",
    verdict: "pass",
  };
  const { calls, content, response, route } = makeHarness({ payload });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/content"),
    pathname: "/content",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.ownerWallet, OWNER.toLowerCase());
  assert.equal(response.body.contentType, "submission");
  assert.equal(response.body.visibility, "public");
  assert.equal(response.body.contentURI, `https://api.example.test/content/${response.body.hash}`);
  assert.equal(content.has(response.body.hash), true);
  assert.deepEqual(calls.map(([name]) => name), [
    "authMiddleware",
    "readJsonBody",
    "persistContentRecord",
    "respond",
  ]);
});

test("POST /content rejects non-admin writes for another owner", async () => {
  const payload = {
    ownerWallet: OTHER,
    payload: { private: true },
  };
  const { calls, route } = makeHarness({ payload });

  await assert.rejects(
    callRoute(route, { method: "POST", path: "/content" }),
    (error) => error instanceof AuthorizationError && error.code === "content_owner_forbidden"
  );

  assert.deepEqual(calls.map(([name]) => name), [
    "authMiddleware",
    "readJsonBody",
  ]);
});

test("POST /content/:hash/publish returns not_found for missing content", async () => {
  const { response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/content/${TX_HASH}/publish`),
    pathname: `/content/${TX_HASH}/publish`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", hash: TX_HASH });
});

test("POST /content/:hash/publish persists and emits disclosure for the owner", async () => {
  const record = buildContentRecord({
    ownerWallet: OWNER,
    payload: { status: "draft" },
    autoPublicAt: "2099-01-01T00:00:00.000Z",
  });
  const gateway = {
    isEnabled: () => true,
    discloseContent: async (hash, byWallet) => ({ txHash: TX_HASH, hash, byWallet }),
  };
  const { content, response, route } = makeHarness({ gateway, records: [record] });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/content/${record.hash}/publish`),
    pathname: `/content/${record.hash}/publish`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.hash, record.hash);
  assert.equal(response.body.visibility, "public");
  assert.equal(response.body.disclosureEvent.emitted, true);
  assert.equal(response.body.disclosureEvent.txHash, TX_HASH);
  assert.equal(response.body.contentURI, `https://api.example.test/content/${record.hash}`);
  assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.ok(content.get(record.hash).publishedAt);
});

test("GET /content/:hash allows auto-public content without auth and emits auto disclosure", async () => {
  const record = buildContentRecord({
    ownerWallet: OWNER,
    payload: { old: true },
    autoPublicAt: "2000-01-01T00:00:00.000Z",
  });
  const gateway = {
    isEnabled: () => true,
    autoDiscloseContent: async (hash) => ({ txHash: TX_HASH, hash }),
  };
  const { response, route } = makeHarness({
    authError: new AuthenticationError("No token."),
    gateway,
    records: [record],
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL(`http://localhost/content/${record.hash}`),
    pathname: `/content/${record.hash}`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.hash, record.hash);
  assert.equal(response.body.visibility, "public");
  assert.equal(response.body.autoDisclosureEvent.emitted, true);
  assert.equal(response.body.autoDisclosureEvent.txHash, TX_HASH);
});

test("GET /content/:hash rejects private content without auth", async () => {
  const record = buildContentRecord({
    ownerWallet: OWNER,
    payload: { secret: true },
    autoPublicAt: "2099-01-01T00:00:00.000Z",
  });
  const { route } = makeHarness({
    authError: new AuthenticationError("No token."),
    records: [record],
  });

  await assert.rejects(
    callRoute(route, { path: `/content/${record.hash}` }),
    (error) => error instanceof AuthorizationError && error.code === "content_private"
  );
});
