import assert from "node:assert/strict";
import test from "node:test";
import { GRANT_STATUS } from "../../core/capability-grants.js";
import { AuthorizationError, ValidationError } from "../../core/errors.js";
import { createAdminCapabilityGrantRoutes } from "./admin-capability-grant-routes.js";

const ADMIN_WALLET = "0x1111111111111111111111111111111111111111";
const SUBJECT_WALLET = "0x2222222222222222222222222222222222222222";
const AUTH = {
  wallet: ADMIN_WALLET,
  roles: ["admin"],
  capabilities: ["jobs:claim", "jobs:submit"]
};

function activeGrant(overrides = {}) {
  return {
    id: "grant-existing",
    subject: SUBJECT_WALLET,
    capabilities: ["jobs:claim"],
    issuedBy: ADMIN_WALLET,
    issuedAt: "2026-05-22T00:00:00.000Z",
    status: GRANT_STATUS.active,
    ...overrides
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? {
    subject: SUBJECT_WALLET,
    capabilities: ["jobs:claim"],
    issuedAt: "2026-05-22T00:00:00.000Z",
    nonce: "unit-test",
    idempotencyKey: "idem-1"
  };
  const storedGrants = new Map((overrides.grants ?? [activeGrant()]).map((grant) => [grant.id, grant]));
  const route = createAdminCapabilityGrantRoutes({
    assertIssuerCanGrantCapabilities: (grant, auth) => {
      calls.push(["assertIssuer", { grant, auth }]);
      const issuerCapabilities = new Set(auth.capabilities ?? []);
      const missing = grant.capabilities.filter((capability) => !issuerCapabilities.has(capability));
      if (missing.length) {
        throw new AuthorizationError("Cannot grant capabilities the issuer token does not have.");
      }
    },
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    buildMutationRequestHash: (input) => {
      calls.push(["hash", input]);
      return overrides.requestHash ?? "hash-1";
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["limit", { bucket, key, limits }]);
    },
    eventBus: {
      publish: (event) => calls.push(["publish", event])
    },
    getIdempotentMutationReplay: async (context) => {
      calls.push(["replay", context]);
      return overrides.replay ?? null;
    },
    parseIdempotencyKey: (input = {}) => {
      calls.push(["parseIdempotencyKey", input]);
      return typeof input?.idempotencyKey === "string" && input.idempotencyKey.trim()
        ? input.idempotencyKey.trim()
        : undefined;
    },
    parseLimit: (url, fallback, max) => {
      calls.push(["parseLimit", { fallback, max }]);
      return Number(url.searchParams.get("limit") ?? fallback);
    },
    rateLimitConfig: { adminJobs: { windowMs: 10_000, max: 5 } },
    readJsonBody: async () => {
      calls.push(["body"]);
      if (overrides.bodyError) throw overrides.bodyError;
      return payload;
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    stateStore: {
      getCapabilityGrant: async (grantId) => {
        calls.push(["getGrant", grantId]);
        return storedGrants.get(grantId);
      },
      listCapabilityGrants: async (query) => {
        calls.push(["listGrants", query]);
        return [...storedGrants.values()];
      },
      upsertCapabilityGrant: async (grant) => {
        calls.push(["upsertGrant", grant]);
        storedGrants.set(grant.id, grant);
      }
    },
    storeIdempotentMutationReceipt: async (receipt) => {
      calls.push(["storeReceipt", receipt]);
    },
  });
  return { calls, response, route };
}

test("admin capability grant routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/not-capabilities"),
    pathname: "/admin/not-capabilities",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /admin/capability-grants lists projected grants", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL(`http://localhost/admin/capability-grants?subject=${SUBJECT_WALLET.toUpperCase()}&status=ACTIVE&limit=2&offset=3`),
    pathname: "/admin/capability-grants",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    items: [activeGrant()],
    limit: 2,
    offset: 3
  });
  assert.deepEqual(calls.slice(0, 3), [
    ["auth", { requireRole: "admin" }],
    ["parseLimit", { fallback: 50, max: 200 }],
    ["listGrants", {
      subject: SUBJECT_WALLET,
      status: "active",
      limit: 2,
      offset: 3
    }]
  ]);
});

test("POST /admin/capability-grants creates a grant with idempotency receipt and event", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/capability-grants"),
    pathname: "/admin/capability-grants",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.subject, SUBJECT_WALLET);
  assert.deepEqual(response.body.capabilities, ["jobs:claim"]);
  assert.equal(response.body.status, GRANT_STATUS.active);
  assert.ok(response.body.id.startsWith("grant-"));
  assert.deepEqual(calls.find(([name]) => name === "limit")?.[1], {
    bucket: "admin_jobs",
    key: ADMIN_WALLET,
    limits: { windowMs: 10_000, max: 5 }
  });
  assert.deepEqual(calls.find(([name]) => name === "storeReceipt")?.[1], {
    bucket: "capability_grant",
    key: `${ADMIN_WALLET}:idem-1`,
    requestHash: "hash-1",
    response: response.body,
    statusCode: 201
  });
  assert.equal(calls.find(([name]) => name === "publish")?.[1].topic, "capability.grant");
});

test("POST /admin/capability-grants returns idempotent replay before write side effects", async () => {
  const replay = { statusCode: 201, body: { id: "grant-replay", replay: true } };
  const { calls, response, route } = makeHarness({ replay });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/capability-grants"),
    pathname: "/admin/capability-grants",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body, { id: "grant-replay", replay: true });
  assert.ok(!calls.some(([name]) => name === "upsertGrant"));
  assert.ok(!calls.some(([name]) => name === "publish"));
});

test("POST /admin/capability-grants/:id/revoke revokes a grant idempotently", async () => {
  const { calls, response, route } = makeHarness({
    payload: { note: "operator cleanup", idempotencyKey: "idem-revoke" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/capability-grants/grant-existing/revoke"),
    pathname: "/admin/capability-grants/grant-existing/revoke",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.id, "grant-existing");
  assert.equal(response.body.status, GRANT_STATUS.revoked);
  assert.equal(response.body.revokedBy, ADMIN_WALLET);
  assert.equal(response.body.revokeNote, "operator cleanup");
  assert.deepEqual(calls.find(([name]) => name === "storeReceipt")?.[1], {
    bucket: "capability_revoke",
    key: `${ADMIN_WALLET}:grant-existing:idem-revoke`,
    requestHash: "hash-1",
    response: response.body,
    statusCode: 200
  });
  assert.equal(calls.find(([name]) => name === "publish")?.[1].topic, "capability.revoke");
});

test("POST /admin/capability-grants/:id/revoke returns replay before reading grant", async () => {
  const replay = { statusCode: 200, body: { id: "grant-existing", replay: true } };
  const { calls, response, route } = makeHarness({
    replay,
    payload: { idempotencyKey: "idem-revoke" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/capability-grants/grant-existing/revoke"),
    pathname: "/admin/capability-grants/grant-existing/revoke",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { id: "grant-existing", replay: true });
  assert.ok(!calls.some(([name]) => name === "getGrant"));
  assert.ok(!calls.some(([name]) => name === "upsertGrant"));
});

test("POST /admin/capability-grants/:id/revoke rejects unknown grant ids", async () => {
  const { calls, route } = makeHarness({
    grants: [],
    payload: { idempotencyKey: "idem-revoke" }
  });

  await assert.rejects(
    () => route({
      request: { method: "POST" },
      response: {},
      url: new URL("http://localhost/admin/capability-grants/missing/revoke"),
      pathname: "/admin/capability-grants/missing/revoke",
    }),
    ValidationError
  );
  assert.ok(calls.some(([name]) => name === "getGrant"));
  assert.ok(!calls.some(([name]) => name === "upsertGrant"));
});
