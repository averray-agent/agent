import assert from "node:assert/strict";
import test from "node:test";

import { createAdminJourneyRoutes } from "./admin-journey-routes.js";

function harness() {
  const calls = [];
  const response = {};
  return {
    calls,
    response,
    route: createAdminJourneyRoutes({
      authMiddleware: async (_request, _url, options) => calls.push(["auth", options]),
      parseLimit: (url, fallback, max) => {
        calls.push(["limit", fallback, max]);
        return Number(url.searchParams.get("limit") ?? fallback);
      },
      respond: (target, statusCode, body, headers) => {
        target.statusCode = statusCode;
        target.body = body;
        target.headers = headers;
      },
      adminJourneyReadService: {
        async getArrivalTimeline(window) {
          calls.push(["timeline", window]);
          return { window };
        },
        async getWorkerJourneys(options) {
          calls.push(["journeys", options]);
          return { options };
        }
      }
    })
  };
}

test("GET /admin/arrivals/timeline requires operator read capability and defaults to 48h", async () => {
  const { calls, response, route } = harness();
  assert.equal(await route({
    request: { method: "GET" },
    response,
    url: new URL("https://api.example/admin/arrivals/timeline"),
    pathname: "/admin/arrivals/timeline"
  }), true);
  assert.deepEqual(calls, [
    ["auth", { requireCapability: "ops:view" }],
    ["timeline", "48h"]
  ]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("GET /admin/worker-journeys passes wallet and bounded list arguments after operator read auth", async () => {
  const { calls, response, route } = harness();
  await route({
    request: { method: "GET" },
    response,
    url: new URL("https://api.example/admin/worker-journeys?wallet=0xabc&limit=40"),
    pathname: "/admin/worker-journeys"
  });
  assert.deepEqual(calls, [
    ["auth", { requireCapability: "ops:view" }],
    ["limit", 25, 100],
    ["journeys", { wallet: "0xabc", limit: 40 }]
  ]);
  assert.equal(response.statusCode, 200);
});

test("admin journey routes ignore unrelated paths without authenticating", async () => {
  const { calls, route } = harness();
  assert.equal(await route({
    request: { method: "GET" },
    response: {},
    url: new URL("https://api.example/admin/status"),
    pathname: "/admin/status"
  }), false);
  assert.deepEqual(calls, []);
});
