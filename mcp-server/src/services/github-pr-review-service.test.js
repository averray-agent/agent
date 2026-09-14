import test from "node:test";
import assert from "node:assert/strict";
import { GithubPrReviewService } from "./github-pr-review-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { buildJobSnapshot } from "../core/job-snapshot.js";
import { VerifierService } from "./verifier-service.js";
import { VerifierRegistry } from "./verifier-handlers.js";
import { transitionSession } from "../core/session-state-machine.js";
import { normalizeSubmission } from "../core/submission.js";
import { createVerifierRoutes } from "../protocols/http/verifier-routes.js";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const submittedAt = "2026-09-12T00:00:00Z";
async function add(store, id, mode = "github_pr", status = "submitted") {
  const job = { id, title: id, rewardAmount: 1, rewardAsset: "USDC", verifierMode: mode,
    source: { type: "github_issue", repo: "owner/repo", issueNumber: 1 },
    verifierConfig: { handler: mode, version: 1, minimumScore: 80 } };
  return store.upsertSession({ sessionId: id, jobId: id, status, wallet, submittedAt,
    jobSnapshot: buildJobSnapshot(job), submission: normalizeSubmission({ prUrl: "https://github.com/owner/repo/pull/2",
      summary: "Fix issue #1", tests: "Local test passed" }) });
}

test("pending is exactly all submitted non-auto sessions, including sessions older than the first page; SLA is warning only", async () => {
  const store = new MemoryStateStore();
  await add(store, "old-pr");
  await add(store, "human", "human_fallback");
  for (let i = 0; i < 120; i++) await add(store, `auto-${i}`, i % 2 ? "deterministic" : "benchmark");
  for (const status of ["claimed", "rejected", "resolved", "disputed"]) await add(store, status, "github_pr", status);
  const service = new GithubPrReviewService({ stateStore: store, githubToken: "", verifierService: {
    previewSubmission: async () => ({ githubLookup: { state: "open", merged: false, ciStatus: "unknown" } })
  } });
  const now = new Date("2026-09-14T00:00:00Z");
  const queue = await service.pending({ now });
  assert.deepEqual(queue.items.map((i) => i.sessionId).sort(), ["human", "old-pr"]);
  assert.equal(queue.oldestAgeMs, 48 * 3_600_000);
  assert.equal(queue.items.find((i) => i.sessionId === "old-pr").upstream.state, "open");
  assert.deepEqual((await service.getStatus(new Date(now - 60_000))).warnings, []);
  assert.deepEqual((await service.getStatus(now)).warnings, []);
  const overdue = await service.getStatus(new Date(+now + 60_000));
  assert.equal(overdue.warnings[0].code, "github_pr_review_overdue");
  assert.equal(overdue.warnings[0].severity, "warning");
  assert.equal(overdue.oldestAgeMs, 48 * 3_600_000 + 60_000);
});

async function liveFixture() {
  const store = new MemoryStateStore();
  await add(store, "pr");
  const upstream = { merged: false, conclusion: "success", sha: "first" };
  const registry = new VerifierRegistry({ githubToken: "test-token", fetchImpl: async (url) => {
    if (url.endsWith("/status")) return Response.json({ statuses: [] });
    if (url.endsWith("/check-runs")) return Response.json({ check_runs: [{ name: "tests", status: "completed", conclusion: upstream.conclusion }] });
    if (url.endsWith("/reviews")) return Response.json([]);
    return Response.json({ html_url: "https://github.com/owner/repo/pull/2", state: upstream.merged ? "closed" : "open", merged: upstream.merged,
      head: { sha: upstream.sha }, title: "Fix #1", body: `Closes #1. Averray claimant wallet: ${wallet}` });
  } });
  const writes = [];
  const platform = { resumeSession: (id) => store.getSession(id), ingestVerification: async (id, verdict) => {
    writes.push(verdict);
    const session = transitionSession(await store.getSession(id), verdict.outcome === "approved" ? "resolved" : verdict.outcome === "disputed" ? "disputed" : "rejected");
    await store.upsertSession(session);
    await store.upsertVerificationResult(id, verdict);
    return session;
  } };
  const verifier = new VerifierService(platform, store, undefined, registry);
  return { store, upstream, verifier, writes, review: new GithubPrReviewService({ stateStore: store, verifierService: verifier, githubToken: "token" }) };
}

test("upstream change reruns the real verifier: merge approves, unchanged ticks do nothing, and failed checks never approve", async () => {
  for (const change of ["merge", "failure"]) {
    const f = await liveFixture();
    await f.review.runOnce();
    await f.review.runOnce();
    assert.equal(f.writes.length, 0);
    if (change === "merge") f.upstream.merged = true;
    else f.upstream.conclusion = "failure";
    const run = await f.review.runOnce();
    assert.deepEqual(run.errors, []);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].outcome, change === "merge" ? "approved" : "rejected");
    assert.equal((await f.store.getSession("pr")).status, change === "merge" ? "resolved" : "rejected");
    await f.review.runOnce();
    assert.equal(f.writes.length, 1);
  }
});

test("admin run authenticates as admin and persists the same handler verdict as verifier run; preview remains read-only", async () => {
  const outcomes = [];
  for (const pathname of ["/admin/verifier/run", "/verifier/run"]) {
    const f = await liveFixture();
    const auth = [], replies = [];
    const route = createVerifierRoutes({ verifierService: f.verifier,
      authMiddleware: async (_r, _u, o) => { auth.push(o); return { wallet }; },
      enforceLimit: async () => {}, rateLimitConfig: {}, readJsonBody: async () => ({ sessionId: "pr" }),
      respond: (_r, _s, body) => replies.push(body) });
    await route({ request: { method: "POST" }, response: {}, pathname, url: new URL(pathname, "http://localhost") });
    assert.equal(auth[0].requireRole, pathname.startsWith("/admin") ? "admin" : "verifier");
    assert.equal(f.writes.length, 1);
    assert.equal(replies[0].outcome, f.writes[0].outcome);
    outcomes.push(f.writes[0].outcome);
  }
  assert.deepEqual(outcomes, ["approved", "approved"]);
});
