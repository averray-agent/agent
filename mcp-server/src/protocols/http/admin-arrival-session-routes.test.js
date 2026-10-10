import assert from "node:assert/strict";
import test from "node:test";

import { createAdminArrivalSessionRoutes } from "./admin-arrival-session-routes.js";

function routeFor(sessionTrail, authMiddleware = async () => ({ wallet: "0xabc" })) {
  const calls = [];
  const route = createAdminArrivalSessionRoutes({
    authMiddleware: async (request, url, options) => {
      calls.push(options);
      return authMiddleware(request, url, options);
    },
    parseLimit: (url, fallback) => Number(url.searchParams.get("limit") ?? fallback),
    respond: (response, status, body) => {
      response.statusCode = status;
      response.body = body;
    },
    sessionTrail
  });
  return { route, calls };
}

test("session trails require admin:status and are not public routes", async () => {
  const { route, calls } = routeFor({
    async list() { return { schemaVersion: "averray.arrival-sessions.v1", sessions: [], preAuth: { count: 0 } }; },
    async get() { return undefined; }
  });
  const response = {};
  assert.equal(await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/arrivals/sessions"),
    pathname: "/admin/arrivals/sessions"
  }), true);
  assert.deepEqual(calls[0].requireCapabilities, ["admin:status", "ops:view"]);
  assert.equal(response.statusCode, 200);
  assert.equal(await route({
    request: { method: "GET" },
    response: {},
    url: new URL("http://localhost/monitor/arrivals"),
    pathname: "/monitor/arrivals"
  }), false);
  assert.equal(await route({
    request: { method: "GET" },
    response: {},
    url: new URL("http://localhost/transparency"),
    pathname: "/transparency"
  }), false);
});

test("an unknown session is not an empty trail", async () => {
  const { route } = routeFor({
    async get() { return undefined; },
    async list() { return { unavailable: "not reported", sessions: null }; }
  });
  const missing = {};
  await route({
    request: { method: "GET" },
    response: missing,
    url: new URL("http://localhost/admin/arrivals/sessions?id=wallet%3A0xabc"),
    pathname: "/admin/arrivals/sessions"
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error, "not_found");
  const unread = {};
  await route({
    request: { method: "GET" },
    response: unread,
    url: new URL("http://localhost/admin/arrivals/sessions"),
    pathname: "/admin/arrivals/sessions"
  });
  assert.equal(unread.statusCode, 503);
  assert.equal(unread.body.sessions, null);
});
