import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError, AuthorizationError, RateLimitError } from "../../core/errors.js";
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
          status: "awaiting_funding"
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
          status: "awaiting_funding",
          note: "funding detection ships with the watcher"
        };
      },
      delistExternalJob: async (jobId, payload) => {
        calls.push(["delistExternalJob", { jobId, payload }]);
        return { jobId, delisted: true };
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
    respond: (target, statusCode, body) => {
      calls.push(["respond", { statusCode, body }]);
      Object.assign(target, { statusCode, body });
    }
  });
  return { calls, response, route };
}

async function invoke(route, { method = "GET", path, response = {} }) {
  return route({
    request: { method },
    response,
    url: new URL(`http://localhost${path}`),
    pathname: path
  });
}

test("POST /jobs/draft authenticates any SIWE wallet and returns the signing template", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { method: "POST", path: "/jobs/draft", response }), true);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.draftId, DRAFT_ID);
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

test("GET /jobs/draft/:id is poster-owned and stays honest before the watcher ships", async () => {
  const { calls, response, route } = makeHarness();

  assert.equal(await invoke(route, { path: `/jobs/draft/${DRAFT_ID}`, response }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "awaiting_funding");
  assert.equal(response.body.note, "funding detection ships with the watcher");
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

test("GET /jobs/draft/:id rejects a different wallet", async () => {
  const { route } = makeHarness({ notOwned: true });
  await assert.rejects(
    invoke(route, { path: `/jobs/draft/${DRAFT_ID}` }),
    (error) => error instanceof AuthorizationError && error.code === "external_draft_not_owned"
  );
});

test("draft routes reject service tokens because the poster must prove wallet control via SIWE", async () => {
  const { route } = makeHarness({ serviceToken: true });
  await assert.rejects(
    invoke(route, { method: "POST", path: "/jobs/draft" }),
    (error) => error instanceof AuthenticationError && error.code === "external_posting_siwe_required"
  );
});

test("draft routes rate-limit per wallet before doing any draft work", async () => {
  for (const attempt of [
    { method: "POST", path: "/jobs/draft" },
    { method: "GET", path: `/jobs/draft/${DRAFT_ID}` }
  ]) {
    const { calls, route } = makeHarness({ rateLimited: true });
    await assert.rejects(
      invoke(route, attempt),
      (error) => error instanceof RateLimitError && error.code === "rate_limited"
    );
    const names = calls.map(([name]) => name);
    assert.ok(names.includes("enforceLimit"), `${attempt.path} must consult the limiter`);
    assert.deepEqual(
      names.filter((name) => ["readJsonBody", "createDraft", "getDraft"].includes(name)),
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
