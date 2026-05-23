import assert from "node:assert/strict";
import test from "node:test";
import { NotFoundError } from "../../core/errors.js";
import { createSessionRoutes } from "./session-routes.js";

const AUTH = {
  wallet: "0x1111111111111111111111111111111111111111",
  roles: ["agent"]
};

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createSessionRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    ensureSessionOwnership: async (sessionId, wallet) => {
      calls.push(["ensureSessionOwnership", { sessionId, wallet }]);
      if (overrides.ownershipError) {
        throw overrides.ownershipError;
      }
      return overrides.session ?? { sessionId, wallet, status: "claimed" };
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    service: {
      getSessionStateMachine: () => {
        calls.push(["getSessionStateMachine"]);
        return overrides.stateMachine ?? { statuses: ["created", "claimed"] };
      },
      getSessionTimeline: async (sessionId) => {
        calls.push(["getSessionTimeline", sessionId]);
        return overrides.timeline ?? { sessionId, timeline: [{ type: "session_claimed" }] };
      },
      listSessionHistory: async (filters) => {
        calls.push(["listSessionHistory", filters]);
        return overrides.sessions ?? [{ sessionId: "session-1", ...filters }];
      },
    },
  });
  return { calls, response, route };
}

test("session routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-session"),
    pathname: "/not-session",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /session/state-machine returns public cached lifecycle definition", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/session/state-machine"),
    pathname: "/session/state-machine",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { statuses: ["created", "claimed"] });
  assert.deepEqual(response.headers, { "cache-control": "public, max-age=300" });
  assert.deepEqual(calls, [
    ["getSessionStateMachine"],
    ["respond", {
      statusCode: 200,
      body: { statuses: ["created", "claimed"] },
      headers: { "cache-control": "public, max-age=300" }
    }],
  ]);
});

test("GET /session authenticates, enforces ownership, and returns the session", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/session?sessionId=session-1"),
    pathname: "/session",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    sessionId: "session-1",
    wallet: AUTH.wallet,
    status: "claimed"
  });
  assert.deepEqual(calls.slice(0, 2), [
    ["auth", undefined],
    ["ensureSessionOwnership", { sessionId: "session-1", wallet: AUTH.wallet }],
  ]);
});

test("GET /session preserves not-found response shape", async () => {
  const { response, route } = makeHarness({
    ownershipError: new NotFoundError("Session not found.", "session_not_found")
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/session?sessionId=missing-session"),
    pathname: "/session",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    status: "not_found",
    sessionId: "missing-session"
  });
});

test("GET /session/timeline enforces ownership before loading timeline", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/session/timeline?sessionId=session-2"),
    pathname: "/session/timeline",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    sessionId: "session-2",
    timeline: [{ type: "session_claimed" }]
  });
  assert.deepEqual(calls.slice(0, 3), [
    ["auth", undefined],
    ["ensureSessionOwnership", { sessionId: "session-2", wallet: AUTH.wallet }],
    ["getSessionTimeline", "session-2"],
  ]);
});

test("GET /sessions lists wallet-scoped session history", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/sessions?limit=20&jobId=job-1"),
    pathname: "/sessions",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.slice(0, 2), [
    ["auth", undefined],
    ["listSessionHistory", { wallet: AUTH.wallet, limit: 20, jobId: "job-1" }],
  ]);
  assert.deepEqual(response.body, [
    { sessionId: "session-1", wallet: AUTH.wallet, limit: 20, jobId: "job-1" }
  ]);
});

test("GET /sessions preserves fallback limit and empty jobId behavior", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/sessions?limit=not-a-number&jobId="),
    pathname: "/sessions",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.slice(0, 2), [
    ["auth", undefined],
    ["listSessionHistory", { wallet: AUTH.wallet, limit: 8, jobId: "" }],
  ]);
});
