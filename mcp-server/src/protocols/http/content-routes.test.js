import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError, AuthorizationError } from "../../core/errors.js";
import { buildContentRecord } from "../../core/content-addressed-store.js";
import { createContentRoutes } from "./content-routes.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const AUTH = { wallet: OWNER, claims: { roles: [] } };
const ADMIN_AUTH = { wallet: OTHER, claims: { roles: ["admin"] } };
const CREATED_AT = "2026-05-23T12:00:00.000Z";

function contentRecord(overrides = {}) {
  return buildContentRecord({
    payload: { rationale: "Needs correction." },
    contentType: "arbitrator_reasoning",
    ownerWallet: OWNER,
    verdict: "fail",
    createdAt: CREATED_AT,
    autoPublicAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function makeHarness(overrides = {}) {
  const calls = [];
  const records = new Map();
  for (const record of overrides.records ?? []) {
    records.set(record.hash, record);
  }
  const response = {};
  const route = createContentRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      if (overrides.authError) {
        throw overrides.authError;
      }
      return overrides.auth ?? AUTH;
    },
    contentRecoveryLog: {
      append: async (record) => {
        calls.push(["recovery", record.hash]);
      },
    },
    gateway: overrides.gateway ?? {
      isEnabled: () => false,
    },
    hasRole: (claims, role) => Array.isArray(claims?.roles) && claims.roles.includes(role),
    logger: {
      warn: (entry, message) => calls.push(["warn", { entry, message }]),
    },
    publicBaseUrl: "https://api.averray.test/",
    readJsonBody: async () => {
      calls.push(["body"]);
      return overrides.payload ?? {
        payload: { result: "structured evidence" },
        contentType: "submission",
        verdict: "pass",
      };
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    stateStore: {
      getContent: async (hash) => {
        calls.push(["getContent", hash]);
        return records.get(hash);
      },
      upsertContent: async (record) => {
        calls.push(["upsertContent", record.hash]);
        records.set(record.hash, record);
      },
    },
  });
  return { calls, records, response, route };
}

test("content routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-content"),
    pathname: "/not-content",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("POST /content stores owner-scoped content and returns a content URI", async () => {
  const { calls, records, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/content"),
    pathname: "/content",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.ownerWallet, OWNER);
  assert.equal(response.body.contentType, "submission");
  assert.equal(response.body.visibility, "public");
  assert.equal(response.body.contentURI, `https://api.averray.test/content/${response.body.hash}`);
  assert.deepEqual(response.body.payload, { result: "structured evidence" });
  assert.equal(records.get(response.body.hash)?.payload.result, "structured evidence");
  assert.deepEqual(calls.slice(0, 4), [
    ["auth", undefined],
    ["body"],
    ["recovery", response.body.hash],
    ["upsertContent", response.body.hash],
  ]);
});

test("POST /content rejects storing for a different owner unless admin", async () => {
  const { response, route } = makeHarness({
    payload: {
      payload: { result: "forbidden" },
      ownerWallet: OTHER,
      contentType: "submission",
    },
  });

  await assert.rejects(
    route({
      request: { method: "POST" },
      response,
      url: new URL("http://localhost/content"),
      pathname: "/content",
    }),
    (error) => error instanceof AuthorizationError
      && error.code === "content_owner_forbidden"
  );
});

test("POST /content allows admins to store for a different owner", async () => {
  const { response, route } = makeHarness({
    auth: ADMIN_AUTH,
    payload: {
      payload: { result: "admin stored" },
      ownerWallet: OWNER,
      contentType: "submission",
      verdict: "pass",
    },
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/content"),
    pathname: "/content",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.ownerWallet, OWNER);
  assert.deepEqual(response.body.payload, { result: "admin stored" });
});

test("POST /content/:hash/publish returns not_found for unknown content", async () => {
  const missingHash = "0x" + "a".repeat(64);
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/content/${missingHash}/publish`),
    pathname: `/content/${missingHash}/publish`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", hash: missingHash });
  assert.deepEqual(calls.slice(0, 3), [
    ["auth", undefined],
    ["getContent", missingHash],
    ["respond", { statusCode: 404, body: { status: "not_found", hash: missingHash }, headers: {} }],
  ]);
});

test("POST /content/:hash/publish enforces owner before publishing", async () => {
  const record = contentRecord();
  const { response, route } = makeHarness({
    auth: { wallet: OTHER, claims: { roles: [] } },
    records: [record],
  });

  await assert.rejects(
    route({
      request: { method: "POST" },
      response,
      url: new URL(`http://localhost/content/${record.hash}/publish`),
      pathname: `/content/${record.hash}/publish`,
    }),
    (error) => error instanceof AuthorizationError
      && error.code === "content_publish_forbidden"
  );
});

test("POST /content/:hash/publish persists, emits disclosure event, and returns immutable public content", async () => {
  const record = contentRecord();
  const { calls, records, response, route } = makeHarness({
    records: [record],
    gateway: {
      isEnabled: () => true,
      discloseContent: async (hash, byWallet) => {
        calls.push(["discloseContent", { hash, byWallet }]);
        return { txHash: "0xdisclosed" };
      },
    },
  });

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
  assert.equal(response.body.disclosureEvent.txHash, "0xdisclosed");
  assert.equal(response.body.contentURI, `https://api.averray.test/content/${record.hash}`);
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=31536000, immutable" });
  assert.ok(records.get(record.hash)?.publishedAt);
  assert.deepEqual(calls.slice(0, 5), [
    ["auth", undefined],
    ["getContent", record.hash],
    ["recovery", record.hash],
    ["upsertContent", record.hash],
    ["discloseContent", { hash: record.hash, byWallet: OWNER }],
  ]);
});

test("GET /content/:hash returns not_found for missing records", async () => {
  const missingHash = "0x" + "b".repeat(64);
  const { response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL(`http://localhost/content/${missingHash}`),
    pathname: `/content/${missingHash}`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", hash: missingHash });
});

test("GET /content/:hash treats missing auth as anonymous for private content", async () => {
  const record = contentRecord();
  const { response, route } = makeHarness({
    authError: new AuthenticationError("missing token", "missing_token"),
    records: [record],
  });

  await assert.rejects(
    route({
      request: { method: "GET" },
      response,
      url: new URL(`http://localhost/content/${record.hash}`),
      pathname: `/content/${record.hash}`,
    }),
    (error) => error instanceof AuthorizationError
      && error.code === "content_private"
  );
});

test("GET /content/:hash serves public auto-disclosed content without auth", async () => {
  const record = contentRecord({
    autoPublicAt: "2020-01-01T00:00:00.000Z",
  });
  const { calls, response, route } = makeHarness({
    authError: new AuthenticationError("missing token", "missing_token"),
    records: [record],
    gateway: {
      isEnabled: () => true,
      autoDiscloseContent: async (hash) => {
        calls.push(["autoDiscloseContent", hash]);
        return { txHash: "0xauto" };
      },
    },
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL(`http://localhost/content/${record.hash}`),
    pathname: `/content/${record.hash}`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.visibility, "public");
  assert.equal(response.body.autoDisclosureEvent.txHash, "0xauto");
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=31536000, immutable" });
  assert.deepEqual(calls.slice(0, 4), [
    ["getContent", record.hash],
    ["auth", { allowQueryToken: true }],
    ["autoDiscloseContent", record.hash],
    ["respond", {
      statusCode: 200,
      body: response.body,
      headers: { "cache-control": "public, max-age=31536000, immutable" }
    }],
  ]);
});
