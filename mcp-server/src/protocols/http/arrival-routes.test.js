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
