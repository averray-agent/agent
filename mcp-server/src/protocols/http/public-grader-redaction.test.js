import test from "node:test";
import assert from "node:assert/strict";
import { createJobRoutes } from "./job-routes.js";
import { createSessionRoutes } from "./session-routes.js";
import { createAdminJobsRoutes } from "./admin-jobs-routes.js";
import { respond } from "./http-helpers.js";
import { createMcpToolExecutor } from "../mcp/tools.js";
import { invokeHttpRoute } from "../mcp/route-adapter.js";
import { redactPublicGraderFields } from "../../core/public-grader-redaction.js";

const sentinel = "GRADER_PRIVATE_FIXTURE_DO_NOT_SERVE";
function fixture() {
  const grader = { expectedOutputs: [sentinel], rubric: { secret: sentinel }, answerKey: sentinel, benchmarkInputs: [sentinel], requiredKeywords: [sentinel], minimumMatches: 7 };
  const job = { id: "curated-job", title: "Public work", claimable: true, claimState: "open",
    provenance: { postingRoute: "curated" }, source: { type: "github_issue", repo: "owner/repo" },
    description: "Public instructions", input: { rubric: "Public review-input rubric" },
    verifierConfig: { handler: "benchmark", version: "1", anchorEvidence: "https://example.com/evidence", ...grader, nested: [{ ...grader, publicLabel: "kept" }] } };
  const session = { sessionId: "session-1", jobSnapshot: { definition: job } };
  const service = {
    listJobsWithSessions: async () => [job, { id: "ingested", provenance: { postingRoute: "ingested" }, source: { type: "github_issue" } }],
    getPublicJobDefinition: async () => job, getJobLifecycleSummary: () => ({}),
    claimJob: async () => session, listSessionHistory: async () => [session],
    preflightJob: async () => ({ job })
  };
  const options = { service, respond, authMiddleware: async () => ({ wallet: "fixture", roles: ["admin"] }),
    enforceLimit: async () => {}, rateLimitConfig: { adminJobs: {} },
    ensureSessionOwnership: async () => session, readJsonBody: async () => ({ jobId: job.id }) };
  return { job, session, route: createJobRoutes(options), sessions: createSessionRoutes(options), admin: createAdminJobsRoutes(options) };
}

function assertRedacted(value, label) {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, new RegExp(sentinel, "u"), label);
  for (const key of ["expectedOutputs", "answerKey", "benchmarkInputs", "requiredKeywords", "minimumMatches"]) assert.ok(!json.includes('"'+key+'"'), label + ": " + key);
}

test("all five HTTP and MCP public job surfaces allow only public benchmark config; admin keeps originals", async () => {
  const f = fixture(), before = JSON.stringify(f.job);
  for (const path of ["/jobs", "/jobs/curated-job", "/jobs/definition?jobId=curated-job", "/jobs?limit=1",
    "/jobs?format=full", "/jobs/definition?jobId=curated-job&includeArchived=1"]) {
    const result = await invokeHttpRoute(f.route, { method: "GET", path });
    assert.equal(result.statusCode, 200, path);
    assertRedacted(result.body, path);
  }
  const execute = createMcpToolExecutor({ handleJobRoute: f.route });
  const ctx = { request: { headers: {} } };
  assertRedacted(await execute("getJobDefinition", { jobId: f.job.id }, ctx), "MCP getJobDefinition");
  assertRedacted(await execute("listJobs", { format: "full" }, ctx), "MCP listJobs full");
  assertRedacted(await execute("listJobs", {}, ctx), "MCP listJobs compact");
  const admin = await invokeHttpRoute(f.admin, { method: "GET", path: "/admin/jobs" });
  assert.equal(admin.statusCode, 200);
  assert.equal(admin.body.jobs[0].verifierConfig.expectedOutputs[0], sentinel);
  assert.equal(JSON.stringify(f.job), before, "verification definition is not mutated by public serialization");
  const definition = await invokeHttpRoute(f.route, { method: "GET", path: "/jobs/definition?jobId=curated-job" });
  assert.equal(definition.body.description, "Public instructions");
  assert.deepEqual(definition.body.verifierConfig, { handler: "benchmark", version: "1", anchorEvidence: "https://example.com/evidence" });
  assert.equal(definition.body.input.rubric, "Public review-input rubric");
});

test("claim/preflight and resumed session snapshots cannot bypass the public job redaction", async () => {
  const f = fixture();
  for (const [route, method, path] of [
    [f.route, "POST", "/jobs/claim"], [f.route, "GET", "/jobs/preflight?jobId=curated-job"],
    [f.sessions, "GET", "/session?sessionId=session-1"], [f.sessions, "GET", "/sessions"]
  ]) {
    const result = await invokeHttpRoute(route, { method, path });
    assert.equal(result.statusCode, 200);
    assertRedacted(result.body, path);
  }
});

test("public ETags cover only the redacted representation, including null-prototype JSON records", async () => {
  const f = fixture();
  const first = await invokeHttpRoute(f.route, { method: "GET", path: "/jobs" });
  f.job.verifierConfig.expectedOutputs = ["different-private-answer"];
  const second = await invokeHttpRoute(f.route, { method: "GET", path: "/jobs" });
  assert.equal(first.headers.etag, second.headers.etag, "private grader changes must not change a public cache validator");
  assert.deepEqual(redactPublicGraderFields(Object.assign(Object.create(null), {
    verifierConfig: { handler: "benchmark", expectedOutputs: [sentinel] }, input: { rubric: "public" }
  })), { verifierConfig: { handler: "benchmark" }, input: { rubric: "public" } });
});

test("verifier config allowlists are handler-specific and fail closed for new fields and handlers", () => {
  const publicFields = {
    deterministic: { matchMode: "exact" }, benchmark: { anchorEvidence: "https://example.com" },
    human_fallback: { autoApprove: false, escalationMessage: "Review required" },
    github_pr: { minimumScore: 3, requireIssueReference: true, requireTestEvidence: true, acceptMergedAsApproved: true, requireClaimantBinding: true },
    future_handler: {}
  };
  const allFields = Object.assign({}, ...Object.values(publicFields));
  for (const [handler, fields] of Object.entries(publicFields)) {
    assert.deepEqual(redactPublicGraderFields({ verifierConfig: { handler, version: "v1", ...allFields, futureSecret: sentinel } }),
      { verifierConfig: { handler, version: "v1", ...fields } });
  }
});

test("source=curated matches postingRoute even when the source is a GitHub issue", async () => {
  const f = fixture();
  const result = await invokeHttpRoute(f.route, { method: "GET", path: "/jobs?source=curated" });
  assert.deepEqual(result.body.jobs.map((job) => job.id), ["curated-job"]);
  assertRedacted(result.body, "curated filter");
});
