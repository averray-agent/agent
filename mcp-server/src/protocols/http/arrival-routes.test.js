import assert from "node:assert/strict";
import test from "node:test";

import { createArrivalRoutes } from "./arrival-routes.js";
import { respond } from "./http-helpers.js";

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


test("arrival reads share one compact snapshot for 10 seconds", async () => {
  let nowMs = 1_000;
  let builds = 0;
  const route = createArrivalRoutes({
    respond,
    now: () => nowMs,
    arrivalObservatory: {
      async getSnapshot() {
        builds += 1;
        await Promise.resolve();
        return { schemaVersion: "averray.arrivals.v1", funnel: { reached: builds } };
      }
    }
  });
  const read = async () => {
    let body;
    const response = { writeHead() {}, end(value) { body = value; } };
    await route({ request: { method: "GET" }, response, pathname: "/monitor/arrivals" });
    return body;
  };
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(builds, 1);
  assert.equal(first, second);
  assert.equal(first, '{"schemaVersion":"averray.arrivals.v1","funnel":{"reached":1}}');
  assert.doesNotMatch(first, /\n|  /u);
  nowMs += 9_999;
  assert.equal(await read(), first);
  assert.equal(builds, 1);
  nowMs += 1;
  const [third, fourth] = await Promise.all([read(), read()]);
  assert.equal(builds, 2);
  assert.equal(third, fourth);
  assert.equal(JSON.parse(third).funnel.reached, 2);
});

test("a failed arrival snapshot build can be retried", async () => {
  let builds = 0;
  const route = createArrivalRoutes({
    respond: () => {},
    arrivalObservatory: {
      async getSnapshot() {
        builds += 1;
        if (builds === 1) throw new Error("snapshot unavailable");
        return { funnel: { reached: 1 } };
      }
    }
  });
  const request = { request: { method: "GET" }, response: {}, pathname: "/monitor/arrivals" };
  await assert.rejects(route(request), /snapshot unavailable/u);
  assert.equal(await route(request), true);
  assert.equal(builds, 2);
});
