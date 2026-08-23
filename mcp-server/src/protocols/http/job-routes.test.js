import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError, ValidationError } from "../../core/errors.js";
import { createJobRoutes } from "./job-routes.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const HUB_ASSET_CONTEXT = {
  symbol: "USDC",
  chain: "eip155:420420419",
  chainName: "Polkadot Hub",
  assetId: 1337,
  token: "0x0000053900000000000000000000000001200000"
};

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const auth = overrides.auth ?? { wallet: WALLET, claims: { roles: ["agent"] } };
  const payload = overrides.payload ?? {};
  const service = {
    listJobsWithSessions: async (filters) => {
      calls.push(["listJobsWithSessions", filters]);
      return overrides.jobs ?? [{ id: "job-1", title: "Job 1", lifecycle: { state: "open" } }];
    },
    getPublicJobDefinition: async (jobId, options) => {
      calls.push(["getPublicJobDefinition", { jobId, options }]);
      return overrides.definition ?? { id: jobId, wallet: options.wallet };
    },
    recommendJobs: async (wallet) => {
      calls.push(["recommendJobs", wallet]);
      return overrides.recommendations ?? [{ id: "job-1" }];
    },
    preflightJob: async (wallet, jobId) => {
      calls.push(["preflightJob", { wallet, jobId }]);
      return overrides.preflight ?? { wallet, jobId, claimable: true };
    },
    explainEligibility: async (wallet, jobId) => {
      calls.push(["explainEligibility", { wallet, jobId }]);
      return overrides.eligibility ?? { wallet, jobId, eligible: true };
    },
    estimateNetReward: async (wallet, jobId) => {
      calls.push(["estimateNetReward", { wallet, jobId }]);
      return overrides.reward ?? { wallet, jobId, netReward: 1 };
    },
    listSubJobs: async (parentSessionId) => {
      calls.push(["listSubJobs", parentSessionId]);
      return overrides.subJobs ?? [{ id: "sub-1", parentSessionId }];
    },
    createSubJob: async (parentSessionId, wallet, requestPayload) => {
      calls.push(["createSubJob", { parentSessionId, wallet, payload: requestPayload }]);
      return overrides.createdSubJob ?? { id: "sub-1", parentSessionId, wallet };
    },
    claimJob: async (wallet, jobId, protocol, idempotencyKey, claimContext) => {
      calls.push(["claimJob", {
        wallet,
        jobId,
        protocol,
        idempotencyKey,
        ...(claimContext === undefined ? {} : { claimContext })
      }]);
      return overrides.claim ?? { sessionId: "session-1", wallet, jobId, protocol, idempotencyKey };
    },
    validateJobSubmission: (jobId, submission) => {
      calls.push(["validateJobSubmission", { jobId, submission }]);
      return overrides.validation ?? { valid: true, jobId, submission };
    },
    submitWork: async (sessionId, protocol, submission) => {
      calls.push(["submitWork", { sessionId, protocol, submission }]);
      return overrides.submit ?? { sessionId, protocol, submission };
    },
    ...overrides.service,
  };
  const route = createJobRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(options === undefined ? ["authMiddleware"] : ["authMiddleware", options]);
      if (overrides.authError) throw overrides.authError;
      return auth;
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["enforceLimit", { bucket, key, limits }]);
    },
    ensureSessionOwnership: async (sessionId, wallet) => {
      calls.push(["ensureSessionOwnership", { sessionId, wallet }]);
      return overrides.session ?? { sessionId, wallet };
    },
    eventBus: overrides.eventBus,
    externalPostingService: overrides.externalPostingService,
    posterOnboardingService: overrides.posterOnboardingService,
    rateLimitConfig: { adminJobs: { max: 1, windowMs: 1000 } },
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
    service,
    verifyCanaryMarker: overrides.verifyCanaryMarker,
  });

  return { calls, response, route };
}

function invoke(route, { method = "GET", path, response = {}, headers = {} }) {
  return route({
    request: { method, headers },
    response,
    url: new URL(`http://localhost${path}`),
    pathname: path.split("?")[0],
  });
}

test("job routes ignore unrelated paths", async () => {
  const { calls, response, route } = makeHarness();

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/not-jobs"),
    pathname: "/not-jobs",
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(response, {});
});

test("preflight appends only a wallet-bound verdict summary to journey telemetry", async () => {
  const events = [];
  const { route } = makeHarness({
    preflight: {
      eligible: true,
      reason: "eligible",
      claimable: true,
      claimFundingSufficient: true,
      privatePayload: { mustNotPersist: true }
    },
    eventBus: { publish: (event) => events.push(event) }
  });

  await invoke(route, { method: "GET", path: "/jobs/preflight?jobId=job-42" });
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "journey.preflight_completed");
  assert.equal(events[0].wallet, WALLET);
  assert.deepEqual(events[0].data, {
    jobId: "job-42",
    eligible: true,
    reason: "eligible",
    claimable: true,
    claimFundingSufficient: true
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /mustNotPersist|privatePayload/u);
});

test("GET /jobs/open redirects to the canonical public collection before per-id matching", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { path: "/jobs/open", response }), true);
  assert.equal(response.statusCode, 301);
  assert.equal(response.headers.location, "/jobs");
  assert.deepEqual(response.body, { redirect: "/jobs" });
  assert.deepEqual(calls, [["respond", {
    statusCode: 301,
    body: { redirect: "/jobs" },
    headers: { location: "/jobs" }
  }]]);
});

test("GET /jobs/:id/estimate is the authenticated path twin of estimateNetReward", async () => {
  const reward = {
    jobId: "job/with spaces",
    grossReward: { asset: "USDC", amount: 0.25 },
    netReward: { asset: "USDC", amount: 0.2 }
  };
  const { calls, response, route } = makeHarness({ reward });

  assert.equal(await invoke(route, {
    path: "/jobs/job%2Fwith%20spaces/estimate",
    response,
    headers: { authorization: "Bearer token" }
  }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ...reward, assetContext: HUB_ASSET_CONTEXT });
  assert.deepEqual(calls.slice(0, 3), [
    ["authMiddleware"],
    ["estimateNetReward", { wallet: WALLET, jobId: "job/with spaces" }],
    ["respond", { statusCode: 200, body: { ...reward, assetContext: HUB_ASSET_CONTEXT }, headers: {} }]
  ]);
  assert.equal(calls.some(([name]) => name === "listJobsWithSessions"), false);
});

test("GET /jobs/:id/estimate requires wallet authentication", async () => {
  const { route } = makeHarness({
    authError: new AuthenticationError("Authentication required.", "missing_token")
  });
  await assert.rejects(
    invoke(route, { path: "/jobs/job-1/estimate" }),
    (error) => error instanceof AuthenticationError && error.statusCode === 401
  );
});

test("GET /jobs lists live session-joined jobs and preserves response builder shape", async () => {
  const { calls, response, route } = makeHarness({
    jobs: [{ id: "job-1", title: "Job 1", lifecycle: { state: "open" }, category: "coding" }],
  });

  const handled = await route({
    request: { method: "GET" },
    response,
    url: new URL("http://localhost/jobs?wallet=0xabc&format=full"),
    pathname: "/jobs",
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.slice(0, 2), [
    ["listJobsWithSessions", { wallet: "0xabc" }],
    ["respond", { statusCode: 200, body: response.body, headers: {} }],
  ]);
  assert.deepEqual(response.body, [{
    id: "job-1",
    title: "Job 1",
    lifecycle: { state: "open" },
    category: "coding",
    listedAt: null,
    assetContext: HUB_ASSET_CONTEXT
  }]);
});

test("GET /jobs keeps every row while since adds strict returner freshness metadata", async () => {
  const { response, route } = makeHarness({
    jobs: [{
      id: "boundary",
      title: "Boundary",
      lifecycle: { state: "open", createdAt: "2026-08-21T12:00:00.000Z" }
    }, {
      id: "newer",
      title: "Newer",
      lifecycle: { state: "open", createdAt: "2026-08-21T12:00:00.001Z" }
    }]
  });

  assert.equal(await invoke(route, {
    path: `/jobs?limit=100&since=${Date.parse("2026-08-21T12:00:00.000Z")}`,
    response
  }), true);
  assert.equal(response.body.jobs.length, 2);
  assert.deepEqual(response.body.jobs.map((job) => job.listedAt), [
    "2026-08-21T12:00:00.000Z",
    "2026-08-21T12:00:00.001Z"
  ]);
  assert.deepEqual(response.body.meta, { newSince: 1 });
});

test("GET /jobs applies the external projection boundary before source filtering", async () => {
  const external = {
    id: "external-1",
    title: "External",
    category: "coding",
    source: { type: "external" },
    lifecycle: { state: "open" }
  };
  const curated = {
    id: "curated-1",
    title: "Curated",
    category: "coding",
    lifecycle: { state: "open" }
  };
  const { response, route } = makeHarness({
    jobs: [external, curated],
    externalPostingService: {
      async filterExternalCatalogProjection(jobs) {
        return jobs.filter((job) => job.id !== "external-1");
      }
    }
  });

  assert.equal(await invoke(route, {
    path: "/jobs?source=external",
    response
  }), true);
  assert.equal(response.body.total, 0);
  assert.deepEqual(response.body.jobs, []);
});

test("GET /jobs carries the live external claim-bond estimate in full and compact rows", async () => {
  const external = {
    id: "external-1",
    title: "External",
    rewardAmount: 1,
    rewardAsset: "USDC",
    category: "coding",
    source: { type: "external", poster: { wallet: WALLET } },
    lifecycle: { state: "open" }
  };
  const claimBond = {
    available: true,
    stakeRaw: "100000",
    stakeBps: 1000,
    feeRaw: "50000",
    feeBps: 500
  };
  const { response, route } = makeHarness({
    jobs: [external],
    externalPostingService: {
      async filterExternalCatalogProjection(jobs) {
        return jobs;
      }
    },
    posterOnboardingService: {
      async enrichExternalCatalogRows(jobs) {
        return jobs.map((job) => ({ ...job, claimBond }));
      }
    }
  });

  assert.equal(await invoke(route, { path: "/jobs", response }), true);
  assert.deepEqual(response.body[0].claimBond, claimBond);
  assert.equal(response.body[0].source.poster.wallet, WALLET);

  const compactResponse = {};
  assert.equal(await invoke(route, {
    path: "/jobs?source=external",
    response: compactResponse
  }), true);
  assert.deepEqual(compactResponse.body.jobs[0].claimBond, claimBond);
  assert.equal(compactResponse.body.jobs[0].source, "external");
  assert.equal(compactResponse.body.jobs[0].poster.wallet, WALLET);
});

test("GET /jobs/:id serves a listed job with the collection-identical public projection", async () => {
  const listed = {
    id: "job-1",
    title: "Job 1",
    category: "coding",
    lifecycle: { state: "open" }
  };
  const addMetadata = async (jobs) => jobs.map((job) => ({
    ...job,
    listingStatus: "listed",
    contentTrust: "operator-curated"
  }));
  const { route } = makeHarness({
    jobs: [listed],
    service: { addListingSecurityMetadata: addMetadata }
  });
  const collectionResponse = {};
  const detailResponse = {};

  assert.equal(await invoke(route, { path: "/jobs", response: collectionResponse }), true);
  assert.equal(await invoke(route, { path: "/jobs/job-1", response: detailResponse }), true);

  assert.equal(detailResponse.statusCode, 200);
  assert.deepEqual(detailResponse.body, collectionResponse.body[0]);
});

test("GET /jobs/:id returns the generic 404 shape for a nonexistent job", async () => {
  const { response, route } = makeHarness();

  assert.equal(await invoke(route, { path: "/jobs/missing-job", response }), true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: "not_found" });
});

test("GET /jobs/:id keeps an existing but non-public job indistinguishable from nonexistent", async () => {
  const hidden = {
    id: "internal-job",
    title: "Internal",
    lifecycle: { state: "open" }
  };
  const { route } = makeHarness({
    jobs: [hidden],
    externalPostingService: {
      async filterExternalCatalogProjection(jobs) {
        return jobs.filter((job) => job.id !== hidden.id);
      }
    }
  });
  const hiddenResponse = {};
  const missingResponse = {};

  assert.equal(await invoke(route, { path: "/jobs/internal-job", response: hiddenResponse }), true);
  assert.equal(await invoke(route, { path: "/jobs/missing-job", response: missingResponse }), true);

  assert.equal(hiddenResponse.statusCode, 404);
  assert.deepEqual(hiddenResponse, missingResponse);
});

test("GET /jobs/tiers returns cached tier requirements", async () => {
  const { response, route } = makeHarness();

  assert.equal(await invoke(route, { path: "/jobs/tiers", response }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "public, max-age=300");
  assert.equal(response.body.ladder, "claim tier");
  assert(response.body.tiers.some((entry) => entry.tier === "starter"));
});

test("GET /jobs/definition forwards job and optional wallet", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { path: "/jobs/definition?jobId=job-1&wallet=0xabc", response }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.slice(0, 2), [
    ["getPublicJobDefinition", { jobId: "job-1", options: { wallet: "0xabc" } }],
    ["respond", { statusCode: 200, body: { id: "job-1", wallet: "0xabc" }, headers: {} }],
  ]);
});

test("public list and definition routes apply serving-only listing security metadata", async () => {
  const provenance = {
    posterAddress: WALLET,
    posterTier: "operator-curated",
    postingRoute: "curated",
    firstSeenAt: "2026-08-13T08:00:00.000Z",
    specHash: `0x${"ab".repeat(32)}`
  };
  const addMetadata = async (value) => {
    const decorate = (job) => ({
      ...job,
      verificationDepth: "Starter-tier benchmark check: output schema conformance and required reference terms. This is not a content audit.",
      listingStatus: "listed",
      contentTrust: "operator-curated",
      provenance
    });
    return Array.isArray(value) ? value.map(decorate) : decorate(value);
  };
  const { response, route } = makeHarness({
    jobs: [{ id: "job-1", category: "coding", lifecycle: { state: "open" } }],
    service: { addListingSecurityMetadata: addMetadata }
  });

  assert.equal(await invoke(route, { path: "/jobs?limit=1", response }), true);
  assert.equal(response.body.jobs[0].contentTrust, "operator-curated");
  assert.equal(
    response.body.jobs[0].verificationDepth,
    "Starter-tier benchmark check: output schema conformance and required reference terms. This is not a content audit."
  );
  assert.deepEqual(response.body.jobs[0].provenance, provenance);

  const definitionResponse = {};
  assert.equal(await invoke(route, {
    path: "/jobs/definition?jobId=job-1",
    response: definitionResponse
  }), true);
  assert.equal(definitionResponse.body.listingStatus, "listed");
  assert.equal(
    definitionResponse.body.verificationDepth,
    "Starter-tier benchmark check: output schema conformance and required reference terms. This is not a content audit."
  );
  assert.deepEqual(definitionResponse.body.provenance, provenance);
});

test("GET /jobs/definition requires admin auth to include archived jobs", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { path: "/jobs/definition?jobId=archive-1&includeArchived=true", response }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.slice(0, 3), [
    ["authMiddleware", { requireRole: "admin" }],
    ["getPublicJobDefinition", {
      jobId: "archive-1",
      options: {
        wallet: undefined,
        includeArchived: true,
        currentWallet: WALLET
      }
    }],
    ["respond", { statusCode: 200, body: { id: "archive-1", wallet: undefined }, headers: {} }],
  ]);
});

test("authenticated job advisory routes call platform service with wallet and job", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { path: "/jobs/recommendations", response }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, [{ id: "job-1" }]);

  assert.equal(await invoke(route, { path: "/jobs/preflight?jobId=job-2", response }), true);
  assert.equal(await invoke(route, { path: "/jobs/explain-eligibility?jobId=job-2", response }), true);
  assert.equal(await invoke(route, { path: "/jobs/estimate-reward?jobId=job-2", response }), true);

  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware"],
    ["recommendJobs", WALLET],
    ["authMiddleware"],
    ["preflightJob", { wallet: WALLET, jobId: "job-2" }],
    ["authMiddleware"],
    ["explainEligibility", { wallet: WALLET, jobId: "job-2" }],
    ["authMiddleware"],
    ["estimateNetReward", { wallet: WALLET, jobId: "job-2" }],
  ]);
});

test("POST /jobs/preflight returns 405 with the documented GET contract", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { method: "POST", path: "/jobs/preflight", response }), true);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "GET");
  assert.deepEqual(response.body, {
    error: "method_not_allowed",
    message: "Use GET /jobs/preflight?jobId=X."
  });
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), []);
});

test("GET /jobs/explain-eligibility rejects missing jobId before service call", async () => {
  const { calls, route } = makeHarness();

  await assert.rejects(
    invoke(route, { path: "/jobs/explain-eligibility" }),
    (error) => error instanceof ValidationError && /jobId query parameter/.test(error.message)
  );
  assert.deepEqual(calls, [["authMiddleware"]]);
});

test("sub-job routes list with parent ownership and create from payload", async () => {
  const { calls, response, route } = makeHarness({
    payload: { parentSessionId: "parent-2", title: "Child job" },
  });

  assert.equal(await invoke(route, { path: "/jobs/sub?parentSessionId=parent-1", response }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(await invoke(route, { method: "POST", path: "/jobs/sub", response }), true);
  assert.equal(response.statusCode, 201);

  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware"],
    ["ensureSessionOwnership", { sessionId: "parent-1", wallet: WALLET }],
    ["listSubJobs", "parent-1"],
    ["authMiddleware"],
    ["enforceLimit", { bucket: "admin_jobs", key: WALLET, limits: { max: 1, windowMs: 1000 } }],
    ["readJsonBody"],
    ["createSubJob", { parentSessionId: "parent-2", wallet: WALLET, payload: { parentSessionId: "parent-2", title: "Child job" } }],
  ]);
});

test("POST /jobs/claim preserves http protocol and idempotency fallback", async () => {
  const { calls, response, route } = makeHarness({
    payload: { jobId: "job-1" },
  });

  assert.equal(await invoke(route, { method: "POST", path: "/jobs/claim", response }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware"],
    ["readJsonBody"],
    ["claimJob", { wallet: WALLET, jobId: "job-1", protocol: "http", idempotencyKey: `${WALLET}:job-1` }],
  ]);
});

test("POST /jobs/claim attributes a hosted canary only from a wallet-bound marker", async () => {
  const markerChecks = [];
  const { calls, response, route } = makeHarness({
    payload: { jobId: "worker-canary-1786453506586" },
    verifyCanaryMarker: async (candidate) => {
      markerChecks.push(candidate);
      return candidate.marker === "signed-wallet-bound-marker" && candidate.wallet === WALLET;
    }
  });

  assert.equal(await invoke(route, {
    method: "POST",
    path: "/jobs/claim",
    response,
    headers: { "x-averray-canary-marker": "signed-wallet-bound-marker" }
  }), true);

  assert.deepEqual(markerChecks, [{ marker: "signed-wallet-bound-marker", wallet: WALLET }]);
  assert.deepEqual(calls.find(([name]) => name === "claimJob"), [
    "claimJob",
    {
      wallet: WALLET,
      jobId: "worker-canary-1786453506586",
      protocol: "http",
      idempotencyKey: `${WALLET}:worker-canary-1786453506586`,
      claimContext: {
        claimantAttribution: {
          kind: "hosted_worker_canary",
          evidence: "wallet_bound_marker_v1"
        }
      }
    }
  ]);
});

test("POST /jobs/claim fails a mismatched canary marker toward an external claimant", async () => {
  const { calls, route } = makeHarness({
    payload: { jobId: "worker-canary-1786453506586" },
    verifyCanaryMarker: async () => false
  });

  assert.equal(await invoke(route, {
    method: "POST",
    path: "/jobs/claim",
    headers: { "x-averray-canary-marker": "marker-for-a-different-wallet" }
  }), true);

  assert.deepEqual(calls.find(([name]) => name === "claimJob"), [
    "claimJob",
    {
      wallet: WALLET,
      jobId: "worker-canary-1786453506586",
      protocol: "http",
      idempotencyKey: `${WALLET}:worker-canary-1786453506586`
    }
  ]);
});

test("POST /jobs/validate-submission accepts submission/output/evidence aliases", async () => {
  const { calls, route } = makeHarness({
    payload: { jobId: "job-1", output: { ok: true } },
  });

  assert.equal(await invoke(route, { method: "POST", path: "/jobs/validate-submission" }), true);
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["readJsonBody"],
    ["validateJobSubmission", { jobId: "job-1", submission: { ok: true } }],
  ]);
});

test("POST /jobs/submit validates ownership and submits bounded evidence", async () => {
  const { calls, response, route } = makeHarness({
    payload: { sessionId: "session-1", evidence: "ready" },
  });

  assert.equal(await invoke(route, { method: "POST", path: "/jobs/submit", response }), true);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { sessionId: "session-1", protocol: "http", submission: "ready" });
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware"],
    ["readJsonBody"],
    ["ensureSessionOwnership", { sessionId: "session-1", wallet: WALLET }],
    ["submitWork", { sessionId: "session-1", protocol: "http", submission: "ready" }],
  ]);
});
