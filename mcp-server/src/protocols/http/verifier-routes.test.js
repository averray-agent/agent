import assert from "node:assert/strict";
import test from "node:test";
import { createVerifierRoutes } from "./verifier-routes.js";

const AUTH = { wallet: "0xverifier", roles: ["verifier"] };

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const payload = overrides.payload ?? {
    sessionId: " session-1 ",
    evidence: "evidence-from-body",
    metadataURI: " ipfs://body-metadata ",
  };
  const route = createVerifierRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["auth", options]);
      return overrides.auth ?? AUTH;
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["enforceLimit", { bucket, key, limits }]);
    },
    rateLimitConfig: {
      verifierRun: overrides.verifierRunLimit ?? { windowMs: 1000, max: 5 },
    },
    readJsonBody: async () => {
      calls.push(["body"]);
      return payload;
    },
    respond: (res, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      res.statusCode = statusCode;
      res.body = body;
    },
    verifierService: {
      listHandlers: () => {
        calls.push(["listHandlers"]);
        return overrides.handlers ?? [{ id: "deterministic" }];
      },
      getResult: async (sessionId) => {
        calls.push(["getResult", sessionId]);
        return overrides.result;
      },
      listPendingVerifications: async (opts) => {
        calls.push(["listPendingVerifications", opts]);
        return overrides.pending ?? { pending: [], count: 0, scanned: 0, window: 200 };
      },
      replayVerification: async (sessionId) => {
        calls.push(["replayVerification", sessionId]);
        return overrides.replay ?? { status: "replayed", sessionId };
      },
      verifySubmission: async (input) => {
        calls.push(["verifySubmission", input]);
        return overrides.verification ?? { status: "approved", ...input };
      },
    },
  });
  return { calls, response, route };
}

test("verifier routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/verifier/not-here"),
    pathname: "/verifier/not-here",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("GET /verifier/handlers returns public handler metadata without auth", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/verifier/handlers"),
    pathname: "/verifier/handlers",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { handlers: [{ id: "deterministic" }] });
  assert.deepEqual(calls, [
    ["listHandlers"],
    ["respond", { statusCode: 200, body: { handlers: [{ id: "deterministic" }] } }],
  ]);
});

test("GET /verifier/result returns a stored result or not_found fallback", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/verifier/result?sessionId=session-2"),
    pathname: "/verifier/result",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: "not_found" });
  assert.deepEqual(calls, [
    ["getResult", "session-2"],
    ["respond", { statusCode: 200, body: { status: "not_found" } }],
  ]);
});

test("POST /verifier/replay authenticates, rate limits, and trims body sessionId", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/verifier/replay?sessionId=query-session"),
    pathname: "/verifier/replay",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: "replayed", sessionId: "session-1" });
  assert.deepEqual(calls, [
    ["auth", { requireRole: "verifier" }],
    ["enforceLimit", {
      bucket: "verifier_run",
      key: "0xverifier",
      limits: { windowMs: 1000, max: 5 },
    }],
    ["body"],
    ["replayVerification", "session-1"],
    ["respond", {
      statusCode: 200,
      body: { status: "replayed", sessionId: "session-1" },
    }],
  ]);
});

test("POST /verifier/replay falls back to query sessionId", async () => {
  const { calls, response, route } = makeHarness({
    payload: { sessionId: " " },
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/verifier/replay?sessionId=query-session"),
    pathname: "/verifier/replay",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.find(([name]) => name === "replayVerification"), [
    "replayVerification",
    "query-session",
  ]);
});

test("POST /verifier/run preserves body precedence for session, evidence, and metadata", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/verifier/run?sessionId=query-session&evidence=query-evidence&metadataURI=ipfs://query"),
    pathname: "/verifier/run",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    status: "approved",
    sessionId: "session-1",
    evidence: "evidence-from-body",
    metadataURI: "ipfs://body-metadata",
  });
  assert.deepEqual(calls.slice(0, 4), [
    ["auth", { requireRole: "verifier" }],
    ["enforceLimit", {
      bucket: "verifier_run",
      key: "0xverifier",
      limits: { windowMs: 1000, max: 5 },
    }],
    ["body"],
    ["verifySubmission", {
      sessionId: "session-1",
      evidence: "evidence-from-body",
      metadataURI: "ipfs://body-metadata",
    }],
  ]);
});

test("POST /verifier/run preserves query fallbacks and default metadata URI", async () => {
  const { calls, response, route } = makeHarness({
    payload: {
      sessionId: "",
    },
  });

  const handled = await route({
    request: { method: "POST" },
    response,
    url: new URL("http://localhost/verifier/run?sessionId=query-session&evidence=query-evidence"),
    pathname: "/verifier/run",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.find(([name]) => name === "verifySubmission"), [
    "verifySubmission",
    {
      sessionId: "query-session",
      evidence: "query-evidence",
      metadataURI: "ipfs://pending-badge",
    },
  ]);
});

test("GET /verifier/pending requires the verifier role and returns the pending queue", async () => {
  const pending = {
    pending: [{ sessionId: "s1", jobId: "job", wallet: "0xw", verifierMode: "benchmark" }],
    count: 1,
    scanned: 3,
    window: 200,
  };
  const { calls, response, route } = makeHarness({ pending });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/verifier/pending?limit=10"),
    pathname: "/verifier/pending",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, pending);
  // Auth was enforced with the verifier-role requirement...
  const authCall = calls.find((entry) => entry[0] === "auth");
  assert.deepEqual(authCall[1], { requireRole: "verifier" });
  // ...and the parsed limit was passed through to the service.
  const listCall = calls.find((entry) => entry[0] === "listPendingVerifications");
  assert.deepEqual(listCall[1], { limit: 10 });
});

test("GET /verifier/pending clamps an oversized limit and defaults a bad one", async () => {
  const big = makeHarness();
  await big.route({
    request: { method: "GET" },
    response: big.response,
    url: new URL("http://localhost/verifier/pending?limit=9999"),
    pathname: "/verifier/pending",
  });
  assert.deepEqual(big.calls.find((e) => e[0] === "listPendingVerifications")[1], { limit: 200 });

  const bad = makeHarness();
  await bad.route({
    request: { method: "GET" },
    response: bad.response,
    url: new URL("http://localhost/verifier/pending?limit=abc"),
    pathname: "/verifier/pending",
  });
  assert.deepEqual(bad.calls.find((e) => e[0] === "listPendingVerifications")[1], { limit: 50 });
});
