import test from "node:test";
import assert from "node:assert/strict";
import { createAdminReserveRoutes } from "./admin-reserve-routes.js";
import { getRouteCapabilityRequirements } from "../../auth/capabilities.js";
import { HTTP_METRIC_PATHS } from "./http-helpers.js";
const pathname = "/admin/ops/reserve-breakdown";
const ctx = () => ({ request: { method: "GET" }, response: {}, pathname, url: new URL(`https://example.com${pathname}`) });
const respond = (response, statusCode, body, headers) => Object.assign(response, { statusCode, body, headers });
test("ops:view authorization runs before any reserve read; denied callers get 401/403", async () => {
  for (const statusCode of [401, 403]) {
    let reads = 0;
    const route = createAdminReserveRoutes({ authMiddleware: async (_r, _u, options) => { assert.deepEqual(options, { requireCapability: "ops:view" }); throw Object.assign(Error("denied"), { statusCode }); }, reserveBreakdown: { getBreakdown: async () => { reads++; return { status: "ok" }; } }, respond });
    await assert.rejects(() => route(ctx()), e => e.statusCode === statusCode);
    assert.equal(reads, 0);
  }
});
test("admin read is no-store, unavailable is 503 and no public route aliases exist", async () => {
  for (const status of ["ok", "unavailable"]) {
    const route = createAdminReserveRoutes({ authMiddleware: async () => {}, reserveBreakdown: { getBreakdown: async () => ({ status }) }, respond });
    const context = ctx(); await route(context);
    assert.equal(context.response.statusCode, status === "ok" ? 200 : 503);
    assert.equal(context.response.headers["cache-control"], "no-store");
    for (const path of ["/reserve-breakdown", "/monitor/reserve-breakdown", "/transparency"]) assert.equal(await route({ ...ctx(), pathname: path }), false);
    assert.equal(await route({ ...ctx(), request: { method: "POST" } }), false);
  }
  assert.deepEqual(getRouteCapabilityRequirements("GET", pathname), ["ops:view"]);
  assert.ok(HTTP_METRIC_PATHS.includes(pathname));
});
