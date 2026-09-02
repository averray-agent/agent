import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "../../core/errors.js";
import { createAdminXcmRoutes } from "./admin-xcm-routes.js";

const AUTH = {
  wallet: "0x1111111111111111111111111111111111111111",
  roles: ["admin"]
};
const REQUEST_ID = `0x${"ab".repeat(32)}`;
const REMOTE_REF = `0x${"12".repeat(32)}`;

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? {
    requestId: REQUEST_ID,
    status: "succeeded",
    settledAssets: 5,
    settledShares: 3,
    remoteRef: REMOTE_REF,
    observedAt: "2026-05-22T00:00:00.000Z",
    idempotencyKey: "idem-1"
  };
  const route = createAdminXcmRoutes({
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
    getIdempotentMutationReplay: async (context) => {
      calls.push(["replay", context]);
      return overrides.replay ?? null;
    },
    rateLimitConfig: { adminJobs: { windowMs: 10_000, max: 5 } },
    readJsonBody: async () => {
      calls.push(["body"]);
      return payload;
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    service: {
      observeXcmOutcome: async (requestId, outcome) => {
        calls.push(["observeXcmOutcome", { requestId, outcome }]);
        return overrides.observed ?? { requestId, ...outcome, observed: true };
      },
      finalizeXcmRequest: async (requestId, outcome) => {
        calls.push(["finalizeXcmRequest", { requestId, outcome }]);
        return overrides.finalized ?? { requestId, ...outcome, finalized: true };
      }
    },
    storeIdempotentMutationReceipt: async (receipt) => {
      calls.push(["storeReceipt", receipt]);
    },
  });
  return { calls, response, route };
}

test("admin XCM routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/not-xcm"),
    pathname: "/admin/not-xcm",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("POST /admin/xcm/observe records an observation and stores idempotent receipt", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/xcm/observe"),
    pathname: "/admin/xcm/observe",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.requestId, REQUEST_ID);
  assert.equal(response.body.observed, true);
  assert.deepEqual(calls.find(([name]) => name === "limit")?.[1], {
    bucket: "admin_jobs",
    key: AUTH.wallet,
    limits: { windowMs: 10_000, max: 5 }
  });
  assert.deepEqual(calls.find(([name]) => name === "observeXcmOutcome")?.[1], {
    requestId: REQUEST_ID,
    outcome: {
      status: "succeeded",
      settledAssets: 5,
      settledShares: 3,
      remoteRef: REMOTE_REF,
      failureCode: undefined,
      source: "admin_observer",
      observedAt: "2026-05-22T00:00:00.000Z"
    }
  });
  assert.deepEqual(calls.find(([name]) => name === "storeReceipt")?.[1], {
    bucket: "admin_xcm_observe",
    key: `${AUTH.wallet}:${REQUEST_ID}:idem-1`,
    requestHash: "hash-1",
    response: response.body,
    statusCode: 200
  });
});

test("POST /admin/xcm/observe uses query requestId and defaults settlement fields", async () => {
  const { calls, response, route } = makeHarness({
    payload: { status: "failed", failureCode: "remote_failed", idempotencyKey: "idem-query" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/admin/xcm/observe?requestId=${REQUEST_ID}`),
    pathname: "/admin/xcm/observe",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.find(([name]) => name === "observeXcmOutcome")?.[1], {
    requestId: REQUEST_ID,
    outcome: {
      status: "failed",
      settledAssets: 0,
      settledShares: 0,
      remoteRef: undefined,
      failureCode: "remote_failed",
      source: "admin_observer",
      observedAt: undefined
    }
  });
});

test("POST /admin/xcm/observe returns replay before observer side effects", async () => {
  const replay = { statusCode: 200, body: { requestId: REQUEST_ID, replay: true } };
  const { calls, response, route } = makeHarness({ replay });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/xcm/observe"),
    pathname: "/admin/xcm/observe",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { requestId: REQUEST_ID, replay: true });
  assert.ok(!calls.some(([name]) => name === "observeXcmOutcome"));
  assert.ok(!calls.some(([name]) => name === "storeReceipt"));
});

test("POST /admin/xcm/finalize finalizes a request and stores idempotent receipt", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/xcm/finalize"),
    pathname: "/admin/xcm/finalize",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.requestId, REQUEST_ID);
  assert.equal(response.body.finalized, true);
  assert.deepEqual(calls.find(([name]) => name === "finalizeXcmRequest")?.[1], {
    requestId: REQUEST_ID,
    outcome: {
      status: "succeeded",
      settledAssets: 5,
      settledShares: 3,
      remoteRef: REMOTE_REF,
      failureCode: undefined
    }
  });
  assert.deepEqual(calls.find(([name]) => name === "storeReceipt")?.[1], {
    bucket: "admin_xcm_finalize",
    key: `${AUTH.wallet}:${REQUEST_ID}:idem-1`,
    requestHash: "hash-1",
    response: response.body,
    statusCode: 200
  });
});

test("POST /admin/xcm/finalize validates requestId before service side effects", async () => {
  const { calls, route } = makeHarness({
    payload: { status: "succeeded", idempotencyKey: "idem-missing" }
  });

  await assert.rejects(
    () => route({
      request: { method: "POST" },
      response: {},
      url: new URL("http://localhost/admin/xcm/finalize"),
      pathname: "/admin/xcm/finalize",
    }),
    ValidationError
  );
  assert.ok(!calls.some(([name]) => name === "finalizeXcmRequest"));
  assert.ok(!calls.some(([name]) => name === "storeReceipt"));
});
