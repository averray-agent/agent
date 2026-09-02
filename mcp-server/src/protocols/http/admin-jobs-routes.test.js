import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "../../core/errors.js";
import { createAdminJobsRoutes } from "./admin-jobs-routes.js";

const AUTH = { wallet: "0xadmin", roles: ["admin"] };

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? { id: "job-1", idempotencyKey: "idem-1" };
  const route = createAdminJobsRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    buildIdempotentMutationContext: (input) => {
      calls.push(["idempotency", input]);
      return overrides.idempotency ?? {
        bucket: input.bucket,
        key: `${input.auth.wallet}:idem-1`,
        requestHash: "hash-context"
      };
    },
    buildMutationRequestHash: (input) => {
      calls.push(["hash", input]);
      return overrides.requestHash ?? "hash-1";
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["limit", { bucket, key, limits }]);
    },
    getIdempotentMutationReplay: async (context) => {
      calls.push(["replay", context]);
      return overrides.replay ?? null;
    },
    parseEventFilters: (url, options) => {
      calls.push(["eventFilters", { params: Object.fromEntries(url.searchParams), options }]);
      return overrides.eventFilters ?? { topics: ["jobs"], severity: ["info"] };
    },
    parseIdempotencyKey: (input = {}) => {
      calls.push(["parseIdempotencyKey", input]);
      return typeof input?.idempotencyKey === "string" && input.idempotencyKey.trim()
        ? input.idempotencyKey.trim()
        : undefined;
    },
    parseLimit: (url, fallback, max) => {
      calls.push(["parseLimit", { fallback, max }]);
      return Number(url.searchParams.get("limit") ?? fallback);
    },
    parsePositiveInteger: (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
      createAdminJob: async (body, options) => {
        calls.push(["createAdminJob", { body, options }]);
        return overrides.createdJob ?? { id: body.id, posterWallet: options.posterWallet };
      },
      createJob: (job) => {
        calls.push(["createJob", job]);
        return { id: job.id };
      },
      fireRecurringJob: (templateId, options) => {
        calls.push(["fireRecurringJob", { templateId, options }]);
        return overrides.derivative ?? { id: `${templateId}-run`, firedAt: options.firedAt.toISOString() };
      },
      getAdminStatus: async ({ auth }) => {
        calls.push(["getAdminStatus", auth]);
        return overrides.adminStatus ?? { ok: true, wallet: auth.wallet };
      },
      getJobLifecycleSummary: () => {
        calls.push(["getJobLifecycleSummary"]);
        return overrides.lifecycleSummary ?? { open: 1 };
      },
      getJobTimeline: async (jobId, filters) => {
        calls.push(["getJobTimeline", { jobId, filters }]);
        return overrides.timeline ?? { jobId, events: [] };
      },
      listJobsWithSessions: async (options) => {
        calls.push(["listJobsWithSessions", options]);
        return overrides.jobs ?? [{ id: "job-1" }];
      },
      pauseRecurringTemplate: async (templateId) => {
        calls.push(["pauseRecurringTemplate", templateId]);
      },
      resumeRecurringTemplate: async (templateId) => {
        calls.push(["resumeRecurringTemplate", templateId]);
      },
      updateJobLifecycle: (jobId, update) => {
        calls.push(["updateJobLifecycle", { jobId, update }]);
        return overrides.updatedJob ?? { id: jobId, ...update };
      },
    },
    storeIdempotentMutationReceipt: async (receipt) => {
      calls.push(["storeReceipt", receipt]);
    },
  });
  return { calls, response, route };
}

test("admin job routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/not-jobs"),
    pathname: "/admin/not-jobs",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /admin/jobs lists operator-visible jobs with lifecycle summary", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/admin/jobs"),
    pathname: "/admin/jobs",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    jobs: [{ id: "job-1" }],
    jobLifecycle: { open: 1 }
  });
  assert.deepEqual(calls.slice(0, 4), [
    ["auth", { requireRole: "admin" }],
    ["limit", { bucket: "admin_jobs", key: AUTH.wallet, limits: { windowMs: 10_000, max: 5 } }],
    ["listJobsWithSessions", {
      wallet: AUTH.wallet,
      includePaused: true,
      includeArchived: true,
      includeStale: true,
    }],
    ["getJobLifecycleSummary"],
  ]);
});

test("GET /admin/jobs/timeline validates jobId before reading timeline", async () => {
  const { calls, route } = makeHarness();

  await assert.rejects(
    () => route({
      request: { method: "GET" },
      response: {},
      url: new URL("http://localhost/admin/jobs/timeline"),
      pathname: "/admin/jobs/timeline",
    }),
    ValidationError
  );
  assert.ok(!calls.some(([name]) => name === "getJobTimeline"));
});

test("POST /admin/jobs creates an admin job and stores idempotent receipt", async () => {
  const { calls, response, route } = makeHarness({
    payload: { id: "job-1", title: "Fix docs", idempotencyKey: "idem-1" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/jobs"),
    pathname: "/admin/jobs",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body, { id: "job-1", posterWallet: AUTH.wallet });
  assert.ok(calls.some(([name]) => name === "createAdminJob"));
  assert.deepEqual(calls.find(([name]) => name === "storeReceipt")?.[1], {
    bucket: "admin_jobs",
    key: `${AUTH.wallet}:idem-1`,
    requestHash: "hash-1",
    response: { id: "job-1", posterWallet: AUTH.wallet },
    statusCode: 201,
  });
});

test("POST /admin/jobs forwards external schema registration metadata", async () => {
  const externalSchema = {
    schemaHash: "0x8d9f6cc5431d6f2f8ddf397c7f6c96941a9df9f733c12b94be2f6a72e1f2f3d2",
    schemaUrl: "https://schemas.example.com/agent-output.json",
    schemaIssuer: "0x1111111111111111111111111111111111111111",
    signature: "0xabcdef"
  };
  const { calls, response, route } = makeHarness({
    payload: { id: "job-1", title: "External schema job", externalSchema, idempotencyKey: "idem-1" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/jobs"),
    pathname: "/admin/jobs",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls.find(([name]) => name === "createAdminJob")?.[1].body.externalSchema, externalSchema);
});

test("POST /admin/jobs returns idempotent replay without creating another job", async () => {
  const replay = { statusCode: 200, body: { id: "job-1", replay: true } };
  const { calls, response, route } = makeHarness({ replay });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/jobs"),
    pathname: "/admin/jobs",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { id: "job-1", replay: true });
  assert.ok(!calls.some(([name]) => name === "createAdminJob"));
  assert.ok(!calls.some(([name]) => name === "storeReceipt"));
});

test("POST /admin/jobs/ingest/github replay returns before ingestion side effects", async () => {
  const replay = { statusCode: 200, body: { dryRun: true, replay: true } };
  const { calls, response, route } = makeHarness({
    payload: { query: "repo:averray-agent/agent", limit: 3, minScore: 60, dryRun: false, idempotencyKey: "idem-1" },
    replay
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/jobs/ingest/github"),
    pathname: "/admin/jobs/ingest/github",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { dryRun: true, replay: true });
  assert.deepEqual(calls.find(([name]) => name === "idempotency")?.[1].normalizedPayload, {
    query: "repo:averray-agent/agent",
    limit: 3,
    minScore: 60,
    dryRun: false,
  });
  assert.ok(!calls.some(([name]) => name === "createJob"));
});

test("POST /admin/jobs/fire validates and stores recurring derivative receipt", async () => {
  const { calls, response, route } = makeHarness({
    payload: {
      templateId: "template-1",
      firedAt: "2026-05-22T12:00:00.000Z",
      idempotencyKey: "idem-1"
    }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/jobs/fire"),
    pathname: "/admin/jobs/fire",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body, {
    id: "template-1-run",
    firedAt: "2026-05-22T12:00:00.000Z"
  });
  assert.deepEqual(calls.find(([name]) => name === "fireRecurringJob")?.[1], {
    templateId: "template-1",
    options: { firedAt: new Date("2026-05-22T12:00:00.000Z") },
  });
});

test("POST /admin/jobs/pause scopes idempotency key by wallet and template", async () => {
  const { calls, response, route } = makeHarness({
    payload: { templateId: "template-1", idempotencyKey: "idem-1" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/jobs/pause"),
    pathname: "/admin/jobs/pause",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.ok(calls.some(([name, value]) => name === "pauseRecurringTemplate" && value === "template-1"));
  assert.equal(
    calls.find(([name]) => name === "storeReceipt")?.[1].key,
    `${AUTH.wallet}:template-1:idem-1`
  );
});

test("POST /admin/jobs/lifecycle updates lifecycle and returns summary", async () => {
  const { calls, response, route } = makeHarness({
    payload: { jobId: "job-1", action: "archive", reason: "done" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/admin/jobs/lifecycle"),
    pathname: "/admin/jobs/lifecycle",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.find(([name]) => name === "updateJobLifecycle")?.[1], {
    jobId: "job-1",
    update: {
      action: "archive",
      status: undefined,
      staleAt: undefined,
      reason: "done",
    },
  });
  assert.deepEqual(response.body.jobLifecycle, { open: 1 });
});
