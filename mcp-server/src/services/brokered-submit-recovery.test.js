import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BROKERED_SUBMIT_RECOVERY_MAX_ATTEMPTS,
  JobExecutionService
} from "../core/job-execution-service.js";
import { countClaimedSessions } from "../core/claim-economics.js";
import { buildJobSnapshot } from "../core/job-snapshot.js";
import { transitionSession } from "../core/session-state-machine.js";
import { normalizeSubmission } from "../core/submission.js";
import { MemoryStateStore } from "../core/state-store.js";
import { PLATFORM_FAULT_REMEDIATION_PENDING } from "../core/platform-fault-remediation.js";
import { SubmittedJobAutoVerifierService } from "./submitted-job-auto-verifier.js";
import { VerifierService } from "./verifier-service.js";

const WORKER = "0x97450bf600000000000000000000000000000000";
const CHAIN_JOB_ID = `0x${"42".repeat(32)}`;
const TX_HASH = `0x${"55".repeat(32)}`;
const LIVE_JOB_ID = "wiki-en-33653136-citation-repair-2011-film-r20";
const LIVE_SESSION_ID = `${LIVE_JOB_ID}:${WORKER}`;

function job() {
  return {
    id: LIVE_JOB_ID,
    verifierMode: "benchmark",
    verifierConfig: { handler: "benchmark", version: 1, terms: ["film"], minimumMatches: 1 },
    rewardAsset: "USDC",
    rewardAmount: 0.25,
    claimTtlSeconds: 3600,
    onboardingWaiverEligible: true
  };
}

function submittedSession({
  sessionId = `${job().id}:${WORKER}`,
  claimExpiresAt = "2026-08-21T21:31:36.000Z"
} = {}) {
  const definition = job();
  const snapshot = buildJobSnapshot(definition);
  const claimed = transitionSession({
    sessionId,
    jobId: definition.id,
    chainJobId: CHAIN_JOB_ID,
    wallet: WORKER,
    claimNumber: 1,
    claimEconomicsWaived: true,
    claimEconomicsWaivedAtClaim: true,
    chainClaimExpiresAt: claimExpiresAt,
    submission: normalizeSubmission("film citation evidence"),
    jobSnapshot: snapshot
  }, "claimed", {
    reason: "job_claimed",
    timestamp: "2026-08-21T20:31:36.000Z"
  });
  return transitionSession(claimed, "submitted", {
    reason: "work_submitted",
    timestamp: "2026-08-21T20:40:00.000Z"
  });
}

function gateway({
  expiresAt = "2026-08-21T21:31:36.000Z",
  invalidStateRace = false,
  submitFailure = false
} = {}) {
  let state = 2;
  let submitCalls = 0;
  const calls = [];
  return {
    calls,
    get state() { return state; },
    get submitCalls() { return submitCalls; },
    isEnabled: () => true,
    async getJob() {
      calls.push(["getJob", state]);
      return {
        state,
        worker: WORKER,
        asset: "0x0000053900000000000000000000000001200000",
        reward: 0.25,
        rewardRaw: "250000",
        released: 0,
        releasedRaw: "0",
        claimExpiry: Date.parse(expiresAt) / 1000,
        specHash: buildJobSnapshot(job()).specHash
      };
    },
    async submitWork(chainJobId, evidenceHash, worker) {
      calls.push(["submitWork", { chainJobId, evidenceHash, worker }]);
      submitCalls += 1;
      if (submitFailure) throw new Error("RPC broadcast timed out");
      state = 3;
      if (invalidStateRace) {
        const error = new Error("execution reverted");
        error.details = { customError: "InvalidState", selector: "0xbaf3f0f7" };
        throw error;
      }
      return { txHash: TX_HASH, status: 1 };
    },
    async resolveSinglePayout() {
      calls.push(["resolveSinglePayout"]);
      assert.equal(state, 3);
      state = 6;
      return {
        txHash: `0x${"66".repeat(32)}`,
        status: 1,
        settlement: { workerPayout: 0.25, asset: "USDC" }
      };
    }
  };
}

function verifierHarness({ session, chain, recoveryNow = undefined }) {
  const stateStore = new MemoryStateStore();
  const execution = new JobExecutionService(stateStore, chain, () => job());
  const platformService = {
    eventBus: { publish() {} },
    logger: { info() {}, warn() {} },
    resumeSession: (sessionId) => stateStore.getSession(sessionId),
    reconcileBrokeredSubmit: (sessionId, options) => execution.reconcileBrokeredSubmit(sessionId, {
      ...options,
      ...(recoveryNow ? { now: recoveryNow } : {})
    }),
    listRecentSessions: (limit) => stateStore.listRecentSessions(limit),
    async ingestVerification(sessionId, verdict, { payoutTx } = {}) {
      const current = await stateStore.getSession(sessionId);
      const resolved = transitionSession({ ...current, payoutTx }, "resolved", {
        reason: "verification_resolved"
      });
      await stateStore.upsertSession(resolved);
      await stateStore.upsertVerificationResult(sessionId, verdict);
      return resolved;
    }
  };
  const registry = {
    async evaluate() {
      return {
        handler: "benchmark",
        handlerVersion: 1,
        outcome: "approved",
        reasonCode: "BENCHMARK_MATCH"
      };
    }
  };
  const verifier = new VerifierService(platformService, stateStore, chain, registry, {
    logger: { info() {}, warn() {} }
  });
  return { execution, platformService, stateStore, verifier };
}

test("submitted-status + chain-Claimed + unexpired re-brokers exactly once per eligible pass", async () => {
  const session = submittedSession();
  const chain = gateway();
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession(session);
  const execution = new JobExecutionService(stateStore, chain, () => job());

  const first = await execution.reconcileBrokeredSubmit(session.sessionId, {
    now: new Date("2026-08-21T20:50:00.000Z")
  });
  const second = await execution.reconcileBrokeredSubmit(session.sessionId, {
    now: new Date("2026-08-21T20:51:00.000Z")
  });

  assert.equal(first.status, "landed");
  assert.equal(first.recovered, true);
  assert.equal(second.status, "landed");
  assert.equal(second.recovered, false);
  assert.equal(chain.submitCalls, 1);
  assert.equal(first.session.brokeredSubmitRecovery.attempts, 1);
});

test("brokered submit recovery applies durable backoff and a finite attempt bound", async () => {
  const session = submittedSession();
  const chain = gateway({ submitFailure: true });
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession(session);
  const execution = new JobExecutionService(stateStore, chain, () => job());

  await assert.rejects(
    execution.reconcileBrokeredSubmit(session.sessionId, {
      now: new Date("2026-08-21T20:50:00.000Z")
    }),
    /RPC broadcast timed out/u
  );
  const backedOff = await execution.reconcileBrokeredSubmit(session.sessionId, {
    now: new Date("2026-08-21T20:50:10.000Z")
  });
  assert.equal(backedOff.status, "deferred");
  assert.equal(backedOff.reason, "brokered_submit_backoff");
  assert.equal(chain.submitCalls, 1);

  const current = await stateStore.getSession(session.sessionId);
  await stateStore.upsertSession({
    ...current,
    brokeredSubmitRecovery: {
      ...current.brokeredSubmitRecovery,
      attempts: BROKERED_SUBMIT_RECOVERY_MAX_ATTEMPTS,
      nextAttemptAt: "2026-08-21T20:49:00.000Z"
    }
  });
  const exhausted = await execution.reconcileBrokeredSubmit(session.sessionId, {
    now: new Date("2026-08-21T20:51:00.000Z")
  });
  assert.equal(exhausted.status, "deferred");
  assert.equal(exhausted.reason, "brokered_submit_attempts_exhausted");
  assert.equal(chain.submitCalls, 1);
});

test("re-broker InvalidState race with an actual landed submit proceeds to verification without parking", async () => {
  const session = submittedSession();
  const chain = gateway({ invalidStateRace: true });
  const h = verifierHarness({
    session,
    chain,
    recoveryNow: new Date("2026-08-21T20:50:00.000Z")
  });
  await h.stateStore.upsertSession(session);

  const result = await h.verifier.verifySubmission({ sessionId: session.sessionId });
  const stored = await h.stateStore.getSession(session.sessionId);

  assert.equal(result.outcome, "approved");
  assert.equal(stored.status, "resolved");
  assert.equal(stored.chainStateDivergence, undefined);
  assert.equal(stored.brokeredSubmitRecovery.racedInvalidState, true);
  assert.equal(chain.submitCalls, 1);
  assert.equal(chain.calls.filter(([name]) => name === "resolveSinglePayout").length, 1);
});

function assertExpiryEnqueuesBeforeParking(source) {
  const enqueue = source.indexOf("enqueueBrokeredSubmitExpiry");
  const park = source.indexOf("stage: \"brokered_submit_expired\"");
  assert.ok(enqueue >= 0, "expiry must enqueue platform-fault remediation");
  assert.ok(park > enqueue, "expiry must durably enqueue before parking the session");
}

test("live expired brokered-submit backfill parks, enqueues remediation, and restores the waiver slot", async () => {
  const session = submittedSession({ sessionId: LIVE_SESSION_ID });
  const chain = gateway();
  const h = verifierHarness({
    session,
    chain,
    recoveryNow: new Date("2026-08-21T22:00:00.000Z")
  });
  await h.stateStore.upsertSession(session);
  const scheduler = new SubmittedJobAutoVerifierService(
    h.platformService,
    h.verifier,
    undefined,
    undefined,
    { enabled: true, requireSettlementReady: false, logger: { info() {}, warn() {} } }
  );
  scheduler.pendingVerifications.set(LIVE_SESSION_ID, {
    timedOut: true,
    promise: new Promise(() => {})
  });

  const run = await scheduler.runOnce(new Date("2026-08-21T22:00:00.000Z"));
  const stored = await h.stateStore.getSession(LIVE_SESSION_ID);
  const [remediation] = await h.stateStore.listPlatformFaultRemediations();

  assert.equal(run.errors.length, 0);
  assert.equal(run.parkedCount, 1, JSON.stringify(run));
  assert.equal(stored.status, "chain_state_diverged");
  assert.equal(stored.chainStateDivergence.stage, "brokered_submit_expired");
  assert.equal(stored.workerConsequence, "none");
  assert.ok(stored.onboardingWaiverConsumptionExemptedAt);
  assert.equal(countClaimedSessions([stored]), 0, "the remediated claim no longer consumes a local waiver slot");
  assert.equal(remediation.status, PLATFORM_FAULT_REMEDIATION_PENDING);
  assert.equal(remediation.workerConsequence, "none");
  assert.equal(remediation.resolution.workerPayoutRaw, "250000");
  assert.equal(remediation.resolution.executable, false);
  assert.equal(remediation.escalation.submissionFailure.jobId, session.jobId);
  assert.equal(remediation.escalation.submissionFailure.evidenceHash, stored.brokeredSubmitRecovery.evidenceHash);
  assert.equal(remediation.escalation.submissionFailure.claimExpiresAt, "2026-08-21T21:31:36.000Z");
  assert.equal(remediation.escalation.submissionFailure.attempts, 0);
  assert.equal(chain.submitCalls, 0, "an already-expired live backfill is never blindly rebroadcast");
  assert.equal(scheduler.pendingVerifications.has(LIVE_SESSION_ID), false);

  const source = readFileSync(new URL("./verifier-service.js", import.meta.url), "utf8");
  assertExpiryEnqueuesBeforeParking(source);
  const mutated = source.replace("enqueueBrokeredSubmitExpiry", "expiryEnqueueRemoved");
  assert.notEqual(mutated, source, "expiry-enqueue mutation must apply");
  assert.throws(
    () => assertExpiryEnqueuesBeforeParking(mutated),
    /expiry must enqueue platform-fault remediation/u
  );
});
