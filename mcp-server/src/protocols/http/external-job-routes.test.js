import assert from "node:assert/strict";
import test from "node:test";

import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  ValidationError
} from "../../core/errors.js";
import { createExternalJobRoutes } from "./external-job-routes.js";

const POSTER = "0x1111111111111111111111111111111111111111";
const ADMIN = "0x2222222222222222222222222222222222222222";
const DRAFT_ID = "draft-1";
const JOB_ID = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createExternalJobRoutes({
    authMiddleware: async (_request, _url, options) => {
      calls.push(["authMiddleware", options]);
      if (overrides.serviceToken && options?.requireRole !== "admin") {
        return {
          wallet: POSTER,
          claims: { tokenKind: "service", serviceToken: true }
        };
      }
      return options?.requireRole === "admin"
        ? { wallet: ADMIN, claims: { roles: ["admin"] } }
        : { wallet: POSTER, claims: { roles: [] } };
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["enforceLimit", { bucket, key, limits }]);
      if (overrides.rateLimited) {
        throw new RateLimitError("Rate limit exceeded.", { bucket });
      }
    },
    externalPostingService: {
      createDraft: async (wallet, payload) => {
        calls.push(["createDraft", { wallet, payload }]);
        return {
          draftId: DRAFT_ID,
          jobId: JOB_ID,
          specHash: JOB_ID,
          status: "quoted",
          persisted: false
        };
      },
      getDraft: async (wallet, draftId) => {
        calls.push(["getDraft", { wallet, draftId }]);
        if (overrides.notOwned) {
          throw new AuthorizationError("Draft does not belong to wallet.", "external_draft_not_owned");
        }
        return {
          draftId,
          jobId: JOB_ID,
          status: "quoted",
          persisted: false,
          note: "funding detection runs in the watcher"
        };
      },
      buildPostJobTransactions: async (wallet, draftId) => {
        calls.push(["buildPostJobTransactions", { wallet, draftId }]);
        return {
          draftId,
          wallet,
          templates: [{ step: "create", unsigned: true }]
        };
      },
      listPosterJobs: async (wallet) => {
        calls.push(["listPosterJobs", { wallet }]);
        return {
          wallet,
          count: 1,
          jobs: [{
            jobId: JOB_ID,
            status: "live",
            claimState: "open",
            claimedBy: null,
            claimAttemptCount: 0,
            reservedEscrow: { asset: "USDC", amount: "1.05", amountRaw: "1050000", decimals: 6 },
            sessions: []
          }]
        };
      },
      delistExternalJob: async (jobId, payload) => {
        calls.push(["delistExternalJob", { jobId, payload }]);
        return { jobId, delisted: true };
      }
    },
    x402PosterRamp: overrides.x402Disabled ? undefined : {
      paymentRequired: async (payload) => {
        calls.push(["paymentRequired", { payload }]);
        if (overrides.x402Failure) {
          throw new ValidationError("rewardAmount has too many decimal places.");
        }
        return {
          statusCode: 402,
          body: { x402Version: 2, accepts: [{ network: "eip155:8453" }] },
          headers: {
            "payment-required": "current-challenge",
            "x-payment-required": "legacy-challenge"
          }
        };
      },
      post: async (input) => {
        calls.push(["postX402", input]);
        return {
          draftId: DRAFT_ID,
          status: "live",
          fundingRail: "x402",
          headers: {
            "payment-response": "current-receipt",
            "x-payment-response": "legacy-receipt"
          }
        };
      }
    },
    rateLimitConfig: {
      adminJobs: { limit: 60, windowSeconds: 60 },
      externalDrafts: { limit: 30, windowSeconds: 60 }
    },
    readJsonBody: async () => {
      calls.push(["readJsonBody"]);
      return overrides.payload ?? { definition: { rewardAmount: "1.0" } };
    },
    respond: (target, statusCode, body, headers = {}) => {
      calls.push(["respond", { statusCode, body, headers }]);
      Object.assign(target, { statusCode, body, headers });
    }
  });
  return { calls, response, route };
}

async function invoke(route, { method = "GET", path, response = {}, headers = {} }) {
  return route({
    request: { method, headers, socket: { remoteAddress: "192.0.2.10" } },
    response,
    url: new URL(`http://localhost${path}`),
    pathname: path
  });
}

test("POST /jobs/x402 returns one portable Bazaar and SIWX payment challenge", async () => {
  const payload = { definition: { rewardAmount: "1.0" } };
  const { calls, response, route } = makeHarness({ payload });

  assert.equal(await invoke(route, { method: "POST", path: "/jobs/x402", response }), true);
  assert.equal(response.statusCode, 402);
  assert.equal(response.body.x402Version, 2);
  assert.equal(response.headers["payment-required"], "current-challenge");
  assert.equal(response.headers["x-payment-required"], "legacy-challenge");
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["enforceLimit", {
      bucket: "external_x402",
      key: "192.0.2.10",
      limits: { limit: 30, windowSeconds: 60 }
    }],
    ["readJsonBody"],
    ["paymentRequired", { payload }]
  ]);
});

test("POST /jobs/x402 accepts legacy payment and SIWX headers in one funded request", async () => {
  const payload = { definition: { rewardAmount: "1.0" } };
  const { calls, response, route } = makeHarness({ payload });

  assert.equal(await invoke(route, {
    method: "POST",
    path: "/jobs/x402",
    response,
    headers: { "x-payment": "proof", "sign-in-with-x": "identity" }
  }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.fundingRail, "x402");
  assert.equal(response.body.headers, undefined);
  assert.equal(response.headers["payment-response"], "current-receipt");
  assert.equal(response.headers["x-payment-response"], "legacy-receipt");
  assert.deepEqual(calls.find(([name]) => name === "postX402"), [
    "postX402",
    { payload, paymentProof: "proof", signInProof: "identity" }
  ]);
});

test("POST /jobs/x402 disabled response says what happened and what to do", async () => {
  const { route } = makeHarness({ x402Disabled: true });
  await assert.rejects(
    invoke(route, { method: "POST", path: "/jobs/x402" }),
    (error) => error instanceof AppError
      && error.code === "x402_posting_disabled"
      && error.details?.action === "use_siwe_draft_or_retry_after_enablement"
      && error.details?.posterFunds === "unchanged"
  );
});

test("POST /jobs/x402 decorates every otherwise-bare rejection with next action and fund state", async () => {
  const { route } = makeHarness({ x402Failure: true });
  await assert.rejects(
    invoke(route, { method: "POST", path: "/jobs/x402" }),
    (error) => error.code === "invalid_request"
      && error.details?.action === "correct_request_and_retry_for_fresh_challenge"
      && error.details?.posterFunds === "unchanged"
      && /request a fresh 402 response/u.test(error.message)
  );
});

test("POST /jobs/draft authenticates any SIWE wallet and returns a non-persisted quote", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { method: "POST", path: "/jobs/draft", response }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.draftId, DRAFT_ID);
  assert.equal(response.body.status, "quoted");
  assert.equal(response.body.persisted, false);
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware", undefined],
    ["enforceLimit", {
      bucket: "external_drafts",
      key: POSTER,
      limits: { limit: 30, windowSeconds: 60 }
    }],
    ["readJsonBody"],
    ["createDraft", { wallet: POSTER, payload: { definition: { rewardAmount: "1.0" } } }]
  ]);
});

test("GET /jobs/draft/:id is poster-owned and reports the unfunded quote honestly", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { path: `/jobs/draft/${DRAFT_ID}`, response }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "quoted");
  assert.equal(response.body.persisted, false);
  assert.equal(response.body.note, "funding detection runs in the watcher");
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware", undefined],
    ["enforceLimit", {
      bucket: "external_drafts",
      key: POSTER,
      limits: { limit: 30, windowSeconds: 60 }
    }],
    ["getDraft", { wallet: POSTER, draftId: DRAFT_ID }]
  ]);
});

test("POST /jobs/draft/:id/transactions is poster-owned and delegates to the shared builder", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, {
    method: "POST",
    path: `/jobs/draft/${DRAFT_ID}/transactions`,
    response
  }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.wallet, POSTER);
  assert.equal(response.body.templates[0].unsigned, true);
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware", undefined],
    ["enforceLimit", {
      bucket: "external_drafts",
      key: POSTER,
      limits: { limit: 30, windowSeconds: 60 }
    }],
    ["buildPostJobTransactions", { wallet: POSTER, draftId: DRAFT_ID }]
  ]);
});

test("GET /poster/jobs authenticates the poster wallet and returns only its job projection", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { path: "/poster/jobs", response }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.wallet, POSTER);
  assert.equal(response.body.jobs[0].jobId, JOB_ID);
  assert.equal(response.body.jobs[0].reservedEscrow.amount, "1.05");
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware", undefined],
    ["enforceLimit", {
      bucket: "external_drafts",
      key: POSTER,
      limits: { limit: 30, windowSeconds: 60 }
    }],
    ["listPosterJobs", { wallet: POSTER }]
  ]);
});

test("GET /jobs/draft/:id rejects a different wallet", async () => {
  const { route } = makeHarness({ notOwned: true });
  await assert.rejects(
    invoke(route, { path: `/jobs/draft/${DRAFT_ID}` }),
    (error) => error instanceof AuthorizationError && error.code === "external_draft_not_owned"
  );
});

test("poster routes reject service tokens because the poster must prove wallet control via SIWE", async () => {
  for (const request of [
    { method: "POST", path: "/jobs/draft" },
    { method: "POST", path: `/jobs/draft/${DRAFT_ID}/transactions` },
    { method: "GET", path: `/jobs/draft/${DRAFT_ID}` },
    { method: "GET", path: "/poster/jobs" }
  ]) {
    const { route } = makeHarness({ serviceToken: true });
    await assert.rejects(
      invoke(route, request),
      (error) => error instanceof AuthenticationError && error.code === "external_posting_siwe_required"
    );
  }
});

test("draft routes rate-limit per wallet before doing any draft work", async () => {
  for (const attempt of [
    { method: "POST", path: "/jobs/draft" },
    { method: "POST", path: `/jobs/draft/${DRAFT_ID}/transactions` },
    { method: "GET", path: `/jobs/draft/${DRAFT_ID}` },
    { method: "GET", path: "/poster/jobs" }
  ]) {
    const { calls, route } = makeHarness({ rateLimited: true });
    await assert.rejects(
      invoke(route, attempt),
      (error) => error instanceof RateLimitError && error.code === "rate_limited"
    );
    const names = calls.map(([name]) => name);
    assert.ok(names.includes("enforceLimit"), `${attempt.path} must consult the limiter`);
    assert.deepEqual(
      names.filter((name) => ["readJsonBody", "createDraft", "getDraft", "buildPostJobTransactions", "listPosterJobs"].includes(name)),
      [],
      `${attempt.path} must not reach body parsing or the posting service once limited`
    );
  }
});

test("POST /admin/jobs/external/:id/delist requires admin auth and records projection-only delist", async () => {
  const payload = { reason: "safety review" };
  const { calls, response, route } = makeHarness({ payload });

  assert.equal(
    await invoke(route, {
      method: "POST",
      path: `/admin/jobs/external/${JOB_ID}/delist`,
      response
    }),
    true
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.delisted, true);
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware", { requireRole: "admin" }],
    ["enforceLimit", {
      bucket: "admin_jobs",
      key: ADMIN,
      limits: { limit: 60, windowSeconds: 60 }
    }],
    ["readJsonBody"],
    ["delistExternalJob", {
      jobId: JOB_ID,
      payload: { ...payload, adminWallet: ADMIN }
    }]
  ]);
});

test("external job routes ignore public catalog and unrelated paths", async () => {
  const { calls, route } = makeHarness();
  assert.equal(await invoke(route, { path: "/jobs" }), false);
  assert.equal(await invoke(route, { path: "/health" }), false);
  assert.equal(await invoke(route, { path: "/agent-tools.json" }), false);
  assert.deepEqual(calls, []);
});
