import assert from "node:assert/strict";
import test from "node:test";
import { listAllKnownCapabilities } from "../../auth/capabilities.js";
import { applyRevocation, buildCapabilityGrant, projectGrant } from "../../core/capability-grants.js";
import { createAdminServiceTokenRoutes } from "./admin-service-token-routes.js";

const ADMIN = "0x1111111111111111111111111111111111111111";
const SUBJECT = "0x2222222222222222222222222222222222222222";
const AUTH = {
  wallet: ADMIN,
  roles: ["admin"],
  capabilities: ["jobs:claim", "jobs:submit"]
};

function makeGrant(overrides = {}) {
  return buildCapabilityGrant({
    subject: SUBJECT,
    capabilities: ["jobs:claim"],
    issuedAt: "2026-05-22T00:00:00.000Z",
    nonce: "grant-1",
    ...overrides
  }, {
    knownCapabilities: listAllKnownCapabilities(),
    issuerWallet: ADMIN
  });
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? {
    subject: SUBJECT,
    capabilities: ["jobs:claim"],
    issuedAt: "2026-05-22T00:00:00.000Z",
    nonce: "issue-1",
    idempotencyKey: "issue-key"
  };
  const grants = new Map((overrides.grants ?? []).map((grant) => [grant.id, grant]));

  const authMiddleware = async (_request, _url, options) => {
    calls.push(["auth", options]);
    return overrides.auth ?? AUTH;
  };
  authMiddleware.invalidateCapabilityGrantCache = (wallet) => {
    calls.push(["invalidateCapabilityGrantCache", wallet]);
  };

  const route = createAdminServiceTokenRoutes({
    assertIssuerCanGrantCapabilities: (grant, auth) => {
      calls.push(["assertIssuer", { grantId: grant.id, wallet: auth.wallet, capabilities: grant.capabilities }]);
      const missing = grant.capabilities.filter((capability) => !auth.capabilities.includes(capability));
      assert.deepEqual(missing, []);
    },
    authMiddleware,
    buildMutationRequestHash: (input) => {
      calls.push(["hash", input]);
      return `hash:${input.route}:${input.payload?.idempotencyKey ?? "none"}`;
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["limit", { bucket, key, limits }]);
    },
    eventBus: {
      publish(event) {
        calls.push(["event", { topic: event.topic, grantId: event.data.grantId }]);
      }
    },
    getIdempotentMutationReplay: async (context) => {
      calls.push(["replay", context]);
      return overrides.replay ?? null;
    },
    parseIdempotencyKey: (body) => body?.idempotencyKey?.trim() || undefined,
    parseLimit: (routeUrl, fallback, max) => {
      calls.push(["parseLimit", { fallback, max }]);
      return Number(routeUrl.searchParams.get("limit") ?? fallback);
    },
    rateLimitConfig: { adminJobs: { windowMs: 10_000, max: 5 } },
    readJsonBody: async () => {
      calls.push(["body"]);
      if (overrides.bodyError) {
        throw overrides.bodyError;
      }
      return payload;
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    revokeCapabilityGrantRecord: async ({ grantId, auth, note }) => {
      calls.push(["revokeRecord", { grantId, wallet: auth.wallet, note }]);
      const current = grants.get(grantId);
      const { record, alreadyRevoked } = applyRevocation(current, { revokedBy: auth.wallet, revokeNote: note });
      grants.set(grantId, record);
      return { current, record, alreadyRevoked };
    },
    serviceTokenIssueResponse: ({ grant, token, claims, rotatedFrom }) => ({
      token,
      tokenKind: "service",
      tokenAvailable: true,
      wallet: grant.subject,
      capabilities: [...grant.capabilities],
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      grant: projectGrant(grant),
      ...(rotatedFrom ? { rotatedFrom: projectGrant(rotatedFrom) } : {})
    }),
    serviceTokenReplayResponse: (body) => {
      const { token, ...rest } = body;
      void token;
      return { ...rest, tokenAvailable: false };
    },
    signServiceToken: async (grant, body) => {
      calls.push(["sign", { grantId: grant.id, body }]);
      return { token: `secret-${grant.id}`, claims: { exp: 1800000000 } };
    },
    stateStore: {
      listCapabilityGrants: async (query) => {
        calls.push(["listGrants", query]);
        return [...grants.values()];
      },
      getCapabilityGrant: async (grantId) => {
        calls.push(["getGrant", grantId]);
        return grants.get(grantId);
      },
      upsertCapabilityGrant: async (grant) => {
        calls.push(["upsertGrant", grant.id]);
        grants.set(grant.id, grant);
      }
    },
    storeIdempotentMutationReceipt: async (receipt) => {
      calls.push(["storeReceipt", receipt]);
    },
  });

  return { calls, grants, response, route };
}

test("admin service-token routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/capability-grants"),
    pathname: "/admin/capability-grants",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /admin/service-tokens lists token records without token secrets", async () => {
  const grant = makeGrant();
  const { calls, response, route } = makeHarness({ grants: [grant] });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/service-tokens?limit=25&offset=3"),
    pathname: "/admin/service-tokens",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    items: [{
      tokenKind: "service",
      tokenAvailable: false,
      grant: projectGrant(grant)
    }],
    limit: 25,
    offset: 3
  });
  assert.deepEqual(calls.slice(0, 3), [
    ["auth", { requireRole: "admin" }],
    ["parseLimit", { fallback: 50, max: 200 }],
    ["listGrants", { subject: undefined, status: undefined, limit: 25, offset: 3 }],
  ]);
});

test("POST /admin/service-tokens issues a token and stores only the sanitized replay body", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/service-tokens"),
    pathname: "/admin/service-tokens",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.tokenKind, "service");
  assert.equal(response.body.tokenAvailable, true);
  assert.ok(response.body.token.startsWith("secret-grant-"));
  assert.ok(calls.some(([name]) => name === "sign"));
  assert.ok(calls.some(([name, value]) => name === "event" && value.topic === "service-token.issue"));
  const receipt = calls.find(([name]) => name === "storeReceipt")?.[1];
  assert.equal(receipt.bucket, "service_token_issue");
  assert.equal(receipt.statusCode, 201);
  assert.equal(receipt.response.tokenAvailable, false);
  assert.equal(Object.hasOwn(receipt.response, "token"), false);
});

test("POST /admin/service-tokens returns idempotent replay without minting a new token", async () => {
  const replay = { statusCode: 200, body: { tokenKind: "service", tokenAvailable: false } };
  const { calls, response, route } = makeHarness({ replay });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/service-tokens"),
    pathname: "/admin/service-tokens",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, replay.body);
  assert.ok(calls.some(([name]) => name === "replay"));
  assert.ok(!calls.some(([name]) => name === "sign"));
  assert.ok(!calls.some(([name]) => name === "upsertGrant"));
});

test("POST /admin/service-tokens/:id/rotate revokes the old grant and returns the new token once", async () => {
  const current = makeGrant();
  const { calls, response, route } = makeHarness({
    grants: [current],
    payload: {
      issuedAt: "2026-05-22T00:01:00.000Z",
      nonce: "rotate-1",
      idempotencyKey: "rotate-key"
    }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/admin/service-tokens/${current.id}/rotate`),
    pathname: `/admin/service-tokens/${current.id}/rotate`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.tokenAvailable, true);
  assert.equal(response.body.rotatedFrom.id, current.id);
  assert.ok(calls.some(([name, value]) => name === "revokeRecord" && value.grantId === current.id));
  assert.ok(calls.some(([name, value]) => name === "event" && value.topic === "service-token.rotate"));
  const receipt = calls.find(([name]) => name === "storeReceipt")?.[1];
  assert.equal(receipt.bucket, "service_token_rotate");
  assert.equal(receipt.response.tokenAvailable, false);
  assert.equal(Object.hasOwn(receipt.response, "token"), false);
});

test("POST /admin/service-tokens/:id/revoke revokes the grant idempotently", async () => {
  const current = makeGrant();
  const { calls, response, route } = makeHarness({
    grants: [current],
    payload: {
      note: "operator stop",
      idempotencyKey: "revoke-key"
    }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/admin/service-tokens/${current.id}/revoke`),
    pathname: `/admin/service-tokens/${current.id}/revoke`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "revoked");
  assert.equal(response.body.tokenAvailable, false);
  assert.equal(response.body.alreadyRevoked, false);
  assert.equal(response.body.grant.id, current.id);
  assert.ok(calls.some(([name, value]) => name === "event" && value.topic === "service-token.revoke"));
  const receipt = calls.find(([name]) => name === "storeReceipt")?.[1];
  assert.equal(receipt.bucket, "service_token_revoke");
  assert.equal(receipt.statusCode, 200);
});
