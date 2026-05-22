import assert from "node:assert/strict";
import test from "node:test";
import { createAdminStatusRoutes } from "./admin-status-routes.js";

const AUTH = { wallet: "0xadmin", roles: ["admin"] };

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? { reason: "manual" };
  const idempotency = overrides.idempotency ?? {
    bucket: "bootstrap_self_report_send",
    key: "0xadmin:idem-1",
    requestHash: "hash-1"
  };
  const route = createAdminStatusRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    buildIdempotentMutationContext: (input) => {
      calls.push(["idempotency", input]);
      return idempotency;
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["limit", { bucket, key, limits }]);
    },
    getIdempotentMutationReplay: async (context) => {
      calls.push(["replay", context]);
      return overrides.replay ?? null;
    },
    rateLimitConfig: { adminJobs: { windowMs: 10_000, max: 5 } },
    readJsonBody: async () => {
      calls.push(["body"]);
      return payload;
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    respondWithMutationReceipt: async (res, context, statusCode, body) => {
      calls.push(["mutationReceipt", { context, statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    service: {
      getAdminStatus: async ({ auth }) => {
        calls.push(["getAdminStatus", auth]);
        return overrides.adminStatus ?? { ok: true, auth: { wallet: auth.wallet } };
      },
      runBootstrapSelfReport: async () => {
        calls.push(["runBootstrapSelfReport"]);
        return overrides.selfReport ?? { ok: true, channel: "hermes" };
      },
    },
  });
  return { calls, response, route };
}

test("admin status routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-admin/status"),
    pathname: "/not-admin/status",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /admin/status requires admin auth and returns service status", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/status"),
    pathname: "/admin/status",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, auth: { wallet: AUTH.wallet } });
  assert.deepEqual(calls, [
    ["auth", { requireRole: "admin" }],
    ["getAdminStatus", AUTH],
    ["respond", { statusCode: 200, body: { ok: true, auth: { wallet: AUTH.wallet } } }],
  ]);
});

test("POST /admin/bootstrap-self-report/send rate-limits, idempotency-checks, then emits mutation receipt", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/bootstrap-self-report/send"),
    pathname: "/admin/bootstrap-self-report/send",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, channel: "hermes" });
  assert.deepEqual(calls, [
    ["auth", { requireRole: "admin" }],
    ["limit", { bucket: "admin_jobs", key: AUTH.wallet, limits: { windowMs: 10_000, max: 5 } }],
    ["body"],
    ["idempotency", {
      route: "/admin/bootstrap-self-report/send",
      auth: AUTH,
      payload: { reason: "manual" },
      bucket: "bootstrap_self_report_send",
    }],
    ["replay", {
      bucket: "bootstrap_self_report_send",
      key: "0xadmin:idem-1",
      requestHash: "hash-1",
    }],
    ["runBootstrapSelfReport"],
    ["mutationReceipt", {
      context: {
        bucket: "bootstrap_self_report_send",
        key: "0xadmin:idem-1",
        requestHash: "hash-1",
      },
      statusCode: 200,
      body: { ok: true, channel: "hermes" },
    }],
  ]);
});

test("POST /admin/bootstrap-self-report/send returns idempotent replay without rerunning report", async () => {
  const replay = { statusCode: 202, body: { ok: true, replay: true } };
  const { calls, response, route } = makeHarness({ replay });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/bootstrap-self-report/send"),
    pathname: "/admin/bootstrap-self-report/send",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, { ok: true, replay: true });
  assert.ok(calls.some(([name]) => name === "replay"));
  assert.ok(!calls.some(([name]) => name === "runBootstrapSelfReport"));
  assert.ok(!calls.some(([name]) => name === "mutationReceipt"));
});
