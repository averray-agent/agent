import assert from "node:assert/strict";
import test from "node:test";
import { BlockchainGateway } from "../blockchain/gateway.js";
import { JobExecutionService } from "./job-execution-service.js";
import { buildJobSnapshot } from "./job-snapshot.js";
import { MemoryStateStore } from "./state-store.js";
import { ConflictError } from "./errors.js";
import { createSessionRoutes } from "../protocols/http/session-routes.js";

const WALLET = `0x${"aa".repeat(20)}`;
const OTHER = `0x${"bb".repeat(20)}`;
const SENDER = `0x${"cc".repeat(20)}`;
const HASH = `0x${"dd".repeat(32)}`;
const NONCE = 2780;

async function timedOutClaim() {
  const store = new MemoryStateStore();
  const job = {
    id: "canary-pending-claim", category: "review", tier: "starter", rewardAsset: "DOT", rewardAmount: 6,
    verifierMode: "benchmark", verifierConfig: { version: 1, handler: "benchmark", requiredKeywords: ["summary"], minimumMatches: 1 },
    outputSchemaRef: "schema://jobs/pr-review-findings-output", claimTtlSeconds: 3600
  };
  const logs = [];
  const calls = [];
  const latestNonces = [NONCE, NONCE];
  const receipts = [null, null];
  const errors = [null, null];
  const live = { state: 1, worker: `0x${"00".repeat(20)}`, specHash: buildJobSnapshot(job).specHash };
  const gateway = new BlockchainGateway({ enabled: false, brokeredTxTimeoutMs: 10 });
  gateway.transactionStore = store;
  gateway.writeBroadcaster = { receiptRunners: [0, 1].map((index) => ({
    _getConnection: () => ({ url: `https://runner-${index}.test` }),
    async getTransactionReceipt(hash) {
      calls.push({ index, kind: "receipt", hash });
      assert.equal(hash, HASH);
      if (errors[index] === "receipt") throw new Error("receipt RPC unavailable");
      return receipts[index];
    },
    async getTransactionCount(from, block) {
      calls.push({ index, kind: "nonce", from, block });
      assert.equal(from, SENDER, "probe the persisted sender, not the current signer");
      assert.equal(block, "latest");
      if (errors[index] === "nonce") throw new Error("nonce RPC unavailable");
      return latestNonces[index];
    }
  })) };
  let broadcasts = 0;
  let admissions = 0;
  Object.assign(gateway, {
    isEnabled: () => true,
    getWorkerClaimCount: async () => 0,
    getClaimEconomicsDecisionState: async () => ({ state: live.state, exists: true, contractLayout: "current", onboardingWaiverEligible: false }),
    previewClaimEconomics: async () => ({ claimStake: 0.3, claimFee: 0.12, claimStakeBps: 500, claimFeeBps: 200, claimNumber: 1, totalClaimLock: 0.42 }),
    getJob: async () => ({ ...live }),
    ensureJob: async () => { admissions++; },
    ensureClaimStakeLiquidity: async () => {},
    claimJob: async () => {
      broadcasts++;
      if (broadcasts === 1) {
        await gateway.waitForTransaction({ hash: HASH, nonce: NONCE, from: SENDER, wait: () => new Promise(() => {}) }, "claimJob", job.id);
      } else {
        live.state = 2;
        live.worker = WALLET;
        live.claimExpiry = Math.floor(Date.now() / 1000) + 3600;
      }
    }
  });
  const service = new JobExecutionService(store, gateway, () => job, undefined, undefined, undefined, undefined, undefined, {
    logger: { info: (record) => logs.push(record) }
  });
  let sessionId;
  await assert.rejects(service.claimJob(WALLET, job.id, "http", "initial"), (error) => {
    assert.equal(error.code, "brokered_tx_timeout");
    sessionId = error.details.sessionId;
    return Boolean(sessionId);
  });
  calls.length = 0;
  return {
    store, service, gateway, job, sessionId, live, latestNonces, receipts, errors, logs, calls,
    retry: () => service.claimJob(WALLET, job.id, "http", "retry"),
    freshBroadcasts: () => broadcasts - 1, freshAdmissions: () => admissions - 1,
    pending: () => store.getServiceState(`brokered-claim:${sessionId}`)
  };
}

test("H1: another wallet claims after timeout: ordinary 409 and cleared pending record", async () => {
  const fixture = await timedOutClaim();
  Object.assign(fixture.live, { state: 2, worker: OTHER });
  await assert.rejects(fixture.retry(), { code: "job_already_claimed", statusCode: 409 });
  const pending = await fixture.pending();
  assert.equal(pending.cleared, true);
  assert.equal(pending.reason, "job_already_claimed");
  assert.ok(Number.isFinite(Date.parse(pending.at)));
  assert.equal(fixture.freshBroadcasts(), 0);
  assert.equal(fixture.calls.length, 0, "an unclaimable job needs no dead-transaction probes");
});

test("H1: non-Open pending jobs clear with job_not_claimable, not a timeout", async () => {
  for (const state of [0, 3, 4, 5, 6]) {
    const fixture = await timedOutClaim();
    fixture.live.state = state;
    await assert.rejects(fixture.retry(), { code: "job_not_claimable", statusCode: 409 });
    assert.equal((await fixture.pending()).cleared, true);
    assert.equal(fixture.freshBroadcasts(), 0);
  }
});

test("H1(b): all runners consumed nonce without receipt: normal admission and exactly one fresh broadcast", async () => {
  const fixture = await timedOutClaim();
  fixture.latestNonces.fill(NONCE + 1);
  const claimed = await fixture.retry();
  assert.equal(claimed.status, "claimed");
  assert.equal(fixture.freshAdmissions(), 1);
  assert.equal(fixture.freshBroadcasts(), 1);
  assert.equal(fixture.calls.filter(({ kind }) => kind === "nonce").length, 2);
  assert.equal(fixture.calls.filter(({ kind }) => kind === "receipt").length, 2);
  assert.ok(fixture.logs.some((entry) => entry.event === "brokered_claim_dead_by_nonce" && entry.txHash === HASH && entry.nonce === NONCE));
  assert.equal((await fixture.pending()).cleared, false, "the new attempt replaces the tombstone");
  assert.deepEqual(await fixture.retry(), claimed);
  assert.equal(fixture.freshBroadcasts(), 1, "subsequent retry returns the fresh claim, never a third send");
});

test("H1: unconsumed nonce keeps timeout hash and sends no fresh claim", async () => {
  const fixture = await timedOutClaim();
  await assert.rejects(fixture.retry(), (error) => error.code === "brokered_tx_timeout" && error.details.txHash === HASH);
  assert.notEqual((await fixture.pending()).cleared, true);
  assert.equal(fixture.freshBroadcasts(), 0);
});

test("H1: one lagging runner with an older nonce prevents a fresh claim", async () => {
  const fixture = await timedOutClaim();
  fixture.latestNonces.splice(0, 2, NONCE + 1, NONCE - 1);
  await assert.rejects(fixture.retry(), { code: "brokered_tx_timeout" });
  assert.equal(fixture.freshBroadcasts(), 0);
});

test("H1: a receipt or any runner read error prevents a dead verdict", async () => {
  for (const blocker of ["receipt", "receipt-error", "nonce-error"]) {
    const fixture = await timedOutClaim();
    fixture.latestNonces.fill(NONCE + 1);
    if (blocker === "receipt") fixture.receipts[1] = { hash: HASH, blockNumber: 123, status: 1 };
    else fixture.errors[1] = blocker === "receipt-error" ? "receipt" : "nonce";
    await assert.rejects(fixture.retry(), { code: "brokered_tx_timeout" });
    assert.equal(fixture.freshBroadcasts(), 0, blocker);
  }
});

test("H1: GET /session for a cleared pending record returns ordinary 404, not a 5xx", async () => {
  const fixture = await timedOutClaim();
  await fixture.store.upsertServiceState(`brokered-claim:${fixture.sessionId}`, { cleared: true, reason: "job_not_claimable", at: new Date().toISOString() });
  fixture.gateway.getJob = () => assert.fail("cleared records must not be resurrected");
  await assert.rejects(fixture.service.resumeSession(fixture.sessionId), { code: "session_not_found", statusCode: 404 });
  const response = {};
  const route = createSessionRoutes({
    authMiddleware: async () => ({ wallet: WALLET }),
    ensureSessionOwnership: (sessionId) => fixture.service.resumeSession(sessionId),
    respond: (res, statusCode, body) => Object.assign(res, { statusCode, body }),
    service: fixture.service
  });
  assert.equal(await route({
    request: { method: "GET" }, response, pathname: "/session",
    url: new URL(`https://api.example.test/session?sessionId=${encodeURIComponent(fixture.sessionId)}`)
  }), true);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { status: "not_found", sessionId: fixture.sessionId });
});

test("H1: dead claim still obeys fresh admission refusals without broadcasting", async () => {
  const fixture = await timedOutClaim();
  fixture.latestNonces.fill(NONCE + 1);
  fixture.service.requireWorkerExposureAllowance = async () => {
    throw new ConflictError("New admission refused", "worker_open_exposure_unavailable");
  };
  await assert.rejects(fixture.retry(), { code: "worker_open_exposure_unavailable" });
  assert.equal((await fixture.pending()).cleared, true);
  assert.equal(fixture.freshBroadcasts(), 0);
  await assert.rejects(fixture.service.resumeSession(fixture.sessionId), { code: "session_not_found" });
});

test("H1: a hung runner is bounded at two seconds and cannot authorize a fresh claim", async () => {
  const fixture = await timedOutClaim();
  fixture.latestNonces.fill(NONCE + 1);
  fixture.gateway.writeBroadcaster.receiptRunners[1].getTransactionCount = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(fixture.retry(), { code: "brokered_tx_timeout" });
  assert.ok(Date.now() - started >= 1_900);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(fixture.freshBroadcasts(), 0);
});

test("H1: session read clears a dead transaction but never broadcasts", async () => {
  const fixture = await timedOutClaim();
  fixture.latestNonces.fill(NONCE + 1);
  await assert.rejects(fixture.service.resumeSession(fixture.sessionId), { code: "session_not_found", statusCode: 404 });
  assert.equal((await fixture.pending()).cleared, true);
  assert.equal(fixture.freshBroadcasts(), 0);
  assert.equal((await fixture.retry()).status, "claimed");
  assert.equal(fixture.freshBroadcasts(), 1);
});
