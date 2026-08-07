import assert from "node:assert/strict";
import test from "node:test";

import { createTransparencyRoutes } from "./transparency-routes.js";

test("GET /transparency serves the complete read model without a session", async () => {
  const calls = [];
  const route = createTransparencyRoutes({
    respond: (_response, status, body, headers) => calls.push(["respond", status, body, headers]),
    transparencyService: {
      cacheTtlMs: 15_000,
      getSnapshot: async () => ({ schemaVersion: "averray.transparency.v1" })
    }
  });

  const handled = await route({
    request: { method: "GET" },
    response: {},
    pathname: "/transparency"
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, [
    [
      "respond",
      200,
      { schemaVersion: "averray.transparency.v1" },
      { "cache-control": "public, max-age=15" }
    ]
  ]);
});

// The public record page holds no session. If this route ever regains an auth
// dependency the page goes blank in production, so pin the contract: the
// factory must produce a working route from the service alone.
test("GET /transparency needs no auth dependency to be constructed", async () => {
  let responded = false;
  const route = createTransparencyRoutes({
    respond: () => { responded = true; },
    transparencyService: { getSnapshot: async () => ({}) }
  });

  assert.equal(await route({ request: { method: "GET" }, response: {}, pathname: "/transparency" }), true);
  assert.equal(responded, true);
});

test("cache-control follows the service cache TTL rather than a hardcoded value", async () => {
  const headersSeen = [];
  const route = createTransparencyRoutes({
    respond: (_response, _status, _body, headers) => headersSeen.push(headers),
    transparencyService: { cacheTtlMs: 60_000, getSnapshot: async () => ({}) }
  });

  await route({ request: { method: "GET" }, response: {}, pathname: "/transparency" });
  assert.deepEqual(headersSeen, [{ "cache-control": "public, max-age=60" }]);
});

test("/transparency is not handled for another method or path", async () => {
  let snapshotted = false;
  const route = createTransparencyRoutes({
    respond: () => {},
    transparencyService: { getSnapshot: async () => { snapshotted = true; return {}; } }
  });

  assert.equal(await route({ request: { method: "POST" }, pathname: "/transparency" }), false);
  assert.equal(await route({ request: { method: "GET" }, pathname: "/health" }), false);
  assert.equal(snapshotted, false);
});
