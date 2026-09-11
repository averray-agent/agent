import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStateStore } from "../core/state-store.js";
import { buildJobSnapshot } from "../core/job-snapshot.js";
import { transitionSession } from "../core/session-state-machine.js";
import { QualityReviewService, loadQualityReviewConfig, walletQualitySummary } from "../core/quality-review.js";
import { buildWorkReceiptVerdictCore, computeVerdictCoreCommitment, assertWorkReceiptContentAddress } from "../core/work-receipt.js";
import { VerificationIngestionService } from "./verification-ingestion-service.js";
import { createProfileRoutes } from "../protocols/http/profile-routes.js";
import { createAdminStatusRoutes } from "../protocols/http/admin-status-routes.js";
import { createBadgeRoutes } from "../protocols/http/badge-routes.js";
import { writeDirectoryConsent } from "../core/directory-consent.js";

const WORKER = `0x${"1".repeat(40)}`;
const ADMIN = `0x${"2".repeat(40)}`;
const ORIGINAL_REPUTATION = { skill: 100, reliability: 80, economic: 20, tier: "pro" };
function harness(config = loadQualityReviewConfig({})) {
  const stateStore = new MemoryStateStore();
  const quality = new QualityReviewService({ stateStore, config });
  const service = new VerificationIngestionService(stateStore, undefined, undefined, { info() {}, warn() {} }, {
    qualityReviewService: quality,
    blockchainGateway: new Proxy({}, { get() { assert.fail("No on-chain calls in quality review"); } })
  });
  return { stateStore, quality, service };
}
async function prepare(h, index, mode = "benchmark") {
  const job = { id: `quality-job-${index}`, verifierMode: mode, verifierConfig: { handler: mode, version: 1 },
    rewardAsset: "USDC", rewardAmount: 0.25, claimTtlSeconds: 3600,
    source: { type: "github_issue", repo: "org/repo", issueNumber: index } };
  const session = transitionSession(transitionSession({ sessionId: `quality-${index}`, jobId: job.id,
    wallet: WORKER, submission: "evidence", jobSnapshot: buildJobSnapshot(job) }, "claimed", { reason: "claimed" }),
  "submitted", { reason: "submitted" });
  await h.stateStore.upsertSession(session);
  const payoutTx = { status: 1, txHash: `0x${"3".repeat(64)}`, settlement: {
    worker: WORKER, treasuryAccount: ADMIN, asset: "0x0000053900000000000000000000000001200000", assetSymbol: "USDC",
    workerAmount: 0.2, workerAmountRaw: "200000", protocolFeeAmount: 0.05, protocolFeeAmountRaw: "50000", protocolFeeBps: 500,
    gasRetention: { retainedRaw: "50000", rewardRaw: "250000" }
  } };
  const verdict = { outcome: "approved", handler: mode, handlerVersion: 1, reasonCode: "APPROVED", payoutTx, settlement: payoutTx.settlement };
  const receiptContext = { posterAddress: ADMIN };
  payoutTx.verifiedEvent = { logIndex: 1, reasoningHash: computeVerdictCoreCommitment(buildWorkReceiptVerdictCore({ session, job, verification: verdict, context: receiptContext })) };
  return { session, job, verdict, options: { payoutTx, receiptContext } };
}
async function settle(h, index, mode) {
  const fixture = await prepare(h, index, mode);
  return h.service.ingest(fixture.session.sessionId, fixture.verdict, fixture.options);
}

test("quality pin: five approved benchmark settlements queue exactly one and every receipt has an explicit sampled boolean", async () => {
  const h = harness();
  const sessions = [];
  for (let index = 1; index <= 5; index++) sessions.push(await settle(h, index));
  const queue = await h.quality.listPending();
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.pending[0].sessionId, "quality-5");
  assert.deepEqual(sessions.map((session) => session.qualityReview.sampled), [false, false, false, false, true]);
  for (const session of sessions) {
    const receipt = await h.stateStore.getWorkReceiptDocument(session.workReceiptId);
    assert.equal(typeof receipt.review.sampled, "boolean");
    assert.equal(receipt.review.sampled, session.qualityReview.sampled);
  }
  const deterministic = await settle(h, "deterministic", "deterministic");
  assert.equal((await h.stateStore.getWorkReceiptDocument(deterministic.workReceiptId)).review.sampled, false);
  assert.equal((await h.quality.listPending()).pending.length, 1);
});

test("quality pin: configured weight reaches off-chain wallet quality while session and receipt store the score and chain reputation stays unchanged", async () => {
  const h = harness(loadQualityReviewConfig({ QUALITY_SAMPLE_EVERY: "1", QUALITY_REVIEW_REPUTATION_WEIGHT: "20" }));
  const session = await settle(h, 1);
  const original = await h.stateStore.getWorkReceiptDocument(session.workReceiptId);
  const reviewed = await h.service.recordQualityReview({ sessionId: session.sessionId, qualityScore: 5, note: "Verified the actual artifact.", reviewer: ADMIN });
  assert.equal(reviewed.qualityScore, 5);
  assert.equal(reviewed.qualityReview.reliabilityAdjustment, 40);
  const receipt = await h.stateStore.getWorkReceiptDocument(reviewed.qualityReview.receiptId);
  assert.equal(receipt.review.score, 5);
  assert.equal(receipt.review.reliabilityAdjustment, 40);
  assert.equal(receipt.review.reputationWeight, 20);
  assert.equal(receipt.review.onchainApplied, false);
  assert.equal(receipt.review.reviewedAt, reviewed.qualityReview.reviewedAt);
  assertWorkReceiptContentAddress(receipt);
  assert.equal(computeVerdictCoreCommitment(receipt), computeVerdictCoreCommitment(original));
  assert.deepEqual(await h.stateStore.getWorkReceiptDocument(original.receiptId), original);
  assert.equal(receipt.reviewOf, original.receiptId);
  const receipts = createBadgeRoutes({ stateStore: h.stateStore,
    respond: (res, status, body) => Object.assign(res, { status, body }) });
  for (const id of [session.sessionId, session.jobId]) {
    const response = {};
    await receipts({ request: { method: "GET" }, response, pathname: `/receipts/${id}` });
    assert.equal(response.body.receiptId, receipt.receiptId, "session/job aliases discover the reviewed receipt");
  }
  const unchanged = {};
  await receipts({ request: { method: "GET" }, response: unchanged, pathname: `/receipts/${original.receiptId}` });
  assert.equal(unchanged.body.review.score, undefined, "exact content IDs remain immutable");
  assert.equal((await h.quality.listPending()).pending.length, 0);
  assert.deepEqual(await h.service.recordQualityReview({ sessionId: session.sessionId, qualityScore: 5, note: "Verified the actual artifact.", reviewer: ADMIN }), reviewed);
  await assert.rejects(h.service.recordQualityReview({ sessionId: session.sessionId, qualityScore: 4, note: "changed", reviewer: ADMIN }), { code: "quality_review_already_recorded" });

  h.quality.config = loadQualityReviewConfig({ QUALITY_SAMPLE_EVERY: "1", QUALITY_REVIEW_REPUTATION_WEIGHT: "7" });
  await settle(h, 2);
  await h.service.recordQualityReview({ sessionId: "quality-2", qualityScore: 1, note: "Material quality gaps.", reviewer: ADMIN });
  const history = await h.stateStore.listRecentSessions(20);
  const summary = walletQualitySummary(history, WORKER);
  assert.equal(summary.qualityAverage, 3);
  assert.equal(summary.qualityReviewCount, 2);
  assert.equal(summary.qualityReliabilityAdjustment, 26, "40 + (1 - 3) * 7, not today's weight on old reviews");
  await writeDirectoryConsent(h.stateStore, WORKER, { publicProfileOptIn: true, currentActivityOptIn: false });
  const route = createProfileRoutes({ stateStore: h.stateStore, env: {}, parseLimit: () => 50,
    respond: (res, status, body) => Object.assign(res, { status, body }), service: {
      listRecentSessionRecords: async () => history,
      collectSessionHistory: async () => history,
      getReputation: async () => ({ ...ORIGINAL_REPUTATION }),
      getJobDefinition: () => undefined
    } });
  for (const path of ["/agents", `/agents/${WORKER}`]) {
    const response = {};
    await route({ request: { method: "GET" }, response, url: new URL(`http://localhost${path}`), pathname: path });
    const row = Array.isArray(response.body) ? response.body[0] : response.body;
    assert.equal(response.status, 200);
    assert.equal(row.qualityAverage, 3);
    assert.equal(row.qualityReliabilityAdjustment, 26);
    assert.equal(row.qualityOnchainApplied, false);
    if (row.reputation) assert.deepEqual(row.reputation, ORIGINAL_REPUTATION);
    else assert.equal(row.reputationScore, 200);
  }
});

test("quality sampling persists across restart, concurrent ingestion, and retry after a failed terminal write", async () => {
  const h = harness();
  const fixtures = await Promise.all([1, 2, 3, 4, 5].map((n) => prepare(h, n)));
  const upsert = h.stateStore.upsertSession.bind(h.stateStore);
  let fail = true;
  h.stateStore.upsertSession = async (session) => {
    if (session.sessionId === "quality-5" && session.status === "resolved" && fail) { fail = false; throw new Error("disk unavailable"); }
    return upsert(session);
  };
  const outcomes = await Promise.allSettled(fixtures.map((f) => h.service.ingest(f.session.sessionId, f.verdict, f.options)));
  assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await h.quality.listPending()).pending.length, 0, "no review of an uncommitted terminal session");
  h.service.qualityReviewService = new QualityReviewService({ stateStore: h.stateStore });
  const fifth = fixtures[4];
  const retried = await h.service.ingest(fifth.session.sessionId, fifth.verdict, fifth.options);
  assert.equal(retried.qualityReview.ordinal, 5);
  assert.equal((await h.service.qualityReviewService.listPending()).pending.length, 1);
});

test("quality reviews require admin role, bounded human input, sampling and a persisted receipt", async () => {
  const h = harness();
  const session = await settle(h, 1);
  for (const qualityScore of [-1, 6, 1.5, "5"]) await assert.rejects(h.service.recordQualityReview({ sessionId: session.sessionId, qualityScore, note: "note", reviewer: ADMIN }), { code: "invalid_request" });
  await assert.rejects(h.service.recordQualityReview({ sessionId: session.sessionId, qualityScore: 5, note: "", reviewer: ADMIN }), { code: "invalid_request" });
  await assert.rejects(h.service.recordQualityReview({ sessionId: session.sessionId, qualityScore: 5, note: "note", reviewer: ADMIN }), { code: "quality_review_not_sampled" });
  for (const method of ["GET", "POST"]) {
    const route = createAdminStatusRoutes({ service: { verificationIngestionService: h.service },
      authMiddleware: async (_request, _url, options) => { assert.equal(options.requireRole, "admin"); throw new Error("forbidden"); }
    });
    await assert.rejects(route({ request: { method }, url: new URL("http://localhost/admin/quality-reviews"), pathname: "/admin/quality-reviews" }), /forbidden/u);
  }
  const config = loadQualityReviewConfig({});
  assert.equal(config.onchainEnabled, false);
  assert.equal(config.reputationWeight, 20);
  assert.throws(() => loadQualityReviewConfig({ QUALITY_REVIEW_ONCHAIN_ENABLED: "true" }), /quality_reputation_aggregate_not_cumulative/u);
});

test("quality review receipt failure leaves the sample pending; admin POST then persists once with authenticated identity", async () => {
  const h = harness(loadQualityReviewConfig({ QUALITY_SAMPLE_EVERY: "1" }));
  const session = await settle(h, 1);
  const put = h.stateStore.putWorkReceiptDocument.bind(h.stateStore);
  h.stateStore.putWorkReceiptDocument = async () => { throw new Error("receipt store unavailable"); };
  await assert.rejects(h.service.recordQualityReview({ sessionId: session.sessionId, qualityScore: 0, note: "Failed human review", reviewer: ADMIN }), /receipt store unavailable/u);
  assert.equal((await h.stateStore.getSession(session.sessionId)).qualityScore, undefined);
  assert.equal((await h.quality.listPending()).pending.length, 1);
  h.stateStore.putWorkReceiptDocument = put;
  let limits = 0;
  const route = createAdminStatusRoutes({
    authMiddleware: async (_req, _url, options) => { assert.equal(options.requireRole, "admin"); return { wallet: ADMIN }; },
    readJsonBody: async () => ({ sessionId: session.sessionId, qualityScore: 0, note: "Failed human review", reviewer: WORKER, reputationWeight: 999 }),
    enforceLimit: async () => { limits++; }, rateLimitConfig: { adminJobs: {} },
    buildIdempotentMutationContext: (input) => { assert.equal(input.bucket, "quality_review"); return input; },
    getIdempotentMutationReplay: async () => undefined,
    respondWithMutationReceipt: (res, _ctx, status, body) => Object.assign(res, { status, body }),
    service: { verificationIngestionService: h.service }
  });
  const response = {};
  await route({ request: { method: "POST" }, response, url: new URL("http://localhost/admin/quality-reviews"), pathname: "/admin/quality-reviews" });
  assert.equal(response.status, 200);
  assert.equal(response.body.review.reviewer, ADMIN);
  assert.equal(response.body.review.reputationWeight, 20);
  assert.equal(response.body.review.reliabilityAdjustment, -60);
  assert.equal(response.body.qualityScore, 0);
  assert.equal(limits, 1);
  assert.equal((await h.quality.listPending()).pending.length, 0);
});
