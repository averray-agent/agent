import assert from "node:assert/strict";
import test from "node:test";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { createBadgeRoutes, createListBadgeReceipts } from "./badge-routes.js";

const SESSION = { sessionId: "session-1", jobId: "job-1" };
const JOB = { id: "job-1", title: "Demo job" };
const VERIFICATION = { outcome: "approved" };
const SIGNERS = [
  {
    role: "operator",
    wallet: "0x1111111111111111111111111111111111111111",
    at: "2026-04-16T14:00:00.000Z",
    status: "posted",
  },
  {
    role: "verifier",
    wallet: "0x2222222222222222222222222222222222222222",
    at: "2026-04-16T14:29:00.000Z",
    status: "signed",
  },
  {
    role: "worker",
    wallet: "0x3333333333333333333333333333333333333333",
    at: "2026-04-16T14:12:00.000Z",
    status: "submitted",
  },
];
const BADGE = { schemaVersion: "averray.agent-badge.v1", sessionId: "session-1", signers: SIGNERS };
const RECEIPTS = [{ sessionId: "session-1", badgeHash: "0xabc", signers: SIGNERS }];
const STORED_BADGE = {
  averray: {
    sessionId: "session-pruned",
    jobId: "job-pruned",
    worker: "0x3333333333333333333333333333333333333333",
    completedAt: "2026-04-16T14:29:00.000Z",
    evidenceHash: "0xabc",
    chainJobId: "0xdef"
  },
  signers: SIGNERS
};
const STORED_RUN_RECEIPT = {
  schemaVersion: "averray.run-receipt.v1",
  kind: "run",
  sessionId: "session-pruned",
  jobId: "job-pruned",
  worker: "0x3333333333333333333333333333333333333333",
  verdict: {
    outcome: "rejected",
    reasonCode: "BENCHMARK_THRESHOLD_MISSED",
    evidenceHash: "0xabc",
    policyTags: []
  },
  timestamps: { verifiedAt: "2026-04-16T14:29:00.000Z" },
  signers: SIGNERS,
  canonicalUrl: "https://api.averray.com/badges/session-pruned/run"
};

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createBadgeRoutes({
    badgeReceiptSigner: overrides.badgeReceiptSigner,
    buildBadgeFromSession: (input) => {
      calls.push(["buildBadgeFromSession", input]);
      if (overrides.badgeError) {
        throw overrides.badgeError;
      }
      return overrides.badge ?? BADGE;
    },
    deriveBadgeLineage: (session, job) => {
      calls.push(["deriveBadgeLineage", { session, job }]);
      return overrides.lineage ?? { parent: { sessionId: "parent-1" } };
    },
    listBadgeReceipts: async (limit) => {
      calls.push(["listBadgeReceipts", limit]);
      return overrides.receipts ?? RECEIPTS;
    },
    parseLimit: (url, fallback, max) => {
      calls.push(["parseLimit", { fallback, max }]);
      return Number(url.searchParams.get("limit") ?? fallback);
    },
    publicBaseUrl: "https://averray.com",
    posterAddress: "0xposter",
    respond: (res, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      res.statusCode = statusCode;
      res.body = body;
      res.headers = headers;
    },
    service: {
      resumeSession: async (sessionId) => {
        calls.push(["resumeSession", sessionId]);
        if (overrides.resumeError) {
          throw overrides.resumeError;
        }
        return overrides.session ?? SESSION;
      },
      getJobDefinition: (jobId) => {
        calls.push(["getJobDefinition", jobId]);
        if (overrides.jobError) {
          throw overrides.jobError;
        }
        return overrides.job ?? JOB;
      },
    },
    stateStore: overrides.stateStore,
    verifierAddress: "0xverifier",
    verifierService: {
      getResult: async (sessionId) => {
        calls.push(["getResult", sessionId]);
        return overrides.verification ?? VERIFICATION;
      },
    },
  });
  return { calls, response, route };
}

test("badge routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-badges"),
    pathname: "/not-badges",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /.well-known/badge-receipt-jwks.json publishes the receipt verification key", async () => {
  const jwks = { keys: [{ kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid: "badge-1", x: "x", y: "y" }] };
  const { calls, response, route } = makeHarness({
    badgeReceiptSigner: { getJwks: () => jwks }
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/.well-known/badge-receipt-jwks.json"),
    pathname: "/.well-known/badge-receipt-jwks.json"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, jwks);
  assert.deepEqual(calls.at(-1), ["respond", {
    statusCode: 200,
    body: jwks,
    headers: { "cache-control": "public, max-age=300" }
  }]);
});

test("GET /badges parses limit and returns cached receipts", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges?limit=17"),
    pathname: "/badges",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, RECEIPTS);
  assert.deepEqual(response.body[0].signers.map((signer) => signer.role), ["operator", "verifier", "worker"]);
  assert.ok(response.body[0].signers.every((signer) => signer.at && !/^0x0{40}$/u.test(signer.wallet)));
  assert.deepEqual(calls, [
    ["parseLimit", { fallback: 100, max: 500 }],
    ["listBadgeReceipts", 17],
    ["respond", {
      statusCode: 200,
      body: RECEIPTS,
      headers: { "cache-control": "public, max-age=30" },
    }],
  ]);
});

test("GET /badges/:sessionId builds public badge metadata", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-1"),
    pathname: "/badges/session-1",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, BADGE);
  assert.equal("signature" in response.body, false, "unconfigured test mode must remain honestly unsigned");
  assert.deepEqual(response.body.signers, SIGNERS);
  assert.ok(response.body.signers.every((signer) => signer.at && !/^0x0{40}$/u.test(signer.wallet)));
  assert.deepEqual(calls, [
    ["resumeSession", "session-1"],
    ["getResult", "session-1"],
    ["getJobDefinition", "job-1"],
    ["deriveBadgeLineage", { session: SESSION, job: JOB }],
    ["buildBadgeFromSession", {
      session: SESSION,
      job: JOB,
      verification: VERIFICATION,
      context: {
        publicBaseUrl: "https://averray.com",
        posterAddress: "0xposter",
        verifierAddress: "0xverifier",
        lineage: { parent: { sessionId: "parent-1" } },
      },
    }],
    ["respond", {
      statusCode: 200,
      body: BADGE,
      headers: { "cache-control": "public, max-age=60" },
    }],
  ]);
});

test("GET /badges/:sessionId decodes the session id", async () => {
  const { calls, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response: {},
    url: new URL("http://localhost/badges/session%2Fencoded"),
    pathname: "/badges/session%2Fencoded",
  });

  assert.equal(handled, true);
  assert.deepEqual(calls[0], ["resumeSession", "session/encoded"]);
});

test("GET /badges/ rejects an empty session id", async () => {
  const { response, route } = makeHarness();

  await assert.rejects(
    route({
      request: { method: "GET" },
      response,
      url: new URL("http://localhost/badges/"),
      pathname: "/badges/",
    }),
    (error) => error instanceof ValidationError
      && error.message === "sessionId path segment is required."
  );
});

test("GET /badges/:sessionId returns not_found for missing sessions", async () => {
  const { calls, response, route } = makeHarness({
    resumeError: new NotFoundError("Session missing.", "session_not_found"),
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/missing-session"),
    pathname: "/badges/missing-session",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", sessionId: "missing-session" });
  assert.deepEqual(calls, [
    ["resumeSession", "missing-session"],
    ["respond", {
      statusCode: 404,
      body: { status: "not_found", sessionId: "missing-session" },
      headers: {},
    }],
  ]);
});

test("GET /badges/:sessionId returns not_ready when badge construction says so", async () => {
  const { response, route } = makeHarness({
    badgeError: new NotFoundError("Badge not ready.", "badge_not_ready"),
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-1"),
    pathname: "/badges/session-1",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    status: "not_ready",
    sessionId: "session-1",
    reason: "Badge not ready.",
  });
});

test("GET /badges/:sessionId serves the immutable document after its job is pruned", async () => {
  const { calls, response, route } = makeHarness({
    stateStore: {
      getBadgeDocument: async (sessionId) => {
        calls.push(["getBadgeDocument", sessionId]);
        return STORED_BADGE;
      }
    }
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-pruned"),
    pathname: "/badges/session-pruned"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, STORED_BADGE);
  assert.equal("signature" in response.body, false);
  assert.deepEqual(calls.map(([name]) => name), ["getBadgeDocument", "respond"]);
});

test("GET /badges/:sessionId returns the persisted receipt signature", async () => {
  const signature = { alg: "ES256", kid: "badge-1", sig: "protected..signature", signedAt: "2026-07-11T00:00:00.000Z" };
  const signedBadge = { ...STORED_BADGE, signature };
  const { response, route } = makeHarness({
    stateStore: { getBadgeDocument: async () => signedBadge }
  });

  await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-pruned"),
    pathname: "/badges/session-pruned"
  });

  assert.deepEqual(response.body.signature, signature);
});

test("GET /badges/:sessionId/run serves the immutable run receipt after job pruning", async () => {
  const signature = { alg: "ES256", kid: "badge-1", sig: "protected..signature", signedAt: "2026-07-12T00:00:00.000Z" };
  const signedRunReceipt = { ...STORED_RUN_RECEIPT, signature };
  const { calls, response, route } = makeHarness({
    jobError: new Error("Unknown job"),
    stateStore: { getRunReceiptDocument: async (sessionId) => {
      calls.push(["getRunReceiptDocument", sessionId]);
      return signedRunReceipt;
    } }
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/session-pruned/run"),
    pathname: "/badges/session-pruned/run"
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, signedRunReceipt);
  assert.deepEqual(calls.map(([name]) => name), ["getRunReceiptDocument", "respond"]);
});

test("GET /badges/:sessionId/run returns not_found when no verdict receipt exists", async () => {
  const { response, route } = makeHarness({
    stateStore: { getRunReceiptDocument: async () => undefined }
  });

  await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/badges/never-claimed/run"),
    pathname: "/badges/never-claimed/run"
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", kind: "run", sessionId: "never-claimed" });
});

test("listBadgeReceipts exposes a persisted signature on the row and nested document", async () => {
  const signature = { alg: "ES256", kid: "badge-1", sig: "protected..signature", signedAt: "2026-07-11T00:00:00.000Z" };
  const signedBadge = { ...STORED_BADGE, signature };
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: () => { throw new Error("must not rebuild"); },
    deriveBadgeLineage: () => undefined,
    service: { listRecentSessions: async () => [{ sessionId: "session-pruned", jobId: "job-pruned" }] },
    stateStore: { getBadgeDocument: async () => signedBadge },
    verifierService: { getResult: async () => VERIFICATION }
  });

  const [receipt] = await listBadgeReceipts(100);
  assert.deepEqual(receipt.signature, signature);
  assert.deepEqual(receipt.badge.signature, signature);
});

test("listBadgeReceipts emits run and badge rows for an approved session", async () => {
  const runSignature = { alg: "ES256", kid: "badge-1", sig: "run..signature", signedAt: "2026-07-12T00:00:00.000Z" };
  const badgeSignature = { alg: "ES256", kid: "badge-1", sig: "badge..signature", signedAt: "2026-07-12T00:00:01.000Z" };
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: () => { throw new Error("must not rebuild"); },
    deriveBadgeLineage: () => undefined,
    service: { listRecentSessions: async () => [{ sessionId: "session-pruned", jobId: "job-pruned" }] },
    stateStore: {
      getRunReceiptDocument: async () => ({
        ...STORED_RUN_RECEIPT,
        verdict: { ...STORED_RUN_RECEIPT.verdict, outcome: "approved", reasonCode: "OK" },
        signature: runSignature
      }),
      getBadgeDocument: async () => ({ ...STORED_BADGE, signature: badgeSignature })
    },
    verifierService: { getResult: async () => VERIFICATION }
  });

  const receipts = await listBadgeReceipts(100);
  assert.deepEqual(receipts.map((receipt) => receipt.kind), ["run", "badge"]);
  assert.equal(receipts[0].verdict, "approved");
  assert.deepEqual(receipts[0].signature, runSignature);
  assert.deepEqual(receipts[1].signature, badgeSignature);
});

test("listBadgeReceipts emits only a run row for a rejected session", async () => {
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: () => { throw new NotFoundError("No badge", "badge_not_ready"); },
    deriveBadgeLineage: () => undefined,
    service: {
      listRecentSessions: async () => [{ sessionId: "session-pruned", jobId: "job-pruned", status: "rejected" }],
      getJobDefinition: () => { throw new Error("Unknown job"); }
    },
    stateStore: {
      getRunReceiptDocument: async () => STORED_RUN_RECEIPT,
      getBadgeDocument: async () => undefined
    },
    verifierService: { getResult: async () => ({ outcome: "rejected" }) }
  });

  const receipts = await listBadgeReceipts(100);
  assert.deepEqual(receipts.map((receipt) => receipt.kind), ["run"]);
  assert.equal(receipts[0].verdict, "rejected");
});

test("listBadgeReceipts includes a stored badge without looking up its pruned job", async () => {
  let jobLookups = 0;
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: () => {
      throw new Error("stored badges must not rebuild");
    },
    deriveBadgeLineage: () => undefined,
    service: {
      listRecentSessions: async () => [{ sessionId: "session-pruned", jobId: "job-pruned" }],
      getJobDefinition: () => {
        jobLookups += 1;
        throw new Error("Unknown job");
      }
    },
    stateStore: {
      getBadgeDocument: async () => STORED_BADGE
    },
    verifierService: { getResult: async () => VERIFICATION }
  });

  const receipts = await listBadgeReceipts(100);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].sessionId, "session-pruned");
  assert.deepEqual(receipts[0].badge, STORED_BADGE);
  assert.equal(jobLookups, 0);
});

test("listBadgeReceipts isolates a row whose job lookup cannot be rebuilt", async () => {
  const sessions = [
    { sessionId: "session-pruned", jobId: "job-pruned" },
    { sessionId: "session-live", jobId: "job-live" }
  ];
  const listBadgeReceipts = createListBadgeReceipts({
    buildBadgeFromSession: ({ session, job }) => {
      if (!job) throw new Error("missing job facts");
      return {
        averray: {
          sessionId: session.sessionId,
          jobId: session.jobId,
          worker: "0x3333333333333333333333333333333333333333"
        },
        signers: SIGNERS
      };
    },
    deriveBadgeLineage: () => undefined,
    service: {
      listRecentSessions: async () => sessions,
      getJobDefinition: (jobId) => {
        if (jobId === "job-pruned") throw new Error("Unknown job");
        return JOB;
      }
    },
    stateStore: {
      getBadgeDocument: async () => undefined,
      putBadgeDocument: async (_sessionId, badge) => badge
    },
    verifierService: { getResult: async () => VERIFICATION }
  });

  const receipts = await listBadgeReceipts(100);
  assert.deepEqual(receipts.map((receipt) => receipt.sessionId), ["session-live"]);
});
