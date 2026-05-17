import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentPlatformApiError,
  AgentPlatformClient,
  AgentPlatformValidationError,
  createIdempotencyKey
} from "./agent-platform-client.js";

test("builder read helpers call the expected public endpoints", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test/",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  await client.getDiscoveryManifest();
  await client.getSessionStateMachine();
  await client.listJobSchemas();
  await client.getJobSchema("review-input.json");
  await client.getAgentProfile("0x1234567890123456789012345678901234567890");
  await client.getAgentBadge("session/with space");

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.example.test/agent-tools.json",
    "https://api.example.test/session/state-machine",
    "https://api.example.test/schemas/jobs",
    "https://api.example.test/schemas/jobs/review-input.json",
    "https://api.example.test/agents/0x1234567890123456789012345678901234567890",
    "https://api.example.test/badges/session%2Fwith%20space"
  ]);
});

test("authenticated helpers send bearer token and compact JSON bodies", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  await client.allocateIdleFunds({
    amount: 5,
    strategyId: "polkadot-vdot",
    idempotencyKey: "alloc-1",
    destination: undefined
  });
  await client.sendToAgent({
    recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    amount: "1.5",
    idempotencyKey: "send-1"
  });
  await client.borrowFunds({
    amount: 2,
    idempotencyKey: "borrow-1"
  });
  await client.repayFunds({
    amount: 1,
    idempotencyKey: undefined
  });

  assert.equal(calls[0].url, "https://api.example.test/account/allocate");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.get("authorization"), "Bearer test-token");
  assert.equal(calls[0].options.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    asset: "USDC",
    amount: 5,
    strategyId: "polkadot-vdot",
    idempotencyKey: "alloc-1"
  });

  assert.equal(calls[1].url, "https://api.example.test/payments/send");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    asset: "USDC",
    amount: "1.5",
    idempotencyKey: "send-1"
  });
  assert.equal(calls[2].url, "https://api.example.test/account/borrow");
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    asset: "USDC",
    amount: 2,
    idempotencyKey: "borrow-1"
  });
  assert.equal(calls[3].url, "https://api.example.test/account/repay");
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    asset: "USDC",
    amount: 1
  });
});

test("listSessions builds optional query string without empty params", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  await client.listSessions();
  await client.listSessions({ limit: 10, jobId: "starter job" });
  await client.listAdminSessions({ limit: 5, wallet: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" });

  assert.equal(calls[0].url, "https://api.example.test/sessions");
  assert.equal(calls[1].url, "https://api.example.test/sessions?limit=10&jobId=starter+job");
  assert.equal(
    calls[2].url,
    "https://api.example.test/admin/sessions?limit=5&wallet=0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
  );
});

test("job helpers build compact filters, mutation bodies, and admin timeline URLs", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  await client.listJobs({ source: "wikipedia", state: "claimable", limit: 5, offset: 10 });
  await client.listClaimableJobs({ category: "coding", limit: 2 });
  await client.validateJobSubmission("job with space", { summary: "Ready" });
  await client.claimJob("job with space", "claim-key-1");
  await client.submitWork("session with space", { summary: "Submitted" });
  await client.submitWork("legacy session", "plain evidence");
  await client.getJobTimeline("job with space", { limit: 50 });
  await client.createSubJob({
    parentSessionId: "parent session",
    id: "sub-job-1",
    rewardAmount: 2
  });
  await client.listSubJobs("parent session");

  assert.equal(
    calls[0].url,
    "https://api.example.test/jobs?source=wikipedia&state=claimable&limit=5&offset=10"
  );
  assert.equal(calls[1].url, "https://api.example.test/jobs?category=coding&state=claimable&format=compact&limit=2");
  assert.equal(calls[2].url, "https://api.example.test/jobs/validate-submission");
  assert.equal(calls[2].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    jobId: "job with space",
    submission: { summary: "Ready" }
  });
  assert.equal(calls[3].url, "https://api.example.test/jobs/claim");
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    jobId: "job with space",
    idempotencyKey: "claim-key-1"
  });
  assert.equal(calls[4].url, "https://api.example.test/jobs/submit");
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    sessionId: "session with space",
    submission: { summary: "Submitted" }
  });
  assert.deepEqual(JSON.parse(calls[5].options.body), {
    sessionId: "legacy session",
    evidence: "plain evidence"
  });
  assert.equal(calls[6].url, "https://api.example.test/admin/jobs/timeline?jobId=job+with+space&limit=50");
  assert.equal(calls[7].url, "https://api.example.test/jobs/sub");
  assert.deepEqual(JSON.parse(calls[7].options.body), {
    parentSessionId: "parent session",
    id: "sub-job-1",
    rewardAmount: 2
  });
  assert.equal(calls[8].url, "https://api.example.test/jobs/sub?parentSessionId=parent%20session");
});

test("validated job helpers fail closed before claim or submit mutations", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/jobs/validate-submission")) {
        const payload = JSON.parse(options.body);
        return jsonResponse(
          payload.submission?.status === "complete"
            ? { valid: true, submitSafe: true, schemaRef: "schema://jobs/coding-output" }
            : {
                valid: false,
                submitSafe: false,
                code: "invalid_request",
                message: "submission.status is required",
                path: "payload.submission.status"
              }
        );
      }
      if (url.endsWith("/jobs/claim")) {
        return jsonResponse({ sessionId: "claimed-session", jobId: "job-1", wallet: "0xabc" });
      }
      return jsonResponse({ sessionId: "claimed-session", status: "submitted" });
    }
  });

  await client.claimJobAfterValidation("job-1", { status: "complete" }, "claim-key-1");
  await client.submitValidatedWork("job-1", "claimed-session", { status: "complete" });

  assert.equal(calls[0].url, "https://api.example.test/jobs/validate-submission");
  assert.equal(calls[1].url, "https://api.example.test/jobs/claim");
  assert.equal(calls[2].url, "https://api.example.test/jobs/validate-submission");
  assert.equal(calls[3].url, "https://api.example.test/jobs/submit");

  calls.length = 0;
  await assert.rejects(
    () => client.claimJobAfterValidation("job-1", { summary: "missing status" }, "claim-key-2"),
    (error) => {
      assert.ok(error instanceof AgentPlatformValidationError);
      assert.equal(error.validation.path, "payload.submission.status");
      return true;
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/jobs/validate-submission");

  calls.length = 0;
  await assert.rejects(
    () => client.submitValidatedWork("job-1", "claimed-session", { summary: "missing status" }),
    AgentPlatformValidationError
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/jobs/validate-submission");
});

test("schema-native readiness validates direct output and rejected wrapper before mutation", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const payload = JSON.parse(options.body);
      if (payload.submission?.output?.wrapped_under_submission_output === true) {
        return jsonResponse({
          jobId: payload.jobId,
          valid: false,
          submitSafe: false,
          schemaRef: "schema://jobs/release-readiness-output",
          schemaValidates: "payload.submission",
          code: "invalid_submission_shape",
          message: "Send the structured proposal object directly as submission, not under submission.output.",
          path: "payload.submission.output",
          details: {
            received: "payload.submission.output",
            hint: "Move the object currently under submission.output up to submission."
          }
        });
      }
      return jsonResponse({
        jobId: payload.jobId,
        valid: true,
        submitSafe: true,
        schemaRef: "schema://jobs/release-readiness-output",
        schemaValidates: "payload.submission",
        submissionKind: "structured"
      });
    }
  });

  const readiness = await client.assertSchemaNativeSubmissionReady(
    "release-readiness-check-001",
    {
      release_id: "release-2026-05",
      checks_passed: ["api-health"],
      checks_failed: [],
      blockers: [],
      go_no_go: "go"
    },
    { expectedSchemaRef: "schema://jobs/release-readiness-output" }
  );

  assert.equal(readiness.valid, true);
  assert.equal(readiness.schemaRef, "schema://jobs/release-readiness-output");
  assert.equal(readiness.schemaValidates, "payload.submission");
  assert.equal(readiness.validatedBeforeClaim, true);
  assert.equal(readiness.invalidWrappedOutput.valid, false);
  assert.equal(readiness.invalidWrappedOutput.path, "payload.submission.output");
  assert.equal(readiness.invalidWrappedOutput.received, "payload.submission.output");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.example.test/jobs/validate-submission",
    "https://api.example.test/jobs/validate-submission"
  ]);
});

test("operator surface helpers call policy, audit, and alert endpoints", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  await client.listPolicies();
  await client.getPolicy("claim/deps-sec-only@v4");
  await client.proposePolicy({ tag: "claim/new@v1" });
  await client.listAuditEvents({ limit: 25 });
  await client.listAlerts({ limit: 5 });
  await client.pauseRecurringJob("weekly-digest", { idempotencyKey: "pause-1" });
  await client.resumeRecurringJob("weekly-digest", { idempotencyKey: "resume-1" });

  assert.equal(calls[0].url, "https://api.example.test/policies");
  assert.equal(calls[1].url, "https://api.example.test/policies/claim%2Fdeps-sec-only%40v4");
  assert.equal(calls[2].url, "https://api.example.test/policies");
  assert.equal(calls[2].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[2].options.body), { tag: "claim/new@v1" });
  assert.equal(calls[3].url, "https://api.example.test/audit?limit=25");
  assert.equal(calls[4].url, "https://api.example.test/alerts?limit=5");
  assert.equal(calls[5].url, "https://api.example.test/admin/jobs/pause");
  assert.deepEqual(JSON.parse(calls[5].options.body), {
    templateId: "weekly-digest",
    idempotencyKey: "pause-1"
  });
  assert.equal(calls[6].url, "https://api.example.test/admin/jobs/resume");
  assert.deepEqual(JSON.parse(calls[6].options.body), {
    templateId: "weekly-digest",
    idempotencyKey: "resume-1"
  });
});

test("request throws server-provided error messages with structured metadata", async () => {
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async () => jsonResponse({
      message: "nope",
      code: "bad_shape",
      details: { path: ["submission"] }
    }, { status: 400 })
  });

  await assert.rejects(
    () => client.getHealth(),
    (error) => {
      assert.ok(error instanceof AgentPlatformApiError);
      assert.equal(error.message, "nope");
      assert.equal(error.status, 400);
      assert.equal(error.method, "GET");
      assert.equal(error.path, "/health");
      assert.equal(error.code, "bad_shape");
      assert.deepEqual(error.details, { path: ["submission"] });
      return true;
    }
  );
});

test("listServiceTokens builds optional admin query string", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    token: "admin-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ items: [], limit: 50, offset: 0 });
    }
  });

  await client.listServiceTokens();
  await client.listServiceTokens({
    subject: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    status: "active",
    limit: 25,
    offset: 50
  });

  assert.equal(calls[0].url, "https://api.example.test/admin/service-tokens");
  assert.equal(calls[0].options.method ?? "GET", "GET");
  assert.equal(calls[0].options.headers.get("authorization"), "Bearer admin-token");
  assert.equal(
    calls[1].url,
    "https://api.example.test/admin/service-tokens?subject=0xabcdefabcdefabcdefabcdefabcdefabcdefabcd&status=active&limit=25&offset=50"
  );
});

test("issueServiceToken posts a least-privilege payload and strips undefined fields", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    token: "admin-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        token: "svc-token-secret",
        tokenType: "Bearer",
        tokenKind: "service",
        tokenAvailable: true,
        wallet: "0xagent",
        capabilities: ["jobs:claim", "jobs:submit"],
        expiresAt: "2026-06-01T00:00:00.000Z",
        grant: { id: "grant-1", status: "active" },
        usage: { header: "Authorization: Bearer <token>" }
      }, { status: 201 });
    }
  });

  const response = await client.issueServiceToken({
    subject: "0xagent",
    capabilities: ["jobs:claim", "jobs:submit"],
    scope: "wikipedia-bot",
    idempotencyKey: "issue-1"
  });

  assert.equal(calls[0].url, "https://api.example.test/admin/service-tokens");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.get("authorization"), "Bearer admin-token");
  assert.equal(calls[0].options.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    subject: "0xagent",
    capabilities: ["jobs:claim", "jobs:submit"],
    scope: "wikipedia-bot",
    idempotencyKey: "issue-1"
  });
  assert.equal(response.token, "svc-token-secret");
  assert.equal(response.tokenAvailable, true);
});

test("issueServiceToken rejects missing subject or empty capabilities before any HTTP call", async () => {
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async () => {
      throw new Error("fetch must not be called when input is invalid");
    }
  });

  await assert.rejects(() => client.issueServiceToken({}), TypeError);
  await assert.rejects(
    () => client.issueServiceToken({ subject: "0xagent", capabilities: [] }),
    TypeError
  );
});

test("rotateServiceToken URL-encodes the grant id and forwards optional overrides", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    token: "admin-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        token: "rotated-token-secret",
        tokenAvailable: true,
        grant: { id: "grant-2" }
      }, { status: 201 });
    }
  });

  await client.rotateServiceToken("grant id/with slash", {
    capabilities: ["jobs:claim"],
    tokenTtlSeconds: 1800,
    revokeNote: "tightened scope"
  });

  assert.equal(
    calls[0].url,
    "https://api.example.test/admin/service-tokens/grant%20id%2Fwith%20slash/rotate"
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    capabilities: ["jobs:claim"],
    tokenTtlSeconds: 1800,
    revokeNote: "tightened scope"
  });
});

test("revokeServiceToken posts a compact body and survives an empty input", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    token: "admin-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        tokenKind: "service",
        tokenAvailable: false,
        status: "revoked",
        alreadyRevoked: false,
        grant: { id: "grant-3", status: "revoked" }
      });
    }
  });

  await client.revokeServiceToken("grant-3");
  await client.revokeServiceToken("grant-3", { note: "key rotated out-of-band", idempotencyKey: "revoke-1" });

  assert.equal(calls[0].url, "https://api.example.test/admin/service-tokens/grant-3/revoke");
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    note: "key rotated out-of-band",
    idempotencyKey: "revoke-1"
  });
});

test("rotate/revoke require a non-empty grant id", async () => {
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async () => {
      throw new Error("fetch must not be called when input is invalid");
    }
  });

  await assert.rejects(() => client.rotateServiceToken(""), TypeError);
  await assert.rejects(() => client.revokeServiceToken(undefined), TypeError);
});

test("createIdempotencyKey produces unique, prefixed, sanitized keys", () => {
  const a = createIdempotencyKey("claim");
  const b = createIdempotencyKey("claim");
  assert.notEqual(a, b);
  assert.match(a, /^claim-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9-]+$/u);

  const sanitized = createIdempotencyKey("bad prefix!/with stuff");
  assert.match(sanitized, /^bad-prefix-with-stuff-/u);

  const fallback = createIdempotencyKey();
  assert.match(fallback, /^run-/u);

  const emptyPrefix = createIdempotencyKey("");
  assert.match(emptyPrefix, /^run-/u);
});

test("fireRecurringJob forwards idempotencyKey into the JSON body unchanged", async () => {
  const calls = [];
  const client = new AgentPlatformClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    }
  });

  await client.fireRecurringJob("weekly-digest", {
    idempotencyKey: "fire-weekly-digest-2026-w19",
    firedAt: "2026-05-13T00:00:00.000Z"
  });

  assert.equal(calls[0].url, "https://api.example.test/admin/jobs/fire");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    templateId: "weekly-digest",
    firedAt: "2026-05-13T00:00:00.000Z",
    idempotencyKey: "fire-weekly-digest-2026-w19"
  });
});


function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}
