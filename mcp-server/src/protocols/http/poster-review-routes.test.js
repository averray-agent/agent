import assert from "node:assert/strict";
import test from "node:test";

import { AuthenticationError, NotFoundError, RateLimitError } from "../../core/errors.js";
import { createPosterReviewRoutes } from "./poster-review-routes.js";

const JOB_ID = `0x${"a".repeat(64)}`;
const POSTER = "0x1111111111111111111111111111111111111111";

function makeHarness(overrides = {}) {
  const calls = [];
  const response = {};
  const route = createPosterReviewRoutes({
    authMiddleware: async () => {
      calls.push(["authMiddleware"]);
      return {
        wallet: POSTER,
        claims: overrides.serviceToken
          ? { roles: ["service"], tokenKind: "service", serviceToken: true }
          : { roles: overrides.admin ? ["admin"] : [] }
      };
    },
    enforceLimit: async (bucket, key, limits) => {
      calls.push(["enforceLimit", { bucket, key, limits }]);
      if (overrides.rateLimited) throw new RateLimitError("limited", { bucket });
    },
    posterReviewService: {
      async getSubmissionForReview(jobId, auth) {
        calls.push(["getSubmissionForReview", { jobId, auth }]);
        if (overrides.concealed) {
          throw new NotFoundError(
            "Job submission not found.",
            "external_job_submission_not_found"
          );
        }
        return {
          jobId,
          sessionId: "session-1",
          worker: "0x2222222222222222222222222222222222222222",
          submittedAt: "2026-08-01T10:00:00.000Z",
          deliverable: { summary: "ready" }
        };
      },
      async reviewSubmission(jobId, payload) {
        calls.push(["reviewSubmission", { jobId, payload }]);
        return {
          jobId,
          decision: payload.verdict,
          decidedBy: payload.wallet,
          status: payload.verdict === "approve" ? "settled" : "rejected"
        };
      }
    },
    rateLimitConfig: {
      externalReviews: { limit: 30, windowSeconds: 60 }
    },
    readJsonBody: async () => {
      calls.push(["readJsonBody"]);
      return overrides.payload ?? { verdict: "approve", reason: "" };
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

test("GET /jobs/:id/submission returns the poster review payload", async () => {
  const { calls, response, route } = makeHarness();
  assert.equal(await invoke(route, { path: `/jobs/${JOB_ID}/submission`, response }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.jobId, JOB_ID);
  assert.deepEqual(calls.filter(([name]) => name !== "respond"), [
    ["authMiddleware"],
    ["enforceLimit", {
      bucket: "external_reviews",
      key: POSTER,
      limits: { limit: 30, windowSeconds: 60 }
    }],
    ["getSubmissionForReview", {
      jobId: JOB_ID,
      auth: { wallet: POSTER, isAdmin: false }
    }]
  ]);
});

test("GET /jobs/:id/submission keeps unauthorized existence behind a 404 shape", async () => {
  const { route } = makeHarness({ concealed: true });
  await assert.rejects(
    invoke(route, { path: `/jobs/${JOB_ID}/submission` }),
    (error) => error?.statusCode === 404
      && error?.code === "external_job_submission_not_found"
  );
});

test("POST /jobs/:id/review normalizes approve and passes admin authority", async () => {
  const { calls, response, route } = makeHarness({ admin: true });
  assert.equal(await invoke(route, {
    method: "POST",
    path: `/jobs/${JOB_ID}/review`,
    response
  }), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "settled");
  assert.deepEqual(calls.find(([name]) => name === "reviewSubmission"), [
    "reviewSubmission",
    {
      jobId: JOB_ID,
      payload: {
        wallet: POSTER,
        isAdmin: true,
        verdict: "approve",
        reason: ""
      }
    }
  ]);
});

test("POST /jobs/:id/review requires a meaningful rejection reason", async () => {
  const { calls, route } = makeHarness({
    payload: { verdict: "reject", reason: "too short" }
  });
  await assert.rejects(
    invoke(route, { method: "POST", path: `/jobs/${JOB_ID}/review` }),
    (error) => error?.code === "invalid_request" && /at least 10 characters/u.test(error.message)
  );
  assert.equal(calls.some(([name]) => name === "reviewSubmission"), false);
});

test("authz matrix: service token cannot read or decide poster submissions", async () => {
  for (const attempt of [
    { method: "GET", path: `/jobs/${JOB_ID}/submission` },
    { method: "POST", path: `/jobs/${JOB_ID}/review` }
  ]) {
    const { calls, route } = makeHarness({ serviceToken: true });
    await assert.rejects(
      invoke(route, attempt),
      (error) => error instanceof AuthenticationError
        && error.code === "poster_review_siwe_required"
    );
    assert.equal(calls.some(([name]) => name === "enforceLimit"), false);
  }
});

test("poster review routes rate-limit both reads and decisions per wallet", async () => {
  for (const attempt of [
    { method: "GET", path: `/jobs/${JOB_ID}/submission` },
    { method: "POST", path: `/jobs/${JOB_ID}/review` }
  ]) {
    const { calls, route } = makeHarness({ rateLimited: true });
    await assert.rejects(
      invoke(route, attempt),
      (error) => error instanceof RateLimitError
    );
    assert.equal(calls.some(([name]) => name === "getSubmissionForReview"), false);
    assert.equal(calls.some(([name]) => name === "reviewSubmission"), false);
  }
});

test("poster review routes ignore neighboring job paths", async () => {
  const { calls, route } = makeHarness();
  assert.equal(await invoke(route, { path: "/jobs" }), false);
  assert.equal(await invoke(route, { path: "/jobs/definition" }), false);
  assert.deepEqual(calls, []);
});
