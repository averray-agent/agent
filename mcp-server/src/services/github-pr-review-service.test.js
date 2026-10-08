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
import { createProductHealthSnapshotProvider } from "../core/health-capability.js";

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

test("empty GitHub poll is explicitly idle while never-run remains not checked", async () => {
  const store = new MemoryStateStore();
  await add(store, "human", "human_fallback");
  const review = new GithubPrReviewService({ stateStore: store, githubToken: "token" });
  const now = new Date("2026-10-08T12:00:00Z");
  assert.equal((await review.getStatus(now)).githubUpstream.lastError, "github_not_checked");
  await review.runOnce(now);
  assert.deepEqual((await review.getStatus(new Date(+now + 86400_000))).githubUpstream,
    { ok: true, state: "idle", lastSuccessAt: null, lastError: null });
  await add(store, "new-pr");
  assert.equal((await review.getStatus(now)).githubUpstream.state, "pending");
  assert.equal((await review.getStatus(now)).githubUpstream.ok, false);
});

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

test("changed upstream with a rejected preview updates the observation without calling verifySubmission and stays submitted", async (t) => {
  const f = await liveFixture();
  f.upstream.conclusion = "failure";
  const settle = t.mock.method(f.verifier, "verifySubmission");
  await f.review.runOnce(new Date("2026-09-14T00:00:00Z"));
  const before = await f.store.getMutationReceipt("github_pr_review_observation", "pr");
  assert.equal(settle.mock.callCount(), 0);

  f.upstream.sha = "changed-rejected-head";
  assert.equal((await f.verifier.previewSubmission({ sessionId: "pr" })).outcome, "rejected");
  const now = new Date("2026-09-14T00:30:00Z");
  const run = await f.review.runOnce(now);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.reviewed, []);
  assert.deepEqual(run.observed, ["pr"]);
  assert.equal(settle.mock.callCount(), 0);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.store.getSession("pr")).status, "submitted");
  assert.deepEqual((await f.review.pending()).items.map((item) => item.sessionId), ["pr"]);
  const after = await f.store.getMutationReceipt("github_pr_review_observation", "pr");
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(after.observedAt, now.toISOString());
  assert.deepEqual((await f.review.runOnce()).observed, []);
  assert.equal(settle.mock.callCount(), 0);
});

test("changed upstream with an approved merged preview settles; non-approved baseline and unchanged ticks do not", async (t) => {
  const f = await liveFixture();
  f.upstream.conclusion = "failure";
  const settle = t.mock.method(f.verifier, "verifySubmission");
  await f.review.runOnce();
  await f.review.runOnce();
  assert.equal(settle.mock.callCount(), 0);
  f.upstream.merged = true;
  assert.equal((await f.verifier.previewSubmission({ sessionId: "pr" })).outcome, "approved");
  const run = await f.review.runOnce();
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.reviewed, [{ sessionId: "pr", outcome: "approved" }]);
  assert.equal(settle.mock.callCount(), 1);
  assert.deepEqual(settle.mock.calls[0].arguments, [{ sessionId: "pr", expectOutcome: "approved" }]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].outcome, "approved");
  assert.equal((await f.store.getSession("pr")).status, "resolved");
  await f.review.runOnce();
  assert.equal(settle.mock.callCount(), 1);
});

test("open green approved PR is observation-only and counted as awaiting human review", async (t) => {
  const f = await liveFixture();
  const settle = t.mock.method(f.verifier, "verifySubmission");
  assert.equal((await f.verifier.previewSubmission({ sessionId: "pr" })).outcome, "approved");
  await f.review.runOnce();
  assert.equal(settle.mock.callCount(), 0);
  assert.equal((await f.store.getSession("pr")).status, "submitted");
  const observation = await f.store.getMutationReceipt("github_pr_review_observation", "pr");
  assert.equal(observation.previewOutcome, "approved");
  assert.equal(observation.merged, false);
  const snapshot = await createProductHealthSnapshotProvider({ stateStore: f.store, getRewardBankHealth: async () => ({}) })();
  assert.equal(snapshot.settlement.awaitingHumanReview, 1);
  assert.equal(snapshot.settlement.stuck, 0);
});

test("merged non-approved PR records observation and never settles", async (t) => {
  const f = await liveFixture();
  const settle = t.mock.method(f.verifier, "verifySubmission");
  t.mock.method(f.verifier, "previewSubmission", async () => ({ outcome: "rejected",
    githubLookup: { status: "verified", merged: true, headSha: "merged-rejected" } }));
  const run = await f.review.runOnce();
  assert.deepEqual(run.observed, ["pr"]);
  assert.equal(settle.mock.callCount(), 0);
  assert.equal((await f.store.getMutationReceipt("github_pr_review_observation", "pr")).previewOutcome, "rejected");
  assert.equal((await f.store.getSession("pr")).status, "submitted");
});

test("first observation of an approved merged PR settles once with the server-side outcome guard", async (t) => {
  const f = await liveFixture();
  f.upstream.merged = true;
  const settle = t.mock.method(f.verifier, "verifySubmission");
  const pendingBeforeSettlement = await f.review.pending();
  const now = new Date("2026-10-07T18:30:00Z");
  const run = await f.review.runOnce(now);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.reviewed, [{ sessionId: "pr", outcome: "approved" }]);
  assert.deepEqual(settle.mock.calls[0].arguments, [{ sessionId: "pr", expectOutcome: "approved" }]);
  assert.equal((await f.store.getSession("pr")).status, "resolved");
  assert.equal((await f.store.getMutationReceipt("github_pr_review_observation", "pr")).previewOutcome, "approved");
  await f.review.runOnce(now);
  assert.equal(settle.mock.callCount(), 1);
  // Receipt loss and even a stale queue snapshot cannot pay a resolved session again.
  t.mock.method(f.store, "getMutationReceipt", async () => undefined);
  t.mock.method(f.review, "pending", async () => pendingBeforeSettlement);
  await f.review.runOnce(now);
  assert.equal(settle.mock.callCount(), 1);
});

test("an unchanged approved fingerprint retries failed settlement and also recovers a legacy observation receipt", async (t) => {
  for (const legacy of [false, true]) {
    const f = await liveFixture();
    f.upstream.merged = true;
    const original = f.verifier.verifySubmission.bind(f.verifier);
    let calls = 0;
    t.mock.method(f.verifier, "verifySubmission", async (args) => {
      calls += 1;
      assert.equal(args.expectOutcome, "approved");
      if (calls === 1) throw new Error("settlement temporarily unavailable");
      return original(args);
    });
    const first = await f.review.runOnce();
    assert.equal(first.errors.length, 1);
    assert.equal((await f.store.getSession("pr")).status, "submitted");
    const receipt = await f.store.getMutationReceipt("github_pr_review_observation", "pr");
    assert.equal(receipt.previewOutcome, "approved");
    if (legacy) {
      delete receipt.previewOutcome;
      await f.store.upsertMutationReceipt("github_pr_review_observation", "pr", receipt);
    }
    const second = await f.review.runOnce();
    assert.deepEqual(second.errors, []);
    assert.deepEqual(second.reviewed, [{ sessionId: "pr", outcome: "approved" }]);
    assert.equal(calls, 2);
    assert.equal(f.writes.length, 1);
    assert.equal((await f.store.getSession("pr")).status, "resolved");
  }
});

test("poller GitHub health reports unavailable, partial, recovered and stale reads without raw error text", async (t) => {
  const store = new MemoryStateStore();
  await add(store, "pr");
  let lookup = { status: "unavailable", reason: "github_api_401" };
  const verifySubmission = t.mock.fn();
  const review = new GithubPrReviewService({ stateStore: store, githubToken: "token", intervalMs: 60_000,
    verifierService: { previewSubmission: async () => ({ outcome: "rejected", githubLookup: lookup }), verifySubmission } });
  const now = new Date("2026-10-07T18:30:00Z");
  assert.deepEqual((await review.getStatus(now)).githubUpstream,
    { ok: false, lastSuccessAt: null, lastError: "github_not_checked" });
  await review.runOnce(now);
  assert.deepEqual((await review.getStatus(now)).githubUpstream,
    { ok: false, lastSuccessAt: null, lastError: "github_api_401" });
  lookup = { status: "unavailable", reason: "private token and request details must stay out of health" };
  await review.runOnce(now);
  assert.equal((await review.getStatus(now)).githubUpstream.lastError, "github_lookup_unavailable");
  lookup = { status: "verified", partial: { reviews: "unavailable" } };
  await review.runOnce(now);
  assert.equal((await review.getStatus(now)).githubUpstream.lastError, "github_lookup_partial");
  lookup = { status: "verified", merged: false, headSha: "healthy" };
  await review.runOnce(now);
  assert.deepEqual((await review.getStatus(now)).githubUpstream,
    { ok: true, lastSuccessAt: now.toISOString(), lastError: null });
  assert.deepEqual((await review.getStatus(new Date(+now + 120_001))).githubUpstream,
    { ok: false, lastSuccessAt: now.toISOString(), lastError: "github_read_stale" });
  assert.equal(verifySubmission.mock.callCount(), 0);
});

test("approved preview cannot settle partial upstream evidence or a session that left submitted", async (t) => {
  for (const partial of [true, false]) {
    const store = new MemoryStateStore();
    await add(store, "pr");
    const verifySubmission = t.mock.fn();
    const review = new GithubPrReviewService({ stateStore: store, githubToken: "token", verifierService: {
      previewSubmission: async () => {
        if (!partial) await store.upsertSession({ ...await store.getSession("pr"), status: "resolved" });
        return { outcome: "approved", githubLookup: { status: "verified", merged: true,
          partial: { reviews: partial ? "unavailable" : "available" } } };
      }, verifySubmission
    } });
    await review.runOnce();
    assert.equal(verifySubmission.mock.callCount(), 0);
  }
});

test("one healthy GitHub item cannot hide another failed read in the same poll", async () => {
  const store = new MemoryStateStore();
  await add(store, "a-unavailable");
  await add(store, "z-healthy");
  const review = new GithubPrReviewService({ stateStore: store, githubToken: "token", verifierService: {
    previewSubmission: async ({ sessionId }) => ({ outcome: "rejected", githubLookup: sessionId === "z-healthy"
      ? { status: "verified", headSha: "good" } : { status: "unavailable", reason: "github_api_403" } })
  } });
  const now = new Date("2026-10-07T18:30:00Z");
  await review.runOnce(now);
  assert.deepEqual((await review.getStatus(now)).githubUpstream,
    { ok: false, lastSuccessAt: now.toISOString(), lastError: "github_api_403" });
});

test("every other preview outcome is observation-only and leaves the session in the submitted queue", async (t) => {
  for (const outcome of ["disputed", "platform_fault", "inconclusive", "unknown", undefined]) {
    const store = new MemoryStateStore();
    await add(store, "pr");
    const githubLookup = { status: "verified", merged: true, state: "closed", headSha: "first" };
    const verifySubmission = t.mock.fn(async () => { throw new Error("Must not settle a non-approved preview"); });
    const review = new GithubPrReviewService({ stateStore: store, githubToken: "token", verifierService: {
      previewSubmission: async () => ({ outcome, githubLookup }), verifySubmission
    } });
    await review.runOnce(new Date("2026-09-14T00:00:00Z"));
    const before = await store.getMutationReceipt("github_pr_review_observation", "pr");
    githubLookup.headSha = "changed";
    const now = new Date("2026-09-14T00:30:00Z");
    const run = await review.runOnce(now);
    assert.equal(verifySubmission.mock.callCount(), 0, `preview: ${outcome}`);
    assert.deepEqual(run.errors, []);
    assert.deepEqual(run.reviewed, []);
    assert.deepEqual(run.observed, ["pr"]);
    assert.equal((await store.getSession("pr")).status, "submitted");
    assert.deepEqual((await review.pending()).items.map((item) => item.sessionId), ["pr"]);
    const after = await store.getMutationReceipt("github_pr_review_observation", "pr");
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.equal(after.observedAt, now.toISOString());
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
