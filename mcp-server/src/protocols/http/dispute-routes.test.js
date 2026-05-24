import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, ValidationError } from "../../core/errors.js";
import { disputeIdForSession } from "../../core/dispute-resolution.js";
import { createDisputeRoutes } from "./dispute-routes.js";

const ADMIN = "0x1111111111111111111111111111111111111111";
const WORKER = "0x2222222222222222222222222222222222222222";
const VERIFIER = "0x3333333333333333333333333333333333333333";
const SESSION = {
  sessionId: "session-dispute-1",
  jobId: "job-1",
  chainJobId: "chain-job-1",
  wallet: WORKER,
  status: "disputed",
  disputedAt: "2026-05-01T00:00:00.000Z",
  claimStake: 4,
  claimFee: 0.25,
  totalClaimLock: 4.25,
  submission: { contentHash: "0xsub" },
  verification: { outcome: "disputed" },
  statusHistory: [
    { from: "submitted", to: "disputed", at: "2026-05-01T00:00:00.000Z", reason: "verification_rejected" }
  ]
};
const JOB = {
  id: "job-1",
  title: "Review a release",
  verifierTerms: "Verify evidence.",
  rewardAmount: 12,
};

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const receipts = new Map(Object.entries(overrides.receipts ?? {}));
  const auth = overrides.auth ?? { wallet: ADMIN, claims: { roles: ["admin"] } };
  const sessions = overrides.sessions ?? [SESSION];
  const jobs = overrides.jobs ?? new Map([[JOB.id, JOB]]);
  const payload = overrides.payload ?? {};
  const gateway = overrides.gateway ?? { isEnabled: () => false };

  const routes = createDisputeRoutes({
    authMiddleware: async (request, url, options = {}) => {
      calls.push(["authMiddleware", { method: request.method, pathname: url.pathname, options }]);
      if (overrides.authError) {
        throw overrides.authError;
      }
      return auth;
    },
    buildScopedIdempotentMutationContext: (input) => {
      calls.push(["idempotencyContext", input]);
      return {
        bucket: input.bucket,
        key: `${input.auth.wallet}:${input.scope}:${input.payload?.idempotencyKey ?? "auto"}`,
        requestHash: `hash:${input.route}:${input.scope}`
      };
    },
    eventBus: {
      publish: (event) => calls.push(["publish", event])
    },
    gateway,
    getIdempotentMutationReplay: async (context) => {
      calls.push(["replay", context]);
      return overrides.replay;
    },
    hasRole: (claims, role) => Array.isArray(claims?.roles) && claims.roles.includes(role),
    parseLimit: (url, fallback, max) => {
      calls.push(["parseLimit", { fallback, max, limit: url.searchParams.get("limit") }]);
      return Number(url.searchParams.get("limit") ?? fallback);
    },
    persistContentRecord: async (record) => {
      calls.push(["persistContentRecord", record]);
      return record;
    },
    publicBaseUrl: "https://api.example.test",
    defaultVerifierAddress: VERIFIER,
    readJsonBody: async () => {
      calls.push(["readJsonBody"]);
      return payload;
    },
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    respondWithMutationReceipt: async (res, context, statusCode, body) => {
      calls.push(["respondWithMutationReceipt", { context, statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    service: {
      getJobDefinition: (jobId) => {
        calls.push(["getJobDefinition", jobId]);
        const job = jobs.get(jobId);
        if (!job) {
          throw new Error(`missing job ${jobId}`);
        }
        return job;
      },
      listRecentSessions: async (limit) => {
        calls.push(["listRecentSessions", limit]);
        return sessions;
      },
      resumeSession: async (sessionId) => {
        calls.push(["resumeSession", sessionId]);
        const session = sessions.find((candidate) => candidate.sessionId === sessionId);
        if (!session) {
          throw new Error(`missing session ${sessionId}`);
        }
        return session;
      },
    },
    stateStore: {
      getMutationReceipt: async (bucket, key) => {
        calls.push(["getMutationReceipt", { bucket, key }]);
        return receipts.get(`${bucket}:${key}`);
      },
      upsertMutationReceipt: async (bucket, key, receipt) => {
        calls.push(["upsertMutationReceipt", { bucket, key, receipt }]);
        receipts.set(`${bucket}:${key}`, receipt);
      },
      upsertSession: async (session) => {
        calls.push(["upsertSession", session]);
      },
    },
  });

  return { calls, receipts, response, route: routes.handleDisputeRoute, routes };
}

function call(route, { method = "GET", path }) {
  return route({
    request: { method },
    response: {},
    url: new URL(`http://localhost${path}`),
    pathname: path,
  });
}

test("dispute routes ignore unrelated paths and methods", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/jobs"),
    pathname: "/jobs",
  }), false);
  assert.equal(await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/disputes"),
    pathname: "/disputes",
  }), false);

  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /disputes authenticates, parses limit, and returns open and receipt-backed disputes", async () => {
  const resolvedSession = { ...SESSION, sessionId: "session-resolved", status: "resolved" };
  const resolvedId = disputeIdForSession(resolvedSession.sessionId);
  const verdictReceipt = {
    id: resolvedId,
    verdict: "dismissed",
    reasonCode: "DISPUTE_OVERTURNED",
    decidedAt: "2026-05-02T00:00:00.000Z",
    decidedBy: ADMIN
  };
  const { calls, response, route } = makeHarness({
    sessions: [SESSION, resolvedSession, { ...SESSION, sessionId: "session-quiet", status: "resolved" }],
    receipts: {
      [`dispute_verdict:${resolvedId}`]: verdictReceipt
    }
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/disputes?limit=7"),
    pathname: "/disputes",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.map((dispute) => [dispute.sessionId, dispute.status]), [
    [SESSION.sessionId, "open"],
    [resolvedSession.sessionId, "resolved"],
  ]);
  assert.equal(response.body[0].respondent, VERIFIER);
  assert.ok(calls.some(([name, detail]) => name === "parseLimit" && detail.limit === "7"));
  assert.ok(calls.some(([name]) => name === "authMiddleware"));
});

test("GET /disputes/:id rejects nested decoded ids", async () => {
  const { route } = makeHarness();

  await assert.rejects(
    call(route, { method: "GET", path: "/disputes/abc%2Fdef" }),
    (error) => error instanceof ValidationError
  );
});

test("POST /disputes/:id/verdict requires admin or verifier role before dispute lookup", async () => {
  const { calls, route } = makeHarness({
    auth: { wallet: WORKER, claims: { roles: [] } }
  });
  const id = disputeIdForSession(SESSION.sessionId);

  await assert.rejects(
    call(route, { method: "POST", path: `/disputes/${id}/verdict` }),
    (error) => error instanceof AuthorizationError && error.code === "missing_role"
  );
  assert.deepEqual(calls.map(([name]) => name), ["authMiddleware"]);
});

test("POST /disputes/:id/verdict returns idempotent replay before side effects", async () => {
  const id = disputeIdForSession(SESSION.sessionId);
  const replay = { statusCode: 200, body: { replay: true } };
  const { calls, response, route } = makeHarness({
    payload: { verdict: "dismissed", idempotencyKey: "idem-1" },
    replay
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/disputes/${id}/verdict`),
    pathname: `/disputes/${id}/verdict`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { replay: true });
  assert.ok(!calls.some(([name]) => name === "resumeSession"));
  assert.ok(!calls.some(([name]) => name === "persistContentRecord"));
  assert.ok(!calls.some(([name]) => name === "upsertMutationReceipt"));
});

test("POST /disputes/:id/verdict records a local resolution and session transition", async () => {
  const id = disputeIdForSession(SESSION.sessionId);
  const { calls, response, route } = makeHarness({
    auth: { wallet: VERIFIER, claims: { roles: ["verifier"] } },
    payload: { verdict: "dismissed", rationale: "Evidence supports the worker.", idempotencyKey: "idem-2" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/disputes/${id}/verdict`),
    pathname: `/disputes/${id}/verdict`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "resolved");
  assert.equal(response.body.verdict, "dismissed");
  assert.equal(response.body.workerPayout, JOB.rewardAmount);
  assert.equal(response.body.chainStatus, "local_only");
  assert.ok(response.body.metadataURI.startsWith("https://api.example.test/content/"));
  assert.ok(calls.some(([name]) => name === "persistContentRecord"));
  assert.ok(calls.some(([name, detail]) => name === "upsertMutationReceipt"
    && detail.bucket === "dispute_verdict"
    && detail.key === id
    && detail.receipt.reasonCode === "DISPUTE_OVERTURNED"));
  assert.ok(calls.some(([name, session]) => name === "upsertSession" && session.status === "resolved"));
  assert.ok(calls.some(([name, event]) => name === "publish" && event.topic === "dispute.verdict_recorded"));
  assert.ok(calls.some(([name]) => name === "respondWithMutationReceipt"));
});

test("POST /disputes/:id/release requires admin auth and records release", async () => {
  const id = disputeIdForSession(SESSION.sessionId);
  const { calls, response, route } = makeHarness({
    payload: { action: "return-stake", amount: 4, idempotencyKey: "idem-3" }
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL(`http://localhost/disputes/${id}/release`),
    pathname: `/disputes/${id}/release`,
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "resolved");
  assert.equal(response.body.release.action, "return-stake");
  assert.equal(response.body.release.amount, 4);
  assert.deepEqual(calls.find(([name]) => name === "authMiddleware")?.[1].options, { requireRole: "admin" });
  assert.ok(calls.some(([name, detail]) => name === "upsertMutationReceipt"
    && detail.bucket === "dispute_release"
    && detail.key === id));
  assert.ok(calls.some(([name, event]) => name === "publish" && event.topic === "settlement.stake_release_recorded"));
});
