import assert from "node:assert/strict";
import test from "node:test";
import { ConflictError } from "../../core/errors.js";
import { createAdminCapabilityRoutes } from "./admin-capability-routes.js";

const ADMIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUBJECT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AUTH = {
  wallet: ADMIN,
  roles: ["admin"],
  capabilities: ["events:read", "jobs:claim", "jobs:list", "jobs:submit"]
};

const ACTIVE_GRANT = {
  id: "grant-existing",
  subject: SUBJECT,
  capabilities: ["jobs:list"],
  issuedBy: ADMIN,
  issuedAt: "2026-05-22T12:00:00.000Z",
  status: "active"
};

function makeAuthMiddleware(calls, auth) {
  const authMiddleware = async (_request, _url, options) => {
    calls.push(["auth", options]);
    return auth ?? AUTH;
  };
  authMiddleware.invalidateCapabilityGrantCache = (subject) => {
    calls.push(["invalidateGrantCache", subject]);
  };
  return authMiddleware;
}

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? {
    subject: SUBJECT,
    capabilities: ["jobs:list"],
    issuedAt: "2026-05-22T12:00:00.000Z",
    nonce: "nonce-1",
    idempotencyKey: "idem-1"
  };
  const store = new Map((overrides.grants ?? [ACTIVE_GRANT]).map((grant) => [grant.id, grant]));
  const route = createAdminCapabilityRoutes({
    authConfig: overrides.authConfig ?? {
      jwtBackend: "hmac",
      signingSecret: "test-secret",
      tokenTtlSeconds: 3600
    },
    authMiddleware: makeAuthMiddleware(calls, overrides.auth),
    buildMutationRequestHash: (input) => {
      calls.push(["hash", input]);
      return overrides.requestHash ?? "hash-1";
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["limit", { bucket, key, limits }]);
    },
    eventBus: {
      publish: (event) => {
        calls.push(["event", event]);
      }
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
      if (overrides.readJsonBodyError) {
        throw overrides.readJsonBodyError;
      }
      return payload;
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    signTokenFromConfigImpl: async (claims, options, config) => {
      calls.push(["sign", { claims, options, config }]);
      return {
        token: overrides.token ?? "service-token-secret",
        claims: { ...claims, exp: 1_800_000_000 }
      };
    },
    stateStore: {
      listCapabilityGrants: async (options) => {
        calls.push(["listCapabilityGrants", options]);
        return [...store.values()];
      },
      getCapabilityGrant: async (grantId) => {
        calls.push(["getCapabilityGrant", grantId]);
        return store.get(grantId);
      },
      upsertCapabilityGrant: async (grant) => {
        calls.push(["upsertCapabilityGrant", grant]);
        store.set(grant.id, grant);
      },
    },
    storeIdempotentMutationReceipt: async (receipt) => {
      calls.push(["storeReceipt", receipt]);
    },
  });
  return { calls, response, route, store };
}

async function callRoute(route, response, method, path) {
  return await route({
    request: { method },
    response,
    url: new URL(`http://localhost${path}`),
    pathname: path.split("?")[0],
  });
}

test("admin capability routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await callRoute(route, response, "GET", "/admin/not-capabilities");

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /admin/capability-grants lists projected grants with filters", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await callRoute(
    route,
    response,
    "GET",
    "/admin/capability-grants?subject=0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&status=ACTIVE&limit=10&offset=3"
  );

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    items: [ACTIVE_GRANT],
    limit: 10,
    offset: 3
  });
  assert.deepEqual(calls.slice(0, 3), [
    ["auth", { requireRole: "admin" }],
    ["parseLimit", { fallback: 50, max: 200 }],
    ["listCapabilityGrants", {
      subject: SUBJECT,
      status: "active",
      limit: 10,
      offset: 3
    }],
  ]);
});

test("POST /admin/capability-grants creates a grant and stores an idempotent receipt", async () => {
  const { calls, response, route, store } = makeHarness({
    payload: {
      subject: SUBJECT,
      capabilities: ["jobs:list", "jobs:claim"],
      issuedAt: "2026-05-22T12:00:00.000Z",
      nonce: "new-grant",
      idempotencyKey: "idem-1"
    },
    grants: []
  });

  const handled = await callRoute(route, response, "POST", "/admin/capability-grants");

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.subject, SUBJECT);
  assert.deepEqual(response.body.capabilities, ["jobs:claim", "jobs:list"]);
  assert.equal(response.body.status, "active");
  assert.equal(store.size, 1);
  assert.deepEqual(calls.find(([name]) => name === "replay")?.[1], {
    bucket: "capability_grant",
    key: `${ADMIN}:idem-1`,
    requestHash: "hash-1"
  });
  assert.deepEqual(calls.find(([name]) => name === "storeReceipt")?.[1], {
    bucket: "capability_grant",
    key: `${ADMIN}:idem-1`,
    requestHash: "hash-1",
    response: response.body,
    statusCode: 201
  });
  assert.ok(calls.some(([name]) => name === "invalidateGrantCache"));
  assert.equal(calls.find(([name]) => name === "event")?.[1].topic, "capability.grant");
});

test("POST /admin/capability-grants returns idempotent replay before side effects", async () => {
  const replay = { statusCode: 200, body: { id: "grant-existing", replay: true } };
  const { calls, response, route } = makeHarness({ replay });

  const handled = await callRoute(route, response, "POST", "/admin/capability-grants");

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { id: "grant-existing", replay: true });
  assert.ok(!calls.some(([name]) => name === "upsertCapabilityGrant"));
  assert.ok(!calls.some(([name]) => name === "event"));
  assert.ok(!calls.some(([name]) => name === "storeReceipt"));
});

test("POST /admin/service-tokens issues a one-time secret and stores tokenless replay", async () => {
  const { calls, response, route } = makeHarness({
    payload: {
      subject: SUBJECT,
      capabilities: ["jobs:list"],
      issuedAt: "2026-05-22T12:00:00.000Z",
      nonce: "service-token",
      tokenTtlSeconds: 600,
      idempotencyKey: "idem-token"
    },
    grants: []
  });

  const handled = await callRoute(route, response, "POST", "/admin/service-tokens");

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.token, "service-token-secret");
  assert.equal(response.body.tokenAvailable, true);
  assert.equal(response.body.tokenKind, "service");
  assert.equal(response.body.wallet, SUBJECT);
  assert.equal(response.body.expiresAt, "2027-01-15T08:00:00.000Z");
  assert.deepEqual(calls.find(([name]) => name === "sign")?.[1].claims, {
    sub: SUBJECT,
    roles: ["service"],
    tokenKind: "service",
    serviceToken: true,
    capabilityGrantId: response.body.grant.id
  });
  const receipt = calls.find(([name]) => name === "storeReceipt")?.[1];
  assert.equal(receipt.bucket, "service_token_issue");
  assert.equal(receipt.key, `${ADMIN}:idem-token`);
  assert.equal(receipt.response.tokenAvailable, false);
  assert.equal(receipt.response.tokenOmittedReason, "service_token_secret_is_returned_once");
  assert.equal("token" in receipt.response, false);
  assert.equal(calls.find(([name]) => name === "event")?.[1].topic, "service-token.issue");
});

test("POST /admin/service-tokens/:id/rotate revokes the old grant and returns a new token", async () => {
  const { calls, response, route, store } = makeHarness({
    payload: {
      capabilities: ["jobs:submit"],
      issuedAt: "2026-05-22T12:05:00.000Z",
      nonce: "rotate-token",
      tokenTtlSeconds: 300,
      idempotencyKey: "idem-rotate"
    }
  });

  const handled = await callRoute(route, response, "POST", "/admin/service-tokens/grant-existing/rotate");

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.token, "service-token-secret");
  assert.equal(response.body.grant.subject, SUBJECT);
  assert.deepEqual(response.body.grant.capabilities, ["jobs:submit"]);
  assert.equal(response.body.rotatedFrom.id, "grant-existing");
  assert.equal(response.body.rotatedFrom.status, "revoked");
  assert.equal(store.get("grant-existing").status, "revoked");
  assert.equal(calls.filter(([name]) => name === "upsertCapabilityGrant").length, 2);
  const receipt = calls.find(([name]) => name === "storeReceipt")?.[1];
  assert.equal(receipt.bucket, "service_token_rotate");
  assert.equal(receipt.key, `${ADMIN}:grant-existing:idem-rotate`);
  assert.equal(receipt.response.tokenAvailable, false);
  assert.equal("token" in receipt.response, false);
  assert.equal(calls.find(([name]) => name === "event")?.[1].topic, "service-token.rotate");
});

test("POST /admin/service-tokens/:id/rotate rejects a revoked grant", async () => {
  const revokedGrant = {
    ...ACTIVE_GRANT,
    status: "revoked",
    revokedAt: "2026-05-22T12:10:00.000Z",
    revokedBy: ADMIN
  };
  const { calls, response, route } = makeHarness({ grants: [revokedGrant] });

  await assert.rejects(
    () => callRoute(route, response, "POST", "/admin/service-tokens/grant-existing/rotate"),
    (error) => error instanceof ConflictError && error.code === "service_token_grant_revoked"
  );
  assert.ok(!calls.some(([name]) => name === "sign"));
  assert.ok(!calls.some(([name]) => name === "upsertCapabilityGrant"));
});

test("POST /admin/service-tokens/:id/revoke is idempotent for already revoked grants", async () => {
  const revokedGrant = {
    ...ACTIVE_GRANT,
    status: "revoked",
    revokedAt: "2026-05-22T12:10:00.000Z",
    revokedBy: ADMIN
  };
  const { calls, response, route } = makeHarness({
    grants: [revokedGrant],
    payload: { idempotencyKey: "idem-revoke" }
  });

  const handled = await callRoute(route, response, "POST", "/admin/service-tokens/grant-existing/revoke");

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "revoked");
  assert.equal(response.body.alreadyRevoked, true);
  assert.equal(response.body.tokenAvailable, false);
  assert.ok(!calls.some(([name]) => name === "upsertCapabilityGrant"));
  assert.ok(!calls.some(([name]) => name === "event"));
  assert.deepEqual(calls.find(([name]) => name === "storeReceipt")?.[1], {
    bucket: "service_token_revoke",
    key: `${ADMIN}:grant-existing:idem-revoke`,
    requestHash: "hash-1",
    response: response.body,
    statusCode: 200
  });
});
