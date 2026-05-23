import assert from "node:assert/strict";
import test from "node:test";
import { createAdminSessionsRoutes } from "./admin-sessions-routes.js";

const AUTH = { wallet: "0xadmin", roles: ["admin"] };

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createAdminSessionsRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    parseLimit: (url, fallback, max) => {
      calls.push(["parseLimit", { fallback, max }]);
      return Number(url.searchParams.get("limit") ?? fallback);
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    service: {
      listRecentSessions: async (limit) => {
        calls.push(["listRecentSessions", limit]);
        return overrides.recentSessions ?? [
          { sessionId: "session-1", wallet: "0xworker", jobId: "job-1" }
        ];
      },
      listSessionHistory: async (options) => {
        calls.push(["listSessionHistory", options]);
        return overrides.sessionHistory ?? [
          { sessionId: "session-2", wallet: "0xworker", jobId: options.jobId }
        ];
      },
    },
  });
  return { calls, response, route };
}

test("admin sessions routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/not-sessions"),
    pathname: "/admin/not-sessions",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /admin/sessions requires admin auth and returns recent sessions", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/sessions"),
    pathname: "/admin/sessions",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    sessions: [
      { sessionId: "session-1", wallet: "0xworker", jobId: "job-1" }
    ],
    count: 1,
    limit: 50,
    scope: "operator"
  });
  assert.deepEqual(calls, [
    ["auth", { requireRole: "admin" }],
    ["parseLimit", { fallback: 50, max: 250 }],
    ["listRecentSessions", 50],
    ["respond", {
      statusCode: 200,
      body: response.body,
    }],
  ]);
});

test("GET /admin/sessions preserves limit query handling", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/sessions?limit=125"),
    pathname: "/admin/sessions",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.slice(1, 3), [
    ["parseLimit", { fallback: 50, max: 250 }],
    ["listRecentSessions", 125],
  ]);
  assert.equal(response.body.limit, 125);
});

test("GET /admin/sessions scopes to job history when jobId is present", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/sessions?jobId=job-42&limit=20"),
    pathname: "/admin/sessions",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    sessions: [
      { sessionId: "session-2", wallet: "0xworker", jobId: "job-42" }
    ],
    count: 1,
    limit: 20,
    jobId: "job-42",
    scope: "operator"
  });
  assert.deepEqual(calls.slice(1, 3), [
    ["parseLimit", { fallback: 50, max: 250 }],
    ["listSessionHistory", { jobId: "job-42", limit: 20 }],
  ]);
});

test("GET /admin/sessions treats an empty jobId query as recent-session mode", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/sessions?jobId="),
    pathname: "/admin/sessions",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.ok(!("jobId" in response.body));
  assert.deepEqual(calls.slice(1, 3), [
    ["parseLimit", { fallback: 50, max: 250 }],
    ["listRecentSessions", 50],
  ]);
});
