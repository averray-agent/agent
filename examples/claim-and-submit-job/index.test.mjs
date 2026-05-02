import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReadinessSummary,
  parseArgs,
  runClaimAndSubmit,
  summarizeTimeline
} from "./index.mjs";

test("parseArgs accepts dry-run and execute options", () => {
  assert.deepEqual(parseArgs([
    "--api",
    "https://api.example",
    "--token",
    "token",
    "--job-id",
    "job-1",
    "--idempotency-key",
    "idem-1",
    "--submission-json",
    "{\"result\":\"complete\"}",
    "--execute"
  ]), {
    apiUrl: "https://api.example",
    token: "token",
    jobId: "job-1",
    idempotencyKey: "idem-1",
    submission: { result: "complete" },
    execute: true
  });
});

test("buildReadinessSummary treats claimStatus as the claimability source", () => {
  const readiness = buildReadinessSummary({
    onboarding: { onboarding: { entrypoint: "/onboarding" } },
    definition: {
      id: "job-1",
      title: "Job 1",
      claimStatus: {
        claimState: "open",
        claimable: true,
        reason: "claimable",
        retryLimit: 1,
        remainingClaimAttempts: 1
      }
    },
    preflight: undefined,
    tokenPresent: true
  });

  assert.equal(readiness.canAttemptClaim, true);
  assert.equal(readiness.reason, "claimable");
});

test("runClaimAndSubmit dry-run avoids claim and submit mutations", async () => {
  const calls = [];
  const summary = await runClaimAndSubmit({
    apiUrl: "https://api.example",
    token: "token",
    jobId: "job-1",
    fetchImpl: fakeFetch(calls)
  });

  assert.equal(summary.mode, "dry_run");
  assert.equal(summary.readiness.canAttemptClaim, true);
  assert.deepEqual(calls, [
    "https://api.example/onboarding",
    "https://api.example/jobs/definition?jobId=job-1",
    "https://api.example/jobs/preflight?jobId=job-1"
  ]);
});

test("runClaimAndSubmit executes claim, submit, and timeline reads when requested", async () => {
  const calls = [];
  const submission = { result: "complete" };
  const summary = await runClaimAndSubmit({
    apiUrl: "https://api.example",
    token: "token",
    jobId: "job-1",
    idempotencyKey: "idem-1",
    submission,
    execute: true,
    fetchImpl: fakeFetch(calls)
  });

  assert.equal(summary.mode, "executed");
  assert.equal(summary.claim.sessionId, "session-1");
  assert.equal(summary.validation.valid, true);
  assert.equal(summary.submit.status, "submitted");
  assert.ok(calls.includes("https://api.example/jobs/validate-submission"));
  assert.ok(calls.includes("https://api.example/jobs/claim"));
  assert.ok(calls.includes("https://api.example/jobs/submit"));
  assert.ok(calls.includes("https://api.example/session/timeline?sessionId=session-1"));
});

test("runClaimAndSubmit blocks before claim when local draft validation fails", async () => {
  const calls = [];
  const summary = await runClaimAndSubmit({
    apiUrl: "https://api.example",
    token: "token",
    jobId: "job-1",
    evidence: "bad",
    execute: true,
    fetchImpl: fakeFetch(calls, { validationValid: false })
  });

  assert.equal(summary.mode, "blocked");
  assert.equal(summary.validation.valid, false);
  assert.equal(summary.claim, null);
  assert.equal(summary.submit, null);
  assert.ok(calls.includes("https://api.example/jobs/validate-submission"));
  assert.ok(!calls.includes("https://api.example/jobs/claim"));
});

test("summarizeTimeline returns compact timeline metadata", () => {
  assert.deepEqual(summarizeTimeline({
    timelineVersion: "v2",
    session: { status: "submitted" },
    timeline: [{ type: "session_transition" }, { type: "verification" }, { type: "verification" }]
  }), {
    timelineVersion: "v2",
    sessionStatus: "submitted",
    eventCount: 3,
    eventTypes: ["session_transition", "verification"]
  });
});

function fakeFetch(calls, { validationValid = true } = {}) {
  return async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).endsWith("/onboarding")) {
      return jsonResponse({ onboarding: { entrypoint: "/onboarding" } });
    }
    if (String(url).includes("/jobs/definition")) {
      return jsonResponse({
        id: "job-1",
        claimStatus: { claimState: "open", claimable: true, reason: "claimable" }
      });
    }
    if (String(url).includes("/jobs/preflight")) {
      return jsonResponse({ claimable: true, reason: "claimable" });
    }
    if (String(url).endsWith("/jobs/validate-submission")) {
      assert.equal(options.method, "POST");
      const payload = JSON.parse(options.body);
      assert.equal(payload.jobId, "job-1");
      return jsonResponse(validationValid
        ? { valid: true, schemaRef: "schema://jobs/example-output" }
        : { valid: false, schemaRef: "schema://jobs/example-output", message: "submission.result is required" });
    }
    if (String(url).endsWith("/jobs/claim")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { jobId: "job-1", idempotencyKey: "idem-1" });
      return jsonResponse({ sessionId: "session-1", status: "claimed", claimExpiresAt: "2026-05-02T12:00:00.000Z" });
    }
    if (String(url).endsWith("/jobs/submit")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { sessionId: "session-1", submission: { result: "complete" } });
      return jsonResponse({ sessionId: "session-1", status: "submitted" });
    }
    if (String(url).includes("/session/timeline")) {
      return jsonResponse({ timelineVersion: "v2", session: { status: "submitted" }, timeline: [] });
    }
    return jsonResponse({ message: "not found" }, { status: 404 });
  };
}

function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}
