import assert from "node:assert/strict";
import test from "node:test";

import { createArrivalRoutes } from "./arrival-routes.js";

test("GET /monitor/arrivals serves the funnel without a session", async () => {
  const calls = [];
  const route = createArrivalRoutes({
    respond: (_response, status, body, headers) => calls.push([status, body, headers]),
    arrivalObservatory: {
      getSnapshot: async () => ({ schemaVersion: "averray.arrivals.v1", funnel: { reached: 3 } })
    }
  });

  assert.equal(await route({ request: { method: "GET" }, response: {}, pathname: "/monitor/arrivals" }), true);
  assert.deepEqual(calls, [[
    200,
    { schemaVersion: "averray.arrivals.v1", funnel: { reached: 3 } },
    { "cache-control": "public, max-age=10" }
  ]]);
});

test("/monitor/arrivals is not handled for another method or path", async () => {
  let read = false;
  const route = createArrivalRoutes({
    respond: () => {},
    arrivalObservatory: { getSnapshot: async () => { read = true; return {}; } }
  });

  assert.equal(await route({ request: { method: "POST" }, pathname: "/monitor/arrivals" }), false);
  assert.equal(await route({ request: { method: "GET" }, pathname: "/health" }), false);
  assert.equal(read, false);
});

test("POST /admin/arrivals/canary-marker mints an admin-authorized wallet-bound marker", async () => {
  const calls = [];
  const route = createArrivalRoutes({
    respond: (_response, status, body, headers) => calls.push(["respond", status, body, headers]),
    arrivalObservatory: { getSnapshot: async () => ({}) },
    arrivalCanaryMarkers: {
      issue: async (wallet) => ({ marker: "signed", wallet, expiresAt: "2030-01-01T00:00:00.000Z" })
    },
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return { wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    },
    enforceLimit: async (...args) => calls.push(["limit", ...args]),
    rateLimitConfig: { adminJobs: { limit: 1 } },
    readJsonBody: async () => ({ wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })
  });

  assert.equal(await route({
    request: { method: "POST" },
    response: {},
    url: new URL("http://localhost/admin/arrivals/canary-marker"),
    pathname: "/admin/arrivals/canary-marker"
  }), true);
  assert.deepEqual(calls[0], ["auth", { requireRole: "admin" }]);
  assert.equal(calls[1][0], "limit");
  assert.deepEqual(calls[2], ["respond", 201, {
    marker: "signed",
    wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    expiresAt: "2030-01-01T00:00:00.000Z"
  }, { "cache-control": "no-store" }]);
});
