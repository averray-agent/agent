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
const WRAPPER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? {
    requestId: REQUEST_ID,
    wrapperAddress: WRAPPER,
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
      listXcmFinalizeExhausted: async (limit) => {
        calls.push(["listXcmFinalizeExhausted", { limit }]);
        return overrides.exhausted ?? [];
      },
      observeXcmOutcome: async (requestId, outcome) => {
        calls.push(["observeXcmOutcome", { requestId, outcome }]);
        return overrides.observed ?? { requestId, ...outcome, observed: true };
      },
      finalizeXcmRequest: async (requestId, outcome) => {
        calls.push(["finalizeXcmRequest", { requestId, outcome }]);
        return overrides.finalized ?? { requestId, ...outcome, finalized: true };
      },
      backfillBankXcmWatch: async (requestId, options) => {
        calls.push(["backfillBankXcmWatch", { requestId, options }]);
        return overrides.watch ?? { requestId, registrationSource: "chain_event_backfill" };
      },
      dispatchBankXcmLeg: async (requestId, leg) => {
        calls.push(["dispatchBankXcmLeg", { requestId, leg }]);
        return overrides.dispatched ?? { requestId, leg, result: { status: 1 } };
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

test("GET /admin/xcm/finalize-exhausted lists parked requests for ops", async () => {
  const exhausted = [{ requestId: REQUEST_ID, finalizeState: "finalize_exhausted", attemptCount: 5 }];
  const { calls, response, route } = makeHarness({ exhausted });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/xcm/finalize-exhausted?limit=25"),
    pathname: "/admin/xcm/finalize-exhausted"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { count: 1, items: exhausted });
  assert.deepEqual(calls.find(([name]) => name === "auth")?.[1], { requireCapability: "ops:view" });
  assert.deepEqual(calls.find(([name]) => name === "listXcmFinalizeExhausted")?.[1], { limit: 25 });
  assert.ok(!calls.some(([name]) => name === "limit"), "read-only ops listing must not consume mutation quota");
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
      wrapperAddress: WRAPPER,
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
      wrapperAddress: undefined,
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

test("POST /admin/xcm/watch/backfill imports only a bounded chain-event watch", async () => {
  const { calls, response, route } = makeHarness({
    payload: { requestId: REQUEST_ID, fromBlock: 19_064_043, toBlock: 19_064_043, idempotencyKey: "watch-1" }
  });
  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/xcm/watch/backfill"),
    pathname: "/admin/xcm/watch/backfill"
  });

  assert.equal(handled, true);
  assert.equal(response.body.registrationSource, "chain_event_backfill");
  assert.deepEqual(calls.find(([name]) => name === "backfillBankXcmWatch")?.[1], {
    requestId: REQUEST_ID,
    options: { fromBlock: 19_064_043, toBlock: 19_064_043 }
  });
});

test("POST /admin/xcm/dispatch exposes only requestId and leg to the refusing dispatcher", async () => {
  const { calls, response, route } = makeHarness({
    payload: { requestId: REQUEST_ID, leg: "deposit_funding", idempotencyKey: "dispatch-1" }
  });
  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/xcm/dispatch"),
    pathname: "/admin/xcm/dispatch"
  });

  assert.equal(handled, true);
  assert.deepEqual(calls.find(([name]) => name === "dispatchBankXcmLeg")?.[1], {
    requestId: REQUEST_ID,
    leg: "deposit_funding"
  });
  const hashed = calls.find(([name]) => name === "hash")?.[1]?.payload;
  assert.deepEqual(Object.keys(hashed).sort(), ["idempotencyKey", "leg", "requestId"]);
});

test("POST /admin/xcm/dispatch refuses a signing attempt without idempotency", async () => {
  const { calls, route } = makeHarness({ payload: { requestId: REQUEST_ID, leg: "deposit_funding" } });
  await assert.rejects(
    route({
      request: { method: "POST" },
      response: {},
      url: new URL("http://localhost/admin/xcm/dispatch"),
      pathname: "/admin/xcm/dispatch"
    }),
    /idempotencyKey is required/u
  );
  assert.ok(!calls.some(([name]) => name === "dispatchBankXcmLeg"));
});
