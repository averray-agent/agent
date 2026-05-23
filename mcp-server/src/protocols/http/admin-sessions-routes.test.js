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
          { id: "session-1", jobId: "job-1" },
          { id: "session-2", jobId: "job-2" },
        ];
      },
      listSessionHistory: async (options) => {
        calls.push(["listSessionHistory", options]);
        return overrides.sessionHistory ?? [
          { id: "session-3", jobId: options.jobId },
        ];
      },
    },
  });
  return { calls, response, route };
}

test("admin session routes ignore unrelated paths", async () => {
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

test("GET /admin/sessions requires admin auth and lists recent sessions", async () => {
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
      { id: "session-1", jobId: "job-1" },
      { id: "session-2", jobId: "job-2" },
    ],
    count: 2,
    limit: 50,
    scope: "operator",
  });
  assert.deepEqual(calls, [
    ["auth", { requireRole: "admin" }],
    ["parseLimit", { fallback: 50, max: 250 }],
    ["listRecentSessions", 50],
    ["respond", {
      statusCode: 200,
      body: {
        sessions: [
          { id: "session-1", jobId: "job-1" },
          { id: "session-2", jobId: "job-2" },
        ],
        count: 2,
        limit: 50,
        scope: "operator",
      },
    }],
  ]);
});

test("GET /admin/sessions preserves limit and scoped job history behavior", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/sessions?jobId=job-9&limit=17"),
    pathname: "/admin/sessions",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    sessions: [
      { id: "session-3", jobId: "job-9" },
    ],
    count: 1,
    limit: 17,
    jobId: "job-9",
    scope: "operator",
  });
  assert.deepEqual(calls.slice(1, 3), [
    ["parseLimit", { fallback: 50, max: 250 }],
    ["listSessionHistory", { jobId: "job-9", limit: 17 }],
  ]);
});

test("GET /admin/sessions treats an empty jobId like the recent-sessions view", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/sessions?jobId=&limit=3"),
    pathname: "/admin/sessions",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(Object.hasOwn(response.body, "jobId"), false);
  assert.deepEqual(calls.slice(1, 3), [
    ["parseLimit", { fallback: 50, max: 250 }],
    ["listRecentSessions", 3],
  ]);
});
