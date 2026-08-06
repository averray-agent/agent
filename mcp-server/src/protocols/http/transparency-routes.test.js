import assert from "node:assert/strict";
import test from "node:test";

import { createTransparencyRoutes } from "./transparency-routes.js";

test("GET /transparency requires operator scope and returns the complete read model", async () => {
  const calls = [];
  const route = createTransparencyRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return { wallet: "0xoperator" };
    },
    respond: (_response, status, body) => calls.push(["respond", status, body]),
    transparencyService: {
      getSnapshot: async () => ({ schemaVersion: "averray.transparency.v1" })
    }
  });

  const handled = await route({
    request: { method: "GET" },
    response: {},
    url: new URL("https://api.averray.com/transparency"),
    pathname: "/transparency"
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, [
    ["auth", { requireCapability: "ops:view" }],
    ["respond", 200, { schemaVersion: "averray.transparency.v1" }]
  ]);
});

test("/transparency is not handled for another method or path", async () => {
  let authed = false;
  const route = createTransparencyRoutes({
    authMiddleware: async () => { authed = true; },
    respond: () => {},
    transparencyService: { getSnapshot: async () => ({}) }
  });

  assert.equal(await route({ request: { method: "POST" }, pathname: "/transparency" }), false);
  assert.equal(await route({ request: { method: "GET" }, pathname: "/health" }), false);
  assert.equal(authed, false);
});
