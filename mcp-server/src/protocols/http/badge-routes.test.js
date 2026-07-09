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

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createBadgeRoutes({
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
  assert.deepEqual(calls.map(([name]) => name), ["getBadgeDocument", "respond"]);
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
