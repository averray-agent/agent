import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationError } from "../../core/errors.js";
import { createActivityRoutes } from "./activity-routes.js";

const ALERTS = [{ id: "alert-1", title: "Review needed" }];
const AUDIT_EVENTS = [{ id: "audit-1", action: "session.claimed" }];

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createActivityRoutes({
    authMiddleware: async (request, url) => {
      calls.push(["authMiddleware", { method: request.method, pathname: url.pathname }]);
      if (overrides.authError) {
        throw overrides.authError;
      }
      return { wallet: "0xabc" };
    },
    listAlerts: async (limit) => {
      calls.push(["listAlerts", limit]);
      return overrides.alerts ?? ALERTS;
    },
    listAuditEvents: async (limit) => {
      calls.push(["listAuditEvents", limit]);
      return overrides.auditEvents ?? AUDIT_EVENTS;
    },
    parseLimit: (url, fallback, max) => {
      calls.push(["parseLimit", { fallback, max, limit: url.searchParams.get("limit") }]);
      return Number(url.searchParams.get("limit") ?? fallback);
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
  });
  return { calls, response, route };
}

test("activity routes ignore unrelated paths and methods", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/profile"),
    pathname: "/profile",
  }), false);
  assert.equal(await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/alerts"),
    pathname: "/alerts",
  }), false);

  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /alerts authenticates, parses limit, and returns alerts", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/alerts?limit=7"),
    pathname: "/alerts",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, ALERTS);
  assert.deepEqual(calls, [
    ["authMiddleware", { method: "GET", pathname: "/alerts" }],
    ["parseLimit", { fallback: 20, max: 100, limit: "7" }],
    ["listAlerts", 7],
    ["respond", { statusCode: 200, body: ALERTS, headers: {} }],
  ]);
});

test("GET /audit authenticates, parses limit, and returns audit events", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/audit?limit=42"),
    pathname: "/audit",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, AUDIT_EVENTS);
  assert.deepEqual(calls, [
    ["authMiddleware", { method: "GET", pathname: "/audit" }],
    ["parseLimit", { fallback: 100, max: 500, limit: "42" }],
    ["listAuditEvents", 42],
    ["respond", { statusCode: 200, body: AUDIT_EVENTS, headers: {} }],
  ]);
});

test("activity routes propagate auth failures before reading activity feeds", async () => {
  const authError = new AuthenticationError("No token.");
  const { calls, response, route } = makeHarness({ authError });

  await assert.rejects(
    route({
      request: { method: "GET" },
      response,
      url: new URL("http://localhost/alerts"),
      pathname: "/alerts",
    }),
    authError
  );

  assert.deepEqual(calls, [
    ["authMiddleware", { method: "GET", pathname: "/alerts" }],
  ]);
  assert.deepEqual(response, {});
});
