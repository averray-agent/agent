import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { HumanVerdictService } from "./human-verdict-service.js";
import { VerifierService } from "./verifier-service.js";
import { VerificationIngestionService } from "./verification-ingestion-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { buildJobSnapshot } from "../core/job-snapshot.js";
import { buildAgentProfile } from "../core/agent-profile.js";
import { createAdminSessionsRoutes } from "../protocols/http/admin-sessions-routes.js";
import { resolveContentAccess } from "../core/content-addressed-store.js";

const wallet = `0x${"aa".repeat(20)}`, operator = `0x${"bb".repeat(20)}`;
const rationale = "Reviewed the submitted work against the pinned requirements.";
const original = { handler: "human_fallback", handlerVersion: 1, outcome: "disputed", reasonCode: "HUMAN_REVIEW_REQUIRED" };

async function fixture(options = {}) {
  const store = new MemoryStateStore(), calls = [], events = [];
  const job = { id: "curated-review-job", rewardAsset: "USDC", rewardAmount: 2, poster: operator, claimTtlSeconds: 3600,
    verifierMode: "human_fallback", verifierConfig: { handler: "human_fallback", version: 1 } };
  const session = await store.upsertSession({ sessionId: "human-session", jobId: job.id, chainJobId: `0x${"11".repeat(32)}`,
    wallet, status: "disputed", disputedAt: "2026-09-15T20:24:00Z", submittedAt: "2026-09-15T20:00:00Z",
    claimedAt: "2026-09-15T19:00:00Z", submission: { kind: "text", text: "Review me" },
    jobSnapshot: buildJobSnapshot(job), statusHistory: [{ to: "submitted" }, { to: "disputed" }] });
  await store.upsertVerificationResult(session.sessionId, original);
  const live = { state: 3, specHash: session.jobSnapshot.specHash, worker: wallet };
  let receipt;
  const gateway = { isEnabled: () => true, getJob: async () => ({ ...live }),
    resolveSinglePayout: async (...args) => {
      calls.push(args); live.state = args[1] ? 6 : 4;
      if (!args[1]) live.rejectedAt = Math.floor(Date.now() / 1000);
      receipt = { txHash: `0x${"55".repeat(32)}`, status: 1, blockNumber: 12, verifiedEvent: { reasoningHash: args[4], logIndex: 1 },
        ...(args[1] ? { settlement: { worker: wallet, workerAmount: 1.8, workerAmountRaw: "1800000",
          protocolFeeAmountRaw: "100000", protocolFeeAmount: 0.1, protocolFeeBps: 500, gasRetentionAmountRaw: "200000",
          rewardAmountRaw: "2000000", treasuryAccount: operator, assetSymbol: "USDC", asset: `0x${"cc".repeat(20)}` } } : {}) };
      return receipt;
    },
    recoverSinglePayoutReceipt: async () => { calls.push(["recover"]); return receipt; },
    openDispute: async () => { throw new Error("Human rejection must not open an arbitration dispute"); },
    resolveDispute: async () => { throw new Error("Human review must not call the arbitrator"); } };
  const ingestion = new VerificationIngestionService(store, { publish: (event) => events.push(event) }, undefined, { info() {}, warn() {} });
  const context = { posterAddress: operator, verifierAddress: operator, publicBaseUrl: "https://api.example.test" };
  ingestion.resolveReceiptSignerContext = async () => context;
  const platform = { resumeSession: (id) => store.getSession(id), resolveReceiptSignerContext: async () => context,
    ingestVerification: (...args) => ingestion.ingest(...args), getWorkerProgressionSafely: async () => ({ tier: "starter" }) };
  const verifier = new VerifierService(platform, store, gateway);
  const service = new HumanVerdictService({ stateStore: store, gateway, platformService: platform, verifierService: verifier,
    persistContentRecord: (record) => store.upsertContent(record), publicBaseUrl: "https://api.example.test", ...options });
  const decide = (verdict = "approve") => service.decide({ sessionId: session.sessionId, verdict, rationale, operator });
  return { store, session, live, calls, gateway, verifier, service, decide, platform, events };
}

test("human verdict under rendered mainnet env publishes the API rationale URI before settlement", async () => {
  const env = parseEnv(readFileSync(new URL("../../../deploy/backend.mainnet.env.template", import.meta.url), "utf8"));
  const f = await fixture({ publicBaseUrl: env.PUBLIC_BASE_URL });
  const settle = f.gateway.resolveSinglePayout;
  f.gateway.resolveSinglePayout = async (...args) => {
    assert.match(args[3], /^https:\/\/api\.averray\.com\/content\/0x[0-9a-f]{64}$/u);
    const hash = new URL(args[3]).pathname.slice("/content/".length);
    assert.equal(resolveContentAccess(await f.store.getContent(hash)).public, true);
    return settle(...args);
  };
  await f.decide();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.store.getSession(f.session.sessionId)).status, "resolved");
});

test("arbitration pin 5: human approve uses normal verifier settlement and receipts; reject stays Rejected, without opening arbitration", async () => {
  for (const verdict of ["approve", "reject"]) {
    const f = await fixture();
    const result = await f.decide(verdict);
    const session = await f.store.getSession(f.session.sessionId);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], verdict === "approve");
    assert.equal(f.calls[0][2], verdict === "approve" ? "HUMAN_REVIEW_APPROVED" : "HUMAN_REVIEW_REJECTED");
    assert.equal(session.status, verdict === "approve" ? "resolved" : "rejected");
    assert.equal(f.live.state, verdict === "approve" ? 6 : 4);
    if (verdict === "reject") assert.ok(f.live.rejectedAt > 0, "normal rejection starts the existing contract dispute clock");
    assert.equal(result.handler, "human_review"); assert.equal(result.decidedBy, operator);
    assert.equal(result.rationaleHash, session.humanReview.rationaleHash);
    assert.equal(session.payoutTx.txHash, session.humanReview.resolution.txHash);
    assert.ok(await f.store.getRunReceiptDocument(session.sessionId));
    assert.ok(await f.store.getWorkReceiptDocumentBySession(session.sessionId));
    if (verdict === "approve") assert.ok(await f.store.getBadgeDocument(session.sessionId));
    assert.equal(resolveContentAccess(await f.store.getContent(result.rationaleHash)).public, true);
    const history = session.statusHistory;
    await f.decide(verdict);
    assert.equal(f.calls.length, 1); assert.deepEqual((await f.store.getSession(session.sessionId)).statusHistory, history);
  }
});

test("human verdict refuses Disputed escrow, non-human, non-disputed, short rationale and conflicting retries without writes", async () => {
  for (const change of ["chain-disputed", "non-human", "local-submitted", "short"]) {
    const f = await fixture();
    if (change === "chain-disputed") f.live.state = 5;
    if (change === "non-human") await f.store.upsertVerificationResult(f.session.sessionId, { ...original, handler: "github_pr" });
    if (change === "local-submitted") await f.store.upsertSession({ ...f.session, status: "submitted" });
    await assert.rejects(change === "short" ? f.service.decide({ sessionId: f.session.sessionId, verdict: "approve", rationale: "short", operator }) : f.decide());
    assert.equal(f.calls.length, 0); assert.equal((await f.store.getSession(f.session.sessionId)).humanReview, undefined);
  }
  const f = await fixture(); await f.decide();
  await assert.rejects(f.decide("reject"), { code: "human_verdict_conflict" });
  assert.equal(f.calls.length, 1);
});

test("arbitration pin 6: human result is current, original fallback stays history and profile counts actual payout", async () => {
  const f = await fixture(); await f.decide();
  const result = await f.verifier.getResult(f.session.sessionId);
  assert.equal(result.outcome, "approved"); assert.deepEqual(result.originalVerdict, original);
  const session = await f.store.getSession(f.session.sessionId);
  const stored = await f.store.getVerificationResult(session.sessionId);
  assert.deepEqual(stored.originalVerdict, original);
  const profile = buildAgentProfile({ wallet, sessions: [{ ...session, verification: stored }] });
  assert.equal(profile.stats.rejectedCount, 0);
  assert.equal(profile.stats.totalEarned.amount, "1800000");
  assert.equal(profile.badges[0].reward.amount, "1800000");
  assert.deepEqual(profile.disputes, []);
});

test("human retry recovers a successful chain tx after a local failure, without a second payout", async () => {
  const f = await fixture();
  const settle = f.gateway.resolveSinglePayout;
  f.gateway.resolveSinglePayout = async (...args) => { await settle(...args); throw new Error("lost response after mining"); };
  await assert.rejects(f.decide(), /lost response/);
  assert.equal((await f.store.getSession(f.session.sessionId)).status, "disputed");
  assert.equal((await f.verifier.getResult(f.session.sessionId)).outcome, "disputed");
  await f.decide();
  assert.equal(f.calls.filter((call) => call[0] !== "recover").length, 1);
  assert.equal(f.calls.filter((call) => call[0] === "recover").length, 1);
  assert.equal((await f.store.getSession(f.session.sessionId)).status, "resolved");
});

test("human-verdict HTTP route requires admin before reading body and binds decidedBy to authenticated wallet", async () => {
  const f = await fixture();
  const pathname = "/admin/sessions/human-verdict", response = {};
  const input = { request: { method: "POST" }, response, pathname, url: new URL(pathname, "http://localhost") };
  const denied = createAdminSessionsRoutes({ authMiddleware: async (_r, _u, options) => {
    assert.deepEqual(options, { requireRole: "admin" }); throw new Error("denied");
  }, readJsonBody: () => assert.fail("body read before auth") });
  await assert.rejects(denied(input), /denied/);
  const route = createAdminSessionsRoutes({ humanVerdict: f.service,
    authMiddleware: async () => ({ wallet: operator }), readJsonBody: async () => ({ sessionId: f.session.sessionId, verdict: "approve", rationale, operator: wallet }),
    respond: (res, status, body) => Object.assign(res, { status, body }) });
  await route(input);
  assert.equal(response.status, 200); assert.equal(response.body.decidedBy, operator);
});
