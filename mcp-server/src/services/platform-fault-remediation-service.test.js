import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildJobSnapshot } from "../core/job-snapshot.js";
import {
  PLATFORM_FAULT_REMEDIATION_KIND,
  PLATFORM_FAULT_REMEDIATION_PENDING,
} from "../core/platform-fault-remediation.js";
import { PlatformService } from "../core/platform-service.js";
import { MemoryStateStore } from "../core/state-store.js";
import { transitionSession } from "../core/session-state-machine.js";
import { PlatformFaultRemediationService } from "./platform-fault-remediation-service.js";
import { VerificationIngestionService } from "./verification-ingestion-service.js";
import { VerifierService } from "./verifier-service.js";

const WORKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHAIN_JOB_ID = `0x${"11".repeat(32)}`;
const ASSET = "0x0000053900000000000000000000000001200000";
const REASONING_HASH = `0x${"22".repeat(32)}`;

function fakeGateway({ initialState = 3, failOpenOnce = false, breakOpenTransition = false } = {}) {
  let state = initialState;
  let shouldFailOpen = failOpenOnce;
  const calls = [];
  const live = () => ({
    state,
    worker: WORKER,
    asset: ASSET,
    reward: 8,
    rewardRaw: "8000000",
    released: 0.3,
    releasedRaw: "300000",
    specHash: `0x${"33".repeat(32)}`
  });
  return {
    calls,
    get state() { return state; },
    isEnabled: () => true,
    async getJob(jobId) {
      calls.push(["getJob", jobId, state]);
      return live();
    },
    async prepareResolveDispute(jobId, workerPayoutRaw, reasonCode, metadataURI) {
      calls.push(["prepareResolveDispute", { jobId, workerPayoutRaw, reasonCode, metadataURI }]);
      return {
        to: "0x4444444444444444444444444444444444444444",
        value: "0",
        function: "resolveDispute(bytes32,uint256,bytes32,string)",
        args: [jobId, workerPayoutRaw, reasonCode, metadataURI],
        data: `0x${"44".repeat(64)}`
      };
    },
    async resolveSinglePayout(jobId, approved, reasonCode, metadataURI, reasoningHash) {
      calls.push(["resolveSinglePayout", { jobId, approved, reasonCode, metadataURI, reasoningHash }]);
      assert.equal(state, 3);
      assert.equal(approved, false);
      state = 4;
      return { txHash: `0x${"55".repeat(32)}`, blockNumber: 50, status: 1 };
    },
    async openDispute(jobId, participant) {
      calls.push(["openDispute", { jobId, participant }]);
      assert.equal(state, 4);
      if (shouldFailOpen) {
        shouldFailOpen = false;
        throw new Error("temporary openDispute failure");
      }
      if (!breakOpenTransition) state = 5;
      return { txHash: `0x${"66".repeat(32)}`, blockNumber: 51, status: 1 };
    },
    async resolveDispute() {
      calls.push(["resolveDispute"]);
      throw new Error("backend must never resolve an internal platform-fault remediation");
    }
  };
}

function submittedSession({ designated = false } = {}) {
  const job = {
    id: "platform-fault-job",
    verifierMode: "deterministic",
    verifierConfig: { handler: "deterministic", version: 1 },
    rewardAsset: "USDC",
    rewardAmount: 8,
    ...(designated ? {
      designatedClaimants: [WORKER],
      source: { type: "external" },
      requiresSponsoredGas: false
    } : {})
  };
  const claimed = transitionSession({
    sessionId: designated ? "designated-platform-fault-session" : "ordinary-platform-fault-session",
    wallet: WORKER,
    jobId: job.id,
    chainJobId: CHAIN_JOB_ID,
    claimStake: 0.35,
    totalClaimLock: 0.35,
    claimStakeCustody: "chain_escrow",
    submission: "bounded test evidence",
    jobSnapshot: buildJobSnapshot(job)
  }, "claimed", { reason: "job_claimed" });
  return {
    job,
    session: transitionSession(claimed, "submitted", { reason: "work_submitted" })
  };
}

function remediationInput() {
  return {
    session: submittedSession().session,
    verdict: {
      outcome: "platform_fault",
      reasonCode: "PLATFORM_RUNTIME_FAILED",
      workerConsequence: "none"
    },
    reasoningHash: REASONING_HASH
  };
}

function verifierHarness({ designated = false } = {}) {
  const stateStore = new MemoryStateStore();
  const gateway = fakeGateway();
  const events = [];
  const eventBus = { publish: (event) => events.push(event) };
  const { job, session } = submittedSession({ designated });
  gateway.getJob = async (jobId) => {
    gateway.calls.push(["getJob", jobId, gateway.state]);
    return {
      state: gateway.state,
      worker: WORKER,
      asset: ASSET,
      reward: 8,
      rewardRaw: "8000000",
      released: 0.3,
      releasedRaw: "300000",
      specHash: session.jobSnapshot.specHash
    };
  };
  const ingestion = new VerificationIngestionService(
    stateStore,
    eventBus,
    undefined,
    { info() {}, warn() {} },
    { blockchainGateway: gateway }
  );
  const platformService = {
    eventBus,
    logger: { info() {}, warn() {} },
    resumeSession: (id) => stateStore.getSession(id),
    ingestVerification: (id, verdict, options) => ingestion.ingest(id, verdict, options)
  };
  const verifier = new VerifierService(platformService, stateStore, gateway, {
    async evaluate() {
      return {
        handler: "deterministic",
        handlerVersion: 1,
        outcome: "platform_fault",
        reasonCode: "PLATFORM_RUNTIME_FAILED",
        workerConsequence: "none"
      };
    }
  });
  return { events, gateway, job, session, stateStore, verifier };
}

async function localLedgerVerifierHarness(outcome, { custody = "backend_ledger" } = {}) {
  const stateStore = new MemoryStateStore();
  const job = {
    id: `local-ledger-${outcome}`,
    verifierMode: "deterministic",
    verifierConfig: { handler: "deterministic", version: 1 },
    rewardAsset: "USDC",
    rewardAmount: 8
  };
  const accounts = new Map([
    [WORKER, {
      wallet: WORKER,
      liquid: { USDC: 1.65 },
      reserved: {},
      strategyAllocated: {},
      collateralLocked: {},
      jobStakeLocked: { USDC: 0.35 },
      debtOutstanding: {}
    }]
  ]);
  const ledger = new PlatformService(
    [job],
    new Map(),
    accounts,
    new Map(),
    undefined,
    stateStore
  );
  const claimed = transitionSession({
    sessionId: `local-ledger-${outcome}-session`,
    wallet: WORKER,
    jobId: job.id,
    claimStake: 0.25,
    claimFee: 0.1,
    totalClaimLock: 0.35,
    claimStakeCustody: custody,
    submission: "bounded test evidence",
    jobSnapshot: buildJobSnapshot(job)
  }, "claimed", { reason: "job_claimed" });
  const session = transitionSession(claimed, "submitted", { reason: "work_submitted" });
  await stateStore.upsertSession(session);
  const platformService = {
    resumeSession: (id) => stateStore.getSession(id),
    returnPlatformFaultClaimEconomics: ledger.returnPlatformFaultClaimEconomics.bind(ledger),
    ingestVerification: async () => stateStore.getSession(session.sessionId)
  };
  const verifier = new VerifierService(platformService, stateStore, undefined, {
    async evaluate() {
      return {
        handler: "deterministic",
        handlerVersion: 1,
        outcome,
        reasonCode: outcome === "platform_fault"
          ? "PLATFORM_RUNTIME_FAILED"
          : outcome === "inconclusive"
            ? "EVIDENCE_AMBIGUOUS"
            : "DETERMINISTIC_MISMATCH",
        workerConsequence: outcome === "rejected" ? "no_payout" : "none"
      };
    }
  });
  return { accounts, session, verifier };
}

test("platform_fault escalates Submitted to Disputed and queues the exact full-payout hardware action", async () => {
  const stateStore = new MemoryStateStore();
  const gateway = fakeGateway();
  const service = new PlatformFaultRemediationService({
    stateStore,
    gateway,
    publicBaseUrl: "https://api.example.test",
    logger: { info() {} },
    now: () => new Date("2026-08-20T10:00:00.000Z")
  });

  const record = await service.escalate(remediationInput());

  assert.equal(gateway.state, 5);
  assert.equal(record.status, PLATFORM_FAULT_REMEDIATION_PENDING);
  assert.equal(record.kind, PLATFORM_FAULT_REMEDIATION_KIND);
  assert.equal(record.workerInitiated, false);
  assert.equal(record.workerConsequence, "none");
  assert.equal(record.resolution.workerPayoutRaw, "7700000");
  assert.equal(record.resolution.workerPayout, 7.7);
  assert.equal(record.resolution.method, "resolveDispute");
  assert.equal(record.resolution.signerMode, "out_of_band_hardware");
  assert.equal(record.resolution.releasesClaimEconomics, true);
  assert.equal(record.resolution.transaction.args[1], "7700000");
  assert.match(record.resolution.metadataURI, /^https:\/\/api\.example\.test\/content\/0x/u);
  assert.equal(gateway.calls.filter(([name]) => name === "resolveSinglePayout").length, 1);
  assert.equal(gateway.calls.filter(([name]) => name === "openDispute").length, 1);
  assert.equal(gateway.calls.filter(([name]) => name === "resolveDispute").length, 0);
  assert.equal((await stateStore.listPlatformFaultRemediations()).length, 1);
  assert.ok(await stateStore.getContent(record.resolution.reasoningHash));
});

test("platform_fault escalation resumes from Rejected without repeating the rejection", async () => {
  const stateStore = new MemoryStateStore();
  const gateway = fakeGateway({ failOpenOnce: true });
  const service = new PlatformFaultRemediationService({
    stateStore,
    gateway,
    logger: { info() {} }
  });

  await assert.rejects(service.escalate(remediationInput()), /temporary openDispute failure/u);
  assert.equal(gateway.state, 4);
  const record = await service.escalate(remediationInput());

  assert.equal(record.status, PLATFORM_FAULT_REMEDIATION_PENDING);
  assert.equal(gateway.state, 5);
  assert.equal(gateway.calls.filter(([name]) => name === "resolveSinglePayout").length, 1);
  assert.equal(gateway.calls.filter(([name]) => name === "openDispute").length, 2);
  assert.equal(gateway.calls.filter(([name]) => name === "resolveDispute").length, 0);
});

test("mutation drill: a successful-looking openDispute that does not reach state 5 fails closed", async () => {
  const stateStore = new MemoryStateStore();
  const gateway = fakeGateway({ breakOpenTransition: true });
  const service = new PlatformFaultRemediationService({
    stateStore,
    gateway,
    logger: { info() {} }
  });

  await assert.rejects(
    service.escalate(remediationInput()),
    (error) => error.code === "platform_fault_remediation_state_mismatch"
      && error.details?.step === "openDispute"
  );
  const [record] = await stateStore.listPlatformFaultRemediations();
  assert.notEqual(record.status, PLATFORM_FAULT_REMEDIATION_PENDING);
});

test("ordinary submitted session records platform_fault as internal remediation, never a worker dispute", async () => {
  const h = verifierHarness();
  await h.stateStore.upsertSession(h.session);

  const result = await h.verifier.verifySubmission({ sessionId: h.session.sessionId });
  const stored = await h.stateStore.getSession(h.session.sessionId);
  const receipt = await h.stateStore.getRunReceiptDocument(h.session.sessionId);

  assert.equal(result.outcome, "platform_fault");
  assert.equal(result.workerConsequence, "none");
  assert.equal(stored.status, "disputed");
  assert.equal(stored.internalRemediation.workerInitiated, false);
  assert.equal(stored.internalRemediation.workerConsequence, "none");
  assert.equal(receipt.verdict.workerConsequence, "none");
  assert.equal(h.gateway.state, 5);
  assert.ok(h.events.some((event) => event.topic === "platform.remediation_session_linked"));
  assert.ok(!h.events.some((event) => event.topic === "dispute.opened"));
  assert.equal(h.gateway.calls.filter(([name]) => name === "resolveDispute").length, 0);
});

test("platform_fault returns the backend-ledger claim economics in the verdict flow", async () => {
  const h = await localLedgerVerifierHarness("platform_fault");
  const before = h.accounts.get(WORKER);
  assert.equal(before.liquid.USDC, 1.65);
  assert.equal(before.jobStakeLocked.USDC, 0.35);

  await h.verifier.verifySubmission({ sessionId: h.session.sessionId });

  const after = h.accounts.get(WORKER);
  assert.equal(after.liquid.USDC, 2);
  assert.equal(after.jobStakeLocked.USDC, 0);
});

test("non-platform-fault verdicts do not use the immediate backend-ledger return", async () => {
  for (const outcome of ["rejected", "inconclusive"]) {
    const h = await localLedgerVerifierHarness(outcome);

    await h.verifier.verifySubmission({ sessionId: h.session.sessionId });

    const after = h.accounts.get(WORKER);
    assert.equal(after.liquid.USDC, 1.65, outcome);
    assert.equal(after.jobStakeLocked.USDC, 0.35, outcome);
  }
});

test("chain-held claim economics never fall through to the backend ledger when the gateway is unavailable", async () => {
  const h = await localLedgerVerifierHarness("platform_fault", { custody: "chain_escrow" });

  await h.verifier.verifySubmission({ sessionId: h.session.sessionId });

  const after = h.accounts.get(WORKER);
  assert.equal(after.liquid.USDC, 1.65);
  assert.equal(after.jobStakeLocked.USDC, 0.35);
});

test("designated claim keeps its posted stake while platform_fault queues the same no-consequence remediation", async () => {
  const h = verifierHarness({ designated: true });
  await h.stateStore.upsertSession(h.session);

  await h.verifier.verifySubmission({ sessionId: h.session.sessionId });
  const stored = await h.stateStore.getSession(h.session.sessionId);
  const [record] = await h.stateStore.listPlatformFaultRemediations();

  assert.deepEqual(h.job.designatedClaimants, [WORKER]);
  assert.equal(h.job.source.type, "external");
  assert.equal(h.job.requiresSponsoredGas, false);
  assert.equal(stored.claimStake, 0.35);
  assert.equal(stored.totalClaimLock, 0.35);
  assert.equal(stored.claimStakeCustody, "chain_escrow");
  assert.equal(stored.internalRemediation.workerConsequence, "none");
  assert.equal(record.resolution.workerPayoutRaw, "7700000");
  assert.equal(record.resolution.releasesClaimEconomics, true);
  assert.equal(record.workerInitiated, false);
  assert.equal(h.gateway.state, 5);
  assert.equal(h.gateway.calls.filter(([name]) => name === "resolveDispute").length, 0);
});

function assertNoBackendArbitratorExecution(source) {
  assert.doesNotMatch(
    source,
    /this\.gateway\.resolveDispute\s*\(/u,
    "platform-fault remediation must stop at the hardware-arbitrator queue"
  );
  assert.doesNotMatch(
    source,
    /this\.gateway\.autoResolveOnTimeout\s*\(/u,
    "platform-fault remediation must never use the half-payout timeout path"
  );
}

function assertImmediateLedgerStakeReturn(source) {
  assert.match(
    source,
    /verdict\.outcome === "platform_fault"[\s\S]*returnPlatformFaultClaimEconomics/u,
    "platform_fault verdicts must return backend-ledger claim economics immediately"
  );
}

test("mutation drill: removing the platform-fault ledger return fails by name", () => {
  const source = readFileSync(new URL("./verifier-service.js", import.meta.url), "utf8");
  assertImmediateLedgerStakeReturn(source);
  const deliberatelyMutated = source.replace(
    /^.*returnPlatformFaultClaimEconomics.*\n/mu,
    ""
  );
  assert.throws(
    () => assertImmediateLedgerStakeReturn(deliberatelyMutated),
    /return backend-ledger claim economics immediately/u
  );
});

test("no-resolveDispute boundary guard rejects a deliberately wired backend arbitration call", () => {
  const source = readFileSync(new URL("./platform-fault-remediation-service.js", import.meta.url), "utf8");
  assertNoBackendArbitratorExecution(source);
  const deliberatelyMutated = `${source}\nthis.gateway.resolveDispute(jobId, payout, reason, metadataURI);\n`;
  assert.throws(
    () => assertNoBackendArbitratorExecution(deliberatelyMutated),
    /hardware-arbitrator queue/u
  );
});
