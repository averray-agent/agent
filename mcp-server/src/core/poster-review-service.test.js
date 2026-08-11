import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "./state-store.js";
import { VerificationIngestionService } from "../services/verification-ingestion-service.js";
import { VerifierService } from "../services/verifier-service.js";
import {
  PosterReviewService,
  POSTER_REVIEW_REASON_CODES
} from "./poster-review-service.js";
import { buildJobSnapshot } from "./job-snapshot.js";

const JOB_ID = `0x${"a".repeat(64)}`;
const POSTER = "0x1111111111111111111111111111111111111111";
const OTHER_POSTER = "0x2222222222222222222222222222222222222222";
const ARBITRARY = "0x3333333333333333333333333333333333333333";
const ADMIN = "0x4444444444444444444444444444444444444444";
const WORKER = "0x5555555555555555555555555555555555555555";
const ESCROW = "0x6666666666666666666666666666666666666666";
const TREASURY = "0x7777777777777777777777777777777777777777";
const USDC = "0x8888888888888888888888888888888888888888";
const SUBMITTED_AT = "2026-08-01T10:00:00.000Z";

async function makeHarness({
  sessionStatus = "submitted",
  liveState = 3,
  now = "2026-08-01T11:00:00.000Z",
  canonicalReceipts = false,
  badgeReceiptSigner = undefined
} = {}) {
  const calls = [];
  const stateStore = new MemoryStateStore();
  const session = {
    sessionId: "session-external-1",
    idempotencyKey: "claim-1",
    jobId: JOB_ID,
    chainJobId: JOB_ID,
    wallet: WORKER,
    status: sessionStatus,
    submission: {
      summary: "Implementation report",
      report: "Affected files, registration pattern, and validation plan."
    },
    claimedAt: "2026-08-01T09:55:00.000Z",
    submittedAt: SUBMITTED_AT,
    protocolHistory: ["http"],
    statusHistory: []
  };
  const job = {
    id: JOB_ID,
    title: "External job",
    category: "coding",
    rewardAmount: 1,
    rewardAsset: "USDC",
    verifierMode: "human_fallback",
    outputSchemaRef: "schema://jobs/coding-output",
    source: { type: "external", poster: { wallet: POSTER } },
    poster: { wallet: POSTER }
  };
  session.jobSnapshot = buildJobSnapshot(job);
  await stateStore.upsertSession(session);
  let liveJob = {
    escrowAddress: ESCROW,
    poster: POSTER,
    worker: WORKER,
    asset: USDC,
    state: liveState,
    rewardRaw: "1000000",
    releasedRaw: "0",
    protocolFeeRaw: "50000",
    protocolFeeReleasedRaw: "0",
    protocolFeeBps: 500,
    protocolFeeWaived: false,
    specHash: session.jobSnapshot.specHash,
    rejectedAt: 0
  };
  const platformService = {
    getJobDefinition(id) {
      if (id !== JOB_ID) throw new Error("not found");
      return job;
    },
    resumeSession(id) {
      return stateStore.getSession(id);
    }
  };
  const gateway = {
    isEnabled: () => true,
    async getJob(id) {
      calls.push(["getJob", id, liveJob.state]);
      return { ...liveJob };
    },
    async resolveSinglePayout(id, approved, reasonCode, metadataURI, reasoningHash) {
      calls.push(["resolveSinglePayout", { id, approved, reasonCode, metadataURI, reasoningHash }]);
      if (approved) {
        liveJob = {
          ...liveJob,
          state: 6,
          releasedRaw: "1000000",
          protocolFeeReleasedRaw: "50000"
        };
      } else {
        liveJob = {
          ...liveJob,
          state: 4,
          rejectedAt: 1_754_044_800
        };
      }
      return {
        txHash: approved ? "0xapprove" : "0xreject",
        blockNumber: approved ? 101 : 102,
        status: 1,
        ...(approved ? {
          settlement: {
            worker: WORKER,
            treasuryAccount: TREASURY,
            asset: USDC,
            workerAmountRaw: "1000000",
            protocolFeeAmountRaw: "50000",
            protocolFeeBps: 500
          }
        } : {})
      };
    },
    async getDisputeWindowSeconds() {
      calls.push(["getDisputeWindowSeconds"]);
      return 604_800;
    },
    async getProtocolFeeConfig() {
      calls.push(["getProtocolFeeConfig"]);
      return { protocolFeeBps: 500, treasuryAccount: TREASURY };
    },
    async openDispute(id, worker) {
      calls.push(["openDispute", { id, worker }]);
      liveJob = { ...liveJob, state: 5 };
      return { txHash: "0xdispute", blockNumber: 103, status: 1 };
    },
    async requireArbitratorSigner() {
      calls.push(["requireArbitratorSigner"]);
      throw new Error("out-of-band hardware must not block opening");
    }
  };
  const verifierService = {
    async ingestBrokeredDecision(decision) {
      calls.push(["ingestBrokeredDecision", decision]);
      const current = await stateStore.getSession(decision.sessionId);
      const status = decision.outcome === "approved"
        ? "resolved"
        : decision.outcome === "rejected"
          ? "rejected"
          : "disputed";
      const updated = await stateStore.upsertSession({ ...current, status });
      const result = { ...decision, session: updated };
      await stateStore.upsertVerificationResult(decision.sessionId, result);
      return result;
    }
  };
  let canonicalIngestion;
  if (canonicalReceipts) {
    platformService.ingestVerification = (sessionId, verdict) => (
      canonicalIngestion.ingest(sessionId, verdict)
    );
    canonicalIngestion = new VerificationIngestionService(
      stateStore,
      undefined,
      () => job,
      { info() {}, warn() {} },
      { badgeReceiptSigner }
    );
  }
  const decisionVerifierService = canonicalReceipts
    ? new VerifierService(platformService, stateStore, gateway)
    : verifierService;
  const service = new PosterReviewService({
    platformService,
    stateStore,
    gateway,
    verifierService: decisionVerifierService,
    config: {
      reviewWindowHours: 168,
      escrowCoreAddress: ESCROW
    },
    now: () => new Date(now),
    logger: { warn() {} }
  });
  return {
    calls,
    gateway,
    job,
    service,
    stateStore,
    getLiveJob: () => ({ ...liveJob }),
    setLiveJob: (value) => { liveJob = { ...liveJob, ...value }; }
  };
}

test("authz matrix: poster-of-job SIWE can decide", async () => {
  const { service } = await makeHarness();
  const receipt = await service.reviewSubmission(JOB_ID, {
    wallet: POSTER,
    verdict: "approve"
  });
  assert.equal(receipt.status, "settled");
  assert.equal(receipt.decision, "approve");
  assert.equal(receipt.decidedBy, POSTER);
});

for (const [name, wallet] of [
  ["different enrolled poster", OTHER_POSTER],
  ["arbitrary wallet", ARBITRARY]
]) {
  test(`authz matrix: ${name} cannot decide`, async () => {
    const { service } = await makeHarness();
    await assert.rejects(
      service.reviewSubmission(JOB_ID, { wallet, verdict: "approve" }),
      (error) => error?.code === "poster_review_not_job_poster" && error?.statusCode === 403
    );
  });
}

test("submission read conceals an unauthorized wallet with the public 404 shape", async () => {
  const { service } = await makeHarness();
  await assert.rejects(
    service.getSubmissionForReview(JOB_ID, { wallet: ARBITRARY }),
    (error) => error?.code === "external_job_submission_not_found"
      && error?.statusCode === 404
  );
});

test("authz matrix: admin wallet path is retained", async () => {
  const { service } = await makeHarness();
  const receipt = await service.reviewSubmission(JOB_ID, {
    wallet: ADMIN,
    isAdmin: true,
    verdict: "approve",
    reason: "Operator support approval."
  });
  assert.equal(receipt.status, "settled");
  assert.equal(receipt.authority, "admin");
  assert.equal(receipt.decidedBy, ADMIN);
});

test("authz matrix: poster cannot decide a job outside Submitted", async () => {
  const { service } = await makeHarness({ sessionStatus: "claimed", liveState: 2 });
  await assert.rejects(
    service.reviewSubmission(JOB_ID, { wallet: POSTER, verdict: "approve" }),
    (error) => error?.code === "poster_review_state_changed"
      && error?.details?.sessionStatus === "claimed"
      && error?.details?.liveState === 2
  );
});

test("race matrix: claim-expiry reopen wins over a stale local Submitted session", async () => {
  const { calls, service } = await makeHarness({ sessionStatus: "submitted", liveState: 1 });
  await assert.rejects(
    service.reviewSubmission(JOB_ID, { wallet: POSTER, verdict: "approve" }),
    (error) => error?.code === "poster_review_state_changed"
      && error?.details?.liveState === 1
  );
  assert.equal(calls.some(([name]) => name === "resolveSinglePayout"), false);
});

test("authz matrix: second decision is an idempotent no-op returning the recorded outcome", async () => {
  const { calls, service } = await makeHarness();
  const first = await service.reviewSubmission(JOB_ID, {
    wallet: POSTER,
    verdict: "approve"
  });
  const second = await service.reviewSubmission(JOB_ID, {
    wallet: POSTER,
    verdict: "reject",
    reason: "A contradictory later decision."
  });
  assert.equal(second.decision, "approve");
  assert.equal(second.replayed, true);
  assert.equal(second.rationaleHash, first.rationaleHash);
  assert.equal(calls.filter(([name]) => name === "resolveSinglePayout").length, 1);
});

test("idempotency: an interrupted recorded decision resumes only the same broker action", async () => {
  const { gateway, service } = await makeHarness();
  const settle = gateway.resolveSinglePayout;
  gateway.resolveSinglePayout = async () => {
    throw new Error("temporary broker interruption");
  };
  await assert.rejects(
    service.reviewSubmission(JOB_ID, { wallet: POSTER, verdict: "approve" }),
    /temporary broker interruption/u
  );
  gateway.resolveSinglePayout = settle;
  const receipt = await service.reviewSubmission(JOB_ID, {
    wallet: POSTER,
    verdict: "approve"
  });
  assert.equal(receipt.status, "settled");
  assert.equal(receipt.decision, "approve");
});

test("idempotency: a chain-confirmed approval resumes signed receipt persistence without re-settling", async () => {
  let failReceiptSigning = true;
  const signer = {
    async signDocument() {
      if (failReceiptSigning) throw new Error("simulated signed-receipt interruption");
      return {
        alg: "ES256",
        kid: "badge-1",
        sig: "protected..signature",
        signedAt: "2026-08-01T11:00:00.000Z"
      };
    }
  };
  const { calls, service, stateStore } = await makeHarness({
    canonicalReceipts: true,
    badgeReceiptSigner: signer
  });

  await assert.rejects(
    service.reviewSubmission(JOB_ID, {
      wallet: POSTER,
      verdict: "approve",
      reason: "The submission meets every acceptance criterion."
    }),
    /simulated signed-receipt interruption/u
  );
  assert.equal((await stateStore.getSession("session-external-1")).status, "submitted");
  assert.equal(calls.filter(([name]) => name === "resolveSinglePayout").length, 1);

  failReceiptSigning = false;
  const receipt = await service.reviewSubmission(JOB_ID, {
    wallet: POSTER,
    verdict: "approve",
    reason: "The submission meets every acceptance criterion."
  });
  const runReceipt = await stateStore.getRunReceiptDocument("session-external-1");

  assert.equal(receipt.status, "settled");
  assert.equal(receipt.payoutTx.txHash, "0xapprove");
  assert.equal(calls.filter(([name]) => name === "resolveSinglePayout").length, 1);
  assert.equal((await stateStore.getSession("session-external-1")).status, "resolved");
  assert.equal(runReceipt.verifier.handler, "poster_review");
  assert.equal(runReceipt.verifier.version, 1);
  assert.equal(runReceipt.verifier.wallet, POSTER);
  assert.equal(runReceipt.verdict.outcome, "approved");
  assert.equal(runReceipt.verdict.rationaleHash, receipt.rationaleHash);
  assert.equal(runReceipt.signature.kid, "badge-1");
});

test("convergence refuses a foreign final state without our chain-confirmed receipt", async () => {
  const { calls, gateway, service, setLiveJob } = await makeHarness();
  const settle = gateway.resolveSinglePayout;
  gateway.resolveSinglePayout = async () => {
    calls.push(["resolveSinglePayout", { interrupted: true }]);
    throw new Error("broker did not broadcast");
  };
  await assert.rejects(
    service.reviewSubmission(JOB_ID, { wallet: POSTER, verdict: "approve" }),
    /broker did not broadcast/u
  );

  gateway.resolveSinglePayout = settle;
  setLiveJob({
    state: 6,
    releasedRaw: "1000000",
    protocolFeeReleasedRaw: "50000"
  });
  await assert.rejects(
    service.reviewSubmission(JOB_ID, { wallet: POSTER, verdict: "approve" }),
    (error) => error?.code === "poster_review_foreign_final_state"
  );
  assert.equal(calls.filter(([name]) => name === "resolveSinglePayout").length, 1);
});

test("race matrix: a durable poster decision beats a simultaneous timeout escalation", async () => {
  const { calls, service } = await makeHarness({ now: "2026-08-09T11:00:00.000Z" });
  const decided = await service.reviewSubmission(JOB_ID, {
    wallet: POSTER,
    verdict: "approve"
  });
  const escalation = await service.escalateExpiredSubmission(JOB_ID);
  assert.equal(decided.decision, "approve");
  assert.equal(escalation.decision, "approve");
  assert.equal(escalation.replayed, true);
  assert.equal(calls.some(([name]) => name === "openDispute"), false);
});

test("authz matrix: poster review after escalation is refused because the dispute owns it", async () => {
  const { service } = await makeHarness({ now: "2026-08-09T11:00:00.000Z" });
  const escalated = await service.escalateExpiredSubmission(JOB_ID);
  assert.equal(escalated.status, "escalated");
  await assert.rejects(
    service.reviewSubmission(JOB_ID, { wallet: POSTER, verdict: "approve" }),
    (error) => error?.code === "poster_review_owned_by_dispute"
  );
});

test("approve path binds the brokered SettlementSplit to the live worker, reward, and fee", async () => {
  const { calls, service, stateStore } = await makeHarness();
  const receipt = await service.reviewSubmission(JOB_ID, {
    wallet: POSTER,
    verdict: "approve",
    reason: "The submission meets the acceptance criteria."
  });
  assert.deepEqual(receipt.settlement, {
    worker: WORKER,
    treasuryAccount: TREASURY,
    asset: USDC,
    workerAmountRaw: "1000000",
    protocolFeeAmountRaw: "50000",
    protocolFeeBps: 500
  });
  const settle = calls.find(([name]) => name === "resolveSinglePayout")[1];
  assert.equal(settle.id, JOB_ID);
  assert.equal(settle.approved, true);
  assert.equal(settle.reasonCode, POSTER_REVIEW_REASON_CODES.approve);
  assert.equal(settle.reasoningHash, receipt.rationaleHash);
  assert.equal((await stateStore.getSession("session-external-1")).status, "resolved");
});

test("reject path records the live seven-day dispute-window math", async () => {
  const { calls, service } = await makeHarness();
  const receipt = await service.reviewSubmission(JOB_ID, {
    wallet: POSTER,
    verdict: "reject",
    reason: "The report omits the required validation plan."
  });
  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.reasonCode, POSTER_REVIEW_REASON_CODES.reject);
  assert.equal(receipt.disputeWindow.seconds, 604_800);
  assert.equal(
    Date.parse(receipt.disputeWindow.endsAt) - Date.parse(receipt.disputeWindow.rejectedAt),
    604_800_000
  );
  assert.equal(calls.filter(([name]) => name === "resolveSinglePayout").length, 1);
  assert.equal(calls.filter(([name]) => name === "openDispute").length, 0);
});

test("single-step escalation records rejection then opens for the worker without an arbitrator signer", async () => {
  const { calls, service, stateStore } = await makeHarness({
    now: "2026-08-09T11:00:00.000Z"
  });
  const receipt = await service.escalateExpiredSubmission(JOB_ID);
  assert.equal(receipt.status, "escalated");
  assert.equal(receipt.reasonCode, POSTER_REVIEW_REASON_CODES.escalated);
  assert.deepEqual(
    calls.filter(([name]) => [
      "resolveSinglePayout",
      "openDispute",
      "ingestBrokeredDecision"
    ].includes(name)).map(([name]) => name),
    ["resolveSinglePayout", "openDispute", "ingestBrokeredDecision"]
  );
  assert.equal(calls.some(([name]) => name === "requireArbitratorSigner"), false);
  assert.equal((await stateStore.getSession("session-external-1")).status, "disputed");
});

test("idempotency: interrupted timeout escalation resumes after the durable rejection", async () => {
  const { gateway, service } = await makeHarness({
    now: "2026-08-09T11:00:00.000Z"
  });
  const openDispute = gateway.openDispute;
  gateway.openDispute = async () => {
    throw new Error("temporary dispute-open interruption");
  };
  await assert.rejects(
    service.escalateExpiredSubmission(JOB_ID),
    /temporary dispute-open interruption/u
  );
  gateway.openDispute = openDispute;
  const receipt = await service.escalateExpiredSubmission(JOB_ID);
  assert.equal(receipt.status, "escalated");
  assert.equal(receipt.rejectionTx.txHash, "0xreject");
  assert.equal(receipt.disputeTx.txHash, "0xdispute");
});

test("local end-to-end trace: worker submit -> poster approve -> broker settle", async (t) => {
  const { calls, service, stateStore } = await makeHarness();
  const submitted = await stateStore.getSession("session-external-1");
  const receipt = await service.reviewSubmission(JOB_ID, {
    wallet: POSTER,
    verdict: "approve",
    reason: "Local acceptance trace approval."
  });
  const settled = await stateStore.getSession(submitted.sessionId);
  const trace = {
    submit: {
      sessionId: submitted.sessionId,
      status: submitted.status,
      submittedAt: submitted.submittedAt,
      worker: submitted.wallet
    },
    review: {
      decision: receipt.decision,
      submissionIdentity: receipt.submissionIdentity,
      decidedBy: receipt.decidedBy
    },
    settlement: {
      txHash: receipt.payoutTx.txHash,
      blockNumber: receipt.payoutTx.blockNumber,
      workerAmountRaw: receipt.settlement.workerAmountRaw,
      protocolFeeAmountRaw: receipt.settlement.protocolFeeAmountRaw,
      finalSessionStatus: settled.status
    }
  };
  t.diagnostic(JSON.stringify(trace));
  assert.equal(trace.submit.status, "submitted");
  assert.equal(trace.review.decision, "approve");
  assert.equal(trace.settlement.finalSessionStatus, "resolved");
  assert.equal(calls.filter(([name]) => name === "resolveSinglePayout").length, 1);
});
