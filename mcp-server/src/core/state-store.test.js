import test from "node:test";
import assert from "node:assert/strict";

import { createStateStore, MemoryStateStore, RedisStateStore } from "./state-store.js";
import { ExternalServiceError } from "./errors.js";
import { parseWalletIdentity } from "./wallet-identity.js";

function silentLogger() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

test("createStateStore returns MemoryStateStore in dev without REDIS_URL", () => {
  const store = createStateStore({ NODE_ENV: "development", AUTH_MODE: "permissive" }, { logger: silentLogger() });
  assert.ok(store instanceof MemoryStateStore);
});

test("journey telemetry is retained at a hard 250 events per wallet", async () => {
  const store = new MemoryStateStore();
  const wallet = "0x1111111111111111111111111111111111111111";
  for (let index = 0; index < 251; index += 1) {
    await store.appendEventLog({
      id: `journey-${index}`,
      topic: "journey.preflight_completed",
      wallet,
      timestamp: new Date(Date.UTC(2026, 7, 22, 0, 0, index)).toISOString(),
      data: { eligible: true }
    });
  }
  const result = await store.listEventLog({
    wallet,
    topics: ["journey.preflight_completed"],
    limit: 500
  });
  assert.equal(result.events.length, 250);
  assert.equal(result.events[0].id, "journey-1");
  assert.equal(result.events.at(-1).id, "journey-250");
  const walletResult = await store.listJourneyEvents({ wallet });
  assert.equal(walletResult.events.length, 250);
  assert.equal(walletResult.events[0].id, "journey-1");
  assert.equal(walletResult.events.at(-1).id, "journey-250");
});

test("createStateStore throws in production when REDIS_URL is missing", () => {
  assert.throws(
    () => createStateStore({ NODE_ENV: "production" }, { logger: silentLogger() }),
    ExternalServiceError
  );
});

test("createStateStore throws when AUTH_MODE=strict without REDIS_URL", () => {
  assert.throws(
    () => createStateStore({ AUTH_MODE: "strict" }, { logger: silentLogger() }),
    ExternalServiceError
  );
});

test("createStateStore allows memory fallback with explicit opt-in", () => {
  const store = createStateStore(
    { NODE_ENV: "production", STATE_STORE_ALLOW_MEMORY: "1" },
    { logger: silentLogger() }
  );
  assert.ok(store instanceof MemoryStateStore);
});

test("MemoryStateStore rate limit window isolates across keys", async () => {
  const store = new MemoryStateStore();
  const a = await store.consumeRateLimit("bucket", "key-a", { limit: 1, windowSeconds: 60 });
  const b = await store.consumeRateLimit("bucket", "key-b", { limit: 1, windowSeconds: 60 });
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(a.remaining, 0);
});

test("MemoryStateStore rate limit returns allowed=false past the limit", async () => {
  const store = new MemoryStateStore();
  await store.consumeRateLimit("bucket", "key", { limit: 2, windowSeconds: 60 });
  await store.consumeRateLimit("bucket", "key", { limit: 2, windowSeconds: 60 });
  const third = await store.consumeRateLimit("bucket", "key", { limit: 2, windowSeconds: 60 });
  assert.equal(third.allowed, false);
  assert.equal(third.count, 3);
  assert.equal(third.remaining, 0);
});

test("daily aggregate budgets are global, idempotent, and reset on a new UTC day", async () => {
  const store = new MemoryStateStore();
  const scope = "onboarding-subsidy";

  const first = await store.reserveDailyBudget(scope, "2026-08-11", {
    reservationId: "session:wallet-a:job-1",
    amountUnits: 1_000_000,
    limitUnits: 1_000_000,
    ttlSeconds: 86_400
  });
  const replay = await store.reserveDailyBudget(scope, "2026-08-11", {
    reservationId: "session:wallet-a:job-1",
    amountUnits: 1_000_000,
    limitUnits: 1_000_000,
    ttlSeconds: 86_400
  });
  const rotatedWallet = await store.reserveDailyBudget(scope, "2026-08-11", {
    reservationId: "session:wallet-b:job-2",
    amountUnits: 1_000_000,
    limitUnits: 1_000_000,
    ttlSeconds: 86_400
  });
  const nextUtcDay = await store.reserveDailyBudget(scope, "2026-08-12", {
    reservationId: "session:wallet-b:job-3",
    amountUnits: 1_000_000,
    limitUnits: 1_000_000,
    ttlSeconds: 86_400
  });

  assert.equal(first.accepted, true);
  assert.equal(first.usedUnits, 1_000_000);
  assert.equal(replay.accepted, true);
  assert.equal(replay.alreadyReserved, true);
  assert.equal(replay.usedUnits, 1_000_000);
  assert.equal(rotatedWallet.accepted, false);
  assert.equal(rotatedWallet.usedUnits, 1_000_000);
  assert.equal(nextUtcDay.accepted, true);
  assert.equal(nextUtcDay.usedUnits, 1_000_000);
  assert.deepEqual(
    await store.getDailyBudgetUsage(scope, "2026-08-11"),
    { usedUnits: 1_000_000, reservationCount: 1 }
  );
});

test("MemoryStateStore counts SIWE nonce and verify events per canonical wallet", async () => {
  const store = new MemoryStateStore();
  const wallet = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const otherWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  await store.recordSiweAuthEvent({
    wallet,
    event: "nonce_issued",
    at: "2026-07-28T10:00:00.000Z"
  });
  await store.recordSiweAuthEvent({
    wallet,
    event: "nonce_issued",
    at: "2026-07-28T10:01:00.000Z"
  });
  await store.recordSiweAuthEvent({
    wallet,
    event: "verify_succeeded",
    at: "2026-07-28T10:02:00.000Z"
  });
  await store.recordSiweAuthEvent({
    wallet: otherWallet,
    event: "nonce_issued",
    at: "2026-07-28T10:03:00.000Z"
  });

  const activity = await store.listSiweAuthActivity({ limit: 10 });
  assert.deepEqual(activity, [
    {
      wallet: otherWallet,
      noncesIssued: 1,
      verifiesSucceeded: 0,
      verificationGap: 1,
      firstSeenAt: "2026-07-28T10:03:00.000Z",
      lastNonceIssuedAt: "2026-07-28T10:03:00.000Z",
      lastVerifySucceededAt: null,
      lastSeenAt: "2026-07-28T10:03:00.000Z"
    },
    {
      wallet: wallet.toLowerCase(),
      noncesIssued: 2,
      verifiesSucceeded: 1,
      verificationGap: 1,
      firstSeenAt: "2026-07-28T10:00:00.000Z",
      lastNonceIssuedAt: "2026-07-28T10:01:00.000Z",
      lastVerifySucceededAt: "2026-07-28T10:02:00.000Z",
      lastSeenAt: "2026-07-28T10:02:00.000Z"
    }
  ]);
  assert.equal((await store.listSiweAuthActivity({ limit: 1 })).length, 1);
});

test("MemoryStateStore mutation receipts round-trip", async () => {
  const store = new MemoryStateStore();
  const receipt = { id: "job-123", status: "created" };
  await store.upsertMutationReceipt("admin_jobs", "wallet:key-1", receipt);
  const loaded = await store.getMutationReceipt("admin_jobs", "wallet:key-1");
  assert.deepEqual(loaded, receipt);
});

test("MemoryStateStore atomically enforces locked-tier wallet and active-cohort caps", async () => {
  const store = new MemoryStateStore();
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const base = {
    wallet,
    tier: "t30",
    amountRaw: "1000000",
    lockedAt: "2026-08-24T00:00:00.000Z",
    termDays: 30,
    expiresAt: "2026-09-23T00:00:00.000Z",
    consentRef: `0x${"01".repeat(32)}`,
    status: "active"
  };
  const first = await store.createLockedTierEntry({ ...base, id: base.consentRef }, {
    perWalletCapRaw: "1000000",
    globalActiveCapRaw: "2000000"
  });
  const walletCap = await store.createLockedTierEntry({
    ...base,
    id: `0x${"02".repeat(32)}`,
    consentRef: `0x${"02".repeat(32)}`
  }, {
    perWalletCapRaw: "1000000",
    globalActiveCapRaw: "2000000"
  });
  const otherWallet = await store.createLockedTierEntry({
    ...base,
    id: `0x${"03".repeat(32)}`,
    consentRef: `0x${"03".repeat(32)}`,
    wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }, {
    perWalletCapRaw: "1000000",
    globalActiveCapRaw: "1500000"
  });
  assert.equal(first.accepted, true);
  assert.equal(walletCap.reason, "per_wallet_cap_exceeded");
  assert.equal(otherWallet.reason, "global_cap_exceeded");
  assert.equal((await store.listLockedTierEntries(wallet)).length, 1);
});

test("MemoryStateStore keeps a durable, filterable platform-fault remediation queue", async () => {
  const store = new MemoryStateStore();
  await store.upsertPlatformFaultRemediation({
    id: "remediation-old",
    status: "escalating",
    queuedAt: "2026-08-20T09:00:00.000Z"
  });
  await store.upsertPlatformFaultRemediation({
    id: "remediation-ready",
    status: "awaiting_hardware_arbitrator",
    queuedAt: "2026-08-20T10:00:00.000Z"
  });

  assert.deepEqual(
    (await store.listPlatformFaultRemediations({ status: "awaiting_hardware_arbitrator" }))
      .map((record) => record.id),
    ["remediation-ready"]
  );
  const fetched = await store.getPlatformFaultRemediation("remediation-ready");
  fetched.status = "mutated-copy";
  assert.equal(
    (await store.getPlatformFaultRemediation("remediation-ready")).status,
    "awaiting_hardware_arbitrator"
  );
});

test("MemoryStateStore keeps L3 posting requests and named refusals independently filterable", async () => {
  const store = new MemoryStateStore();
  await store.upsertL3PostingRequest({
    id: "l3-old",
    borrower: "0x1111111111111111111111111111111111111111",
    status: "repaid",
    createdAt: "2026-08-21T09:00:00.000Z"
  });
  await store.upsertL3PostingRequest({
    id: "l3-active",
    borrower: "0x2222222222222222222222222222222222222222",
    status: "posted",
    createdAt: "2026-08-21T10:00:00.000Z"
  });
  await store.appendL3PostingRefusal({
    id: "refusal-1",
    reason: "l3_disabled",
    refusedAt: "2026-08-21T10:01:00.000Z"
  });

  assert.deepEqual(
    (await store.listL3PostingRequests({ status: "posted" })).map((record) => record.id),
    ["l3-active"]
  );
  assert.deepEqual(
    (await store.listL3PostingRefusals({ reason: "l3_disabled" })).map((record) => record.id),
    ["refusal-1"]
  );
});

test("MemoryStateStore badge documents are write-once and cloned", async () => {
  const store = new MemoryStateStore();
  const original = { averray: { sessionId: "session-1", category: "security" } };
  const replacement = { averray: { sessionId: "session-1", category: "coding" } };

  await store.putBadgeDocument("session-1", original);
  original.averray.category = "mutated";
  await store.putBadgeDocument("session-1", replacement);

  const loaded = await store.getBadgeDocument("session-1");
  assert.equal(loaded.averray.category, "security");
  loaded.averray.category = "changed-after-read";
  assert.equal((await store.getBadgeDocument("session-1")).averray.category, "security");
});

test("MemoryStateStore run receipt documents are write-once and cloned", async () => {
  const store = new MemoryStateStore();
  const original = { schemaVersion: "averray.run-receipt.v1", verdict: { outcome: "approved" } };
  const replacement = { schemaVersion: "averray.run-receipt.v1", verdict: { outcome: "rejected" } };

  await store.putRunReceiptDocument("session-run", original);
  original.verdict.outcome = "mutated";
  await store.putRunReceiptDocument("session-run", replacement);

  const loaded = await store.getRunReceiptDocument("session-run");
  assert.equal(loaded.verdict.outcome, "approved");
  loaded.verdict.outcome = "changed-after-read";
  assert.equal((await store.getRunReceiptDocument("session-run")).verdict.outcome, "approved");
});

test("MemoryStateStore reserves one verification run per payment proof", async () => {
  const store = new MemoryStateStore();
  const first = await store.reserveVerificationRun({
    runId: "verify-1",
    status: "queued",
    submittedAt: "2026-08-19T08:00:00.000Z"
  }, {
    paymentId: "payment-proof-hash",
    authorization: { id: "private-authorization", signature: "private-signature" }
  });
  const replay = await store.reserveVerificationRun({ runId: "verify-2", status: "queued" }, {
    paymentId: "payment-proof-hash"
  });

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.run.runId, "verify-1");
  assert.equal(await store.getVerificationRun("verify-2"), undefined);
  assert.equal((await store.getVerificationRunByPaymentId("payment-proof-hash")).runId, "verify-1");
  assert.deepEqual(await store.getVerificationRunAuthorization("verify-1"), {
    id: "private-authorization",
    signature: "private-signature"
  });

  const [firstClaim, secondClaim] = await Promise.all([
    store.claimNextVerificationRun({ owner: "runner-one", claimedAt: "2026-08-19T08:00:01.000Z" }),
    store.claimNextVerificationRun({ owner: "runner-two", claimedAt: "2026-08-19T08:00:01.000Z" })
  ]);
  assert.equal([firstClaim, secondClaim].filter(Boolean).length, 1);
  const owner = firstClaim ? "runner-one" : "runner-two";
  const executed = await store.storeVerificationRunExecution("verify-1", {
    owner,
    executedAt: "2026-08-19T08:00:02.000Z",
    execution: { status: "decidable", evidence: "source_binding_verified tests_passed" }
  });
  assert.equal(executed.status, "executed");
  assert.equal((await store.storeVerificationRunExecution("verify-1", {
    owner,
    executedAt: "2026-08-19T08:00:03.000Z",
    execution: { status: "decidable", evidence: "duplicate" }
  })), undefined);

  await store.updateVerificationRun("verify-1", { runId: "verify-1", status: "complete" });
  assert.equal((await store.getVerificationRun("verify-1")).status, "complete");
  assert.equal(await store.getVerificationRunAuthorization("verify-1"), undefined);
});

test("MemoryStateStore indexes immutable work receipts by content id and upgrades the session alias", async () => {
  const store = new MemoryStateStore();
  const receiptId = `0x${"9".repeat(64)}`;
  const document = { schemaVersion: "averray.work-receipt.v1", receiptId, verdict: { outcome: "approved" } };
  await store.putWorkReceiptDocument("session-work", document);
  document.verdict.outcome = "mutated";

  assert.equal((await store.getWorkReceiptDocument(receiptId)).verdict.outcome, "approved");
  assert.equal((await store.getRunReceiptDocument("session-work")).schemaVersion, "averray.work-receipt.v1");
});

test("MemoryStateStore job receipt index prefers approved receipt, otherwise the most recent final receipt", async () => {
  const store = new MemoryStateStore();
  const jobId = "Catalog-Job-Multi";
  const receipt = (digit, outcome, verifiedAt) => ({
    schemaVersion: "averray.work-receipt.v1",
    receiptId: `0x${digit.repeat(64)}`,
    sessionId: `Session-${digit}`,
    jobId,
    verdict: { outcome },
    timestamps: { verifiedAt }
  });
  const rejectedOld = receipt("1", "rejected", "2026-08-24T08:00:00.000Z");
  const rejectedNew = receipt("2", "rejected", "2026-08-24T10:00:00.000Z");
  const approvedOlder = receipt("3", "approved", "2026-08-24T09:00:00.000Z");
  const rejectedNewest = receipt("4", "rejected", "2026-08-24T11:00:00.000Z");

  await store.putWorkReceiptDocument(rejectedOld.sessionId, rejectedOld);
  await store.putWorkReceiptDocument(rejectedNew.sessionId, rejectedNew);
  assert.equal((await store.getWorkReceiptDocumentByJob(jobId.toLowerCase())).receiptId, rejectedNew.receiptId);

  await store.putWorkReceiptDocument(approvedOlder.sessionId, approvedOlder);
  await store.putWorkReceiptDocument(rejectedNewest.sessionId, rejectedNewest);
  assert.equal((await store.getWorkReceiptDocumentByJob(jobId.toUpperCase())).receiptId, approvedOlder.receiptId);
  assert.equal((await store.getWorkReceiptDocumentBySession("SESSION-3")).receiptId, approvedOlder.receiptId);
});

test("RedisStateStore writes lowercase session and job receipt indexes", async () => {
  const store = new RedisStateStore("redis://unused", "receipt-test");
  const values = new Map();
  store.connect = async () => {};
  store.client = {
    async set(key, value, options) {
      if (!options?.NX || !values.has(key)) values.set(key, value);
    },
    async get(key) { return values.get(key); },
    async eval(_script, { keys, arguments: args }) {
      if (values.has(keys[0])) return 0;
      values.set(keys[0], args[0]);
      return 1;
    }
  };
  const document = {
    schemaVersion: "averray.work-receipt.v1",
    receiptId: `0x${"a".repeat(64)}`,
    sessionId: "Session-Mixed",
    jobId: "Job-Mixed",
    verdict: { outcome: "approved" },
    timestamps: { verifiedAt: "2026-08-24T10:00:00.000Z" }
  };

  await store.putWorkReceiptDocument(document.sessionId, document);

  assert.ok(values.has("receipt-test:work-receipt-session:session-mixed"));
  assert.ok(values.has("receipt-test:work-receipt-job:job-mixed"));
  assert.equal((await store.getWorkReceiptDocumentBySession("SESSION-MIXED")).receiptId, document.receiptId);
  assert.equal((await store.getWorkReceiptDocumentByJob("JOB-MIXED")).receiptId, document.receiptId);
});

test("RedisStateStore keeps idle-balance revocation durable and rejects replayed terms", async () => {
  const store = new RedisStateStore("redis://unused", "idle-consent-test");
  const values = new Map();
  const revokedByWallet = new Map();
  const consentWallets = new Set();
  store.connect = async () => {};
  store.client = {
    async get(key) { return values.get(key); },
    async eval(_script, { keys, arguments: args }) {
      if (args.length === 3) {
        const revoked = revokedByWallet.get(keys[1]) ?? new Set();
        if (revoked.has(args[1])) return 0;
        values.set(keys[0], args[0]);
        consentWallets.add(args[2]);
        return 1;
      }
      const raw = values.get(keys[0]);
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (record.status !== "revoked") {
        record.status = "revoked";
        record.revokedAt = args[0];
        values.set(keys[0], JSON.stringify(record));
        const revoked = revokedByWallet.get(keys[1]) ?? new Set();
        revoked.add(record.termsHash.toLowerCase());
        revokedByWallet.set(keys[1], revoked);
      }
      return values.get(keys[0]);
    },
    async sMembers() { return [...consentWallets]; }
  };
  const wallet = "0x1111111111111111111111111111111111111111";
  const record = {
    wallet: wallet.toUpperCase().replace("0X", "0x"),
    status: "active",
    termsHash: `0x${"ab".repeat(32)}`
  };

  assert.equal((await store.putIdleBalanceConsent(record)).accepted, true);
  assert.equal((await store.getIdleBalanceConsent(wallet)).wallet, wallet);
  assert.equal((await store.listIdleBalanceConsents())[0].wallet, wallet);
  assert.equal((await store.revokeIdleBalanceConsent(wallet, {
    revokedAt: "2026-08-25T12:00:00.000Z"
  })).status, "revoked");
  assert.deepEqual(await store.putIdleBalanceConsent(record), {
    accepted: false,
    reason: "consent_revoked",
    record: undefined
  });
});

test("MemoryStateStore keeps subsidy attestations append-only by lowercase transaction hash", async () => {
  const store = new MemoryStateStore();
  const txHash = `0x${"AB".repeat(32)}`;
  const first = await store.putYieldSubsidyEntry({
    txHash,
    amountRaw: "1000000",
    blockNumber: 100,
    timestamp: "2026-08-25T12:00:00.000Z"
  });
  const replay = await store.putYieldSubsidyEntry({
    txHash: txHash.toLowerCase(),
    amountRaw: "9999999",
    blockNumber: 101,
    timestamp: "2026-08-25T12:01:00.000Z"
  });

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.entry.amountRaw, "1000000");
  assert.deepEqual(await store.listYieldSubsidyEntries(), [first.entry]);
});

test("MemoryStateStore upgrades an unsigned badge with one signature only", async () => {
  const store = new MemoryStateStore();
  await store.putBadgeDocument("session-sign", { averray: { sessionId: "session-sign", category: "security" } });
  const first = { alg: "ES256", kid: "badge-1", sig: "first..sig", signedAt: "2026-07-11T00:00:00.000Z" };
  const replacement = { alg: "ES256", kid: "badge-2", sig: "second..sig", signedAt: "2026-07-12T00:00:00.000Z" };

  await store.setBadgeDocumentSignature("session-sign", first);
  await store.setBadgeDocumentSignature("session-sign", replacement);

  const stored = await store.getBadgeDocument("session-sign");
  assert.equal(stored.averray.category, "security");
  assert.deepEqual(stored.signature, first);
});

test("MemoryStateStore content blobs round-trip by lowercase hash", async () => {
  const store = new MemoryStateStore();
  const record = {
    hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    payload: { rationale: "upheld" },
    contentType: "arbitrator_reasoning",
    ownerWallet: "0x1111111111111111111111111111111111111111",
    verdict: "fail",
    createdAt: "2026-01-01T00:00:00.000Z",
    autoPublicAt: "2026-06-30T00:00:00.000Z"
  };

  await store.upsertContent(record);

  assert.deepEqual(
    await store.getContent("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    record
  );
});

test("MemoryStateStore funded jobs round-trip and list latest first", async () => {
  const store = new MemoryStateStore();
  await store.upsertFundedJob({
    jobId: "job-1",
    fundedAt: "2026-01-01T00:00:00.000Z",
    finalStatus: "open"
  });
  await store.upsertFundedJob({
    jobId: "job-2",
    fundedAt: "2026-01-02T00:00:00.000Z",
    finalStatus: "merged"
  });

  assert.equal((await store.getFundedJob("job-1")).finalStatus, "open");
  assert.deepEqual(
    (await store.getFundedJobs(["job-2", "missing", "job-1"])).map((entry) => entry?.jobId),
    ["job-2", undefined, "job-1"]
  );
  assert.deepEqual((await store.listFundedJobs({ limit: 2 })).map((entry) => entry.jobId), ["job-2", "job-1"]);
  assert.deepEqual((await store.listFundedJobs({ finalOnly: true })).map((entry) => entry.jobId), ["job-2"]);
});

test("RedisStateStore fetches N funded jobs with one MGET", async () => {
  const store = new RedisStateStore("redis://unused", "test");
  let mGetCalls = 0;
  let observedKeys;
  store.connect = async () => {};
  store.client = {
    async mGet(keys) {
      mGetCalls += 1;
      observedKeys = keys;
      return [JSON.stringify({ jobId: "job-1" }), null, "malformed"];
    }
  };

  const records = await store.getFundedJobs(["job-1", "missing", "bad"]);

  assert.equal(mGetCalls, 1);
  assert.deepEqual(observedKeys, [
    "test:funded-job:job-1",
    "test:funded-job:missing",
    "test:funded-job:bad"
  ]);
  assert.deepEqual(records, [{ jobId: "job-1" }, undefined, undefined]);
});

test("MemoryStateStore xcm observations round-trip and clear from pending when processed", async () => {
  const store = new MemoryStateStore();
  const wrapperAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const requestId = "0x1111111111111111111111111111111111111111111111111111111111111111";
  await store.upsertXcmObservation({
    wrapperAddress,
    requestId,
    status: "succeeded",
    settledAssets: 5,
    processed: false
  });

  const pending = await store.listPendingXcmObservations(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].settledAssets, 5);

  await store.markXcmObservationProcessed(
    wrapperAddress,
    requestId,
    { settledVia: "agent_account" }
  );

  const after = await store.listPendingXcmObservations(10);
  assert.equal(after.length, 0);
});

test("MemoryStateStore event log survives buffer-sized reads and filters by source/correlation", async () => {
  const store = new MemoryStateStore();
  await store.appendEventLog({
    id: "event-1",
    topic: "escrow.job_funded",
    source: "chain",
    phase: "funding",
    severity: "info",
    wallet: "0xaaa",
    wallets: ["0xaaa"],
    jobId: "job-1",
    correlationId: "job-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {}
  });
  await store.appendEventLog({
    id: "event-2",
    topic: "xcm.settlement_failed",
    source: "settlement",
    phase: "settlement",
    severity: "error",
    wallet: "0xaaa",
    wallets: ["0xaaa"],
    jobId: "job-1",
    correlationId: "settlement-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    data: {}
  });

  const sourceFiltered = await store.listEventLog({ jobId: "job-1", sources: ["chain"], limit: 10 });
  assert.deepEqual(sourceFiltered.events.map((event) => event.id), ["event-1"]);
  assert.equal(sourceFiltered.gap, false);

  const correlationFiltered = await store.listEventLog({
    wallet: "0xaaa",
    correlationId: "settlement-1",
    limit: 10
  });
  assert.deepEqual(correlationFiltered.events.map((event) => event.id), ["event-2"]);

  const afterCursor = await store.listEventLog({ jobId: "job-1", lastEventId: "event-1", limit: 10 });
  assert.deepEqual(afterCursor.events.map((event) => event.id), ["event-2"]);
});

test("bank deposit dispatch evidence survives eviction from the 5,000-record generic timeline", async () => {
  const store = new MemoryStateStore();
  const wrapper = "0xf20b35a3f85ec864127b551ce8a64446fc0ed2bc";
  const requestId = "0xeaa4d5007c8154d390bbab0557a8c03d1c59c1a1b4faca8c761902241b087767";
  const event = {
    id: `bank.v22_leg_dispatched-${requestId}-1786025758745`,
    topic: "bank.v22_leg_dispatched",
    correlationId: requestId,
    timestamp: "2026-08-06T14:15:58.745Z",
    data: {
      requestId,
      wrapper,
      leg: "deposit_sell",
      txHash: "0x43a1cff204eb087872bdc7f5fa55ef74261cafd90863caee4720961b00e7d1af",
      blockNumber: 19_135_461,
      dryRun: {
        events: [{
          section: "broadcast",
          method: "Swapped",
          data: {
            fillerType: "AAVE",
            assetIn: 22,
            assetOut: 1003,
            outputs: [{ asset: "1,003", amount: "10,000,000" }]
          }
        }]
      }
    }
  };
  await store.appendEventLog(event);
  for (let index = 0; index < 5_001; index += 1) {
    await store.appendEventLog({
      id: `unrelated-${index}`,
      topic: "session.updated",
      timestamp: new Date(Date.parse("2026-08-06T15:00:00.000Z") + index).toISOString(),
      data: {}
    });
  }

  const timeline = await store.listEventLog({ topics: ["bank.v22_leg_dispatched"], limit: 500 });
  assert.equal(timeline.events.length, 0, "the generic timeline should reproduce production eviction");
  assert.deepEqual(
    await store.getBankXcmLegDispatchEvidence(wrapper, requestId, "deposit_sell"),
    event
  );
  assert.deepEqual(
    await store.getLatestBankXcmLegDispatchEvidence(wrapper, "deposit_sell"),
    event
  );
});

test("MemoryStateStore persists only watcher-materialized external drafts and demand signals privately", async () => {
  const store = new MemoryStateStore();
  const wallet = "0x1111111111111111111111111111111111111111";
  const draft = {
    draftId: "draft-1",
    wallet,
    jobId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    definition: { rewardAmount: "1.0" },
    createdAt: "2026-07-28T00:00:00.000Z",
    expiresAt: "2026-07-31T00:00:00.000Z",
    status: "live",
    materializedAt: "2026-07-28T01:00:00.000Z"
  };

  assert.equal(await store.materializeExternalJobDraft(draft), true);
  assert.equal(await store.materializeExternalJobDraft(draft), false);
  assert.deepEqual(await store.getExternalJobDraft("draft-1"), draft);
  assert.deepEqual(await store.getExternalJobDraftByJobId(draft.jobId), draft);
  assert.deepEqual(await store.listExternalJobDrafts({ status: "live" }), [draft]);

  const delisted = await store.updateExternalJobDraft("draft-1", {
    status: "delisted"
  });
  assert.equal(delisted.status, "delisted");
  assert.deepEqual(await store.listExternalJobDrafts({ status: "delisted" }), [delisted]);

  await store.appendExternalPostingDemandSignal({
    id: "signal-1",
    wallet,
    requestedReward: "0.99",
    schema: "schema://jobs/coding-output",
    decision: "floor_rejected",
    attemptedAt: "2026-07-28T00:00:00.000Z"
  });
  assert.deepEqual(
    (await store.listExternalPostingDemandSignals()).map((entry) => entry.decision),
    ["floor_rejected"]
  );
});

test("MemoryStateStore external delisting is idempotent projection state", async () => {
  const store = new MemoryStateStore();
  const jobId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const record = {
    jobId,
    adminWallet: "0x2222222222222222222222222222222222222222",
    reason: "operator backstop",
    delistedAt: "2026-07-28T00:00:00.000Z"
  };

  await store.upsertExternalJobDelisting(record);
  assert.deepEqual(await store.getExternalJobDelisting(jobId), record);
  assert.equal(await store.isExternalJobDelisted(jobId), true);
  assert.equal(await store.isExternalJobDelisted("curated-1"), false);
});

test("MemoryStateStore persists normalized x402 funding state independently of demand", async () => {
  const store = new MemoryStateStore();
  const record = {
    id: `0x${"f".repeat(64)}`,
    fundingRail: "x402",
    status: "escrow_created",
    draftId: `0x${"d".repeat(64)}`,
    jobId: `0x${"a".repeat(64)}`,
    posterWallet: "0x1111111111111111111111111111111111111111",
    pooledAccount: "0x2222222222222222222222222222222222222222",
    reservedRaw: "1050000",
    createdAt: "2026-08-09T12:00:00.000Z",
    updatedAt: "2026-08-09T12:01:00.000Z"
  };

  const stored = await store.upsertExternalPaymentFunding(record);
  stored.status = "mutated-copy";

  assert.deepEqual(await store.getExternalPaymentFunding(record.id), record);
  assert.deepEqual(await store.listExternalPaymentFundings(), [record]);
});

test("MemoryStateStore indexes escrow-first quote demand and materializes a funded draft atomically", async () => {
  const store = new MemoryStateStore();
  const jobId = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const signal = {
    id: "quote-1",
    decision: "quoted",
    attemptCount: 1,
    fundingStatus: "unfunded",
    quote: { draftId: "quote-1", jobId, wallet: "0x1111111111111111111111111111111111111111" }
  };

  await store.appendExternalPostingDemandSignal(signal);
  assert.deepEqual(await store.getExternalPostingDemandSignal("quote-1"), signal);
  assert.deepEqual(await store.getExternalPostingQuoteByJobId(jobId), signal);
  await store.updateExternalPostingDemandSignal("quote-1", { attemptCount: 2 });
  assert.equal((await store.getExternalPostingDemandSignal("quote-1")).attemptCount, 2);
  assert.equal((await store.listExternalPostingDemandSignals()).length, 1);

  const materialized = { ...signal.quote, status: "live", persisted: true };
  assert.equal(await store.materializeExternalJobDraft(materialized), true);
  assert.equal(await store.materializeExternalJobDraft(materialized), false);
  assert.deepEqual(await store.getExternalJobDraftByJobId(jobId), materialized);
});

test("MemoryStateStore service state round-trips and merges", async () => {
  const store = new MemoryStateStore();
  await store.upsertServiceState("xcm-observer", {
    cursor: "cursor-1",
    lastObservedCount: 2
  });

  const updated = await store.upsertServiceState("xcm-observer", {
    lastObservedCount: 3,
    lastError: undefined
  });

  assert.equal(updated.cursor, "cursor-1");
  assert.equal(updated.lastObservedCount, 3);

  const loaded = await store.getServiceState("xcm-observer");
  assert.equal(loaded.cursor, "cursor-1");
  assert.equal(loaded.lastObservedCount, 3);
});

test("MemoryStateStore scopes identical XCM request ids by wrapper generation", async () => {
  const store = new MemoryStateStore();
  const requestId = `0x${"61".repeat(32)}`;
  const wrapperV21 = "0x2af394fa95f75d3ca1c786128f4dfa1eb0c9675d";
  const wrapperV22 = "0xecee778e11b238d2fc096e56460e7b98dc7b26b8";
  const base = {
    requestId,
    status: "pending",
    direction: "increase",
    startedAt: "2026-08-05T06:00:00.000Z",
    deadlineAt: "2026-08-05T07:00:00.000Z"
  };

  await store.upsertXcmBalanceWatch({ ...base, wrapperAddress: wrapperV21, phase: "retired-generation" });
  await store.upsertXcmBalanceWatch({ ...base, wrapperAddress: wrapperV22, phase: "active-generation" });

  assert.equal((await store.getXcmBalanceWatch(wrapperV21, requestId)).phase, "retired-generation");
  assert.equal((await store.getXcmBalanceWatch(wrapperV22, requestId)).phase, "active-generation");
  assert.equal((await store.listPendingXcmBalanceWatches()).length, 2);
});

test("MemoryStateStore lists recent sessions in latest-first order", async () => {
  const store = new MemoryStateStore();
  await store.upsertSession({
    sessionId: "session-1",
    idempotencyKey: "claim-1",
    wallet: "0xaaa",
    jobId: "job-1",
    status: "claimed"
  });
  await store.upsertSession({
    sessionId: "session-2",
    idempotencyKey: "claim-2",
    wallet: "0xbbb",
    jobId: "job-2",
    status: "submitted"
  });

  const sessions = await store.listRecentSessions(2);
  assert.deepEqual(sessions.map((entry) => entry.sessionId), ["session-2", "session-1"]);
});

test("dual-form session records index only by lowercase H160 and never by lowercased SS58", async () => {
  const ss58 = "14RLk2G7hu2xMEYL1hbkcwbwWgjL6Nem3fL1maD2GYP1pGNe";
  const identity = parseWalletIdentity(ss58);
  const session = {
    sessionId: "dual-form-session",
    jobId: "dual-form-job",
    wallet: identity.h160,
    walletIdentity: identity,
    status: "claimed"
  };

  const memory = new MemoryStateStore();
  const stored = await memory.upsertSession(session);
  assert.deepEqual(stored.walletIdentity, identity);
  assert.equal(stored.wallet, identity.h160);
  assert.deepEqual(memory.walletSessions.get(identity.h160), [session.sessionId]);
  assert.equal(memory.walletSessions.has(ss58), false);
  assert.equal(memory.walletSessions.has(ss58.toLowerCase()), false);
  assert.equal((await memory.listSessionsByWallet(ss58))[0].sessionId, session.sessionId);

  const redis = new RedisStateStore("redis://unused", "identity");
  const indexKeys = [];
  let storedRedisSession;
  redis.connect = async () => {};
  redis.client = {
    async set(key, value) {
      if (key === "identity:session:dual-form-session") storedRedisSession = JSON.parse(value);
    },
    async zAdd(key) { indexKeys.push(key); }
  };
  await redis.upsertSession(session);
  assert.deepEqual(storedRedisSession.walletIdentity, identity);
  assert.equal(storedRedisSession.wallet, identity.h160);
  assert.ok(indexKeys.includes(`identity:wallet-sessions:${identity.h160}`));
  assert.equal(indexKeys.some((key) => key.includes(ss58) || key.includes(ss58.toLowerCase())), false);
});

test("MemoryStateStore never indexes sessions under a missing idempotency key", async () => {
  const store = new MemoryStateStore();
  await store.upsertSession({
    sessionId: "session-without-key-1",
    wallet: "0xaaa",
    jobId: "job-without-key-1",
    status: "claimed"
  });
  await store.upsertSession({
    sessionId: "session-without-key-2",
    wallet: "0xbbb",
    jobId: "job-without-key-2",
    status: "claimed"
  });

  assert.equal(await store.findSessionByIdempotencyKey(undefined), undefined);
  assert.equal(await store.findSessionByIdempotencyKey(""), undefined);
  assert.equal((await store.getSession("session-without-key-1")).jobId, "job-without-key-1");
  assert.equal((await store.getSession("session-without-key-2")).jobId, "job-without-key-2");
});

test("RedisStateStore never writes or reads a missing idempotency-key index", async () => {
  const store = new RedisStateStore("redis://unused", "test");
  const writtenKeys = [];
  store.connect = async () => {};
  store.client = {
    set: async (key) => writtenKeys.push(key),
    zAdd: async () => {}
  };

  await store.upsertSession({
    sessionId: "redis-session-without-key",
    wallet: "0xaaa",
    jobId: "redis-job-without-key",
    status: "claimed"
  });

  assert.equal(writtenKeys.some((key) => key.startsWith("test:idempotency:")), false);
  store.connect = async () => assert.fail("missing-key lookup must return before connecting");
  assert.equal(await store.findSessionByIdempotencyKey(undefined), undefined);
  assert.equal(await store.findSessionByIdempotencyKey("  "), undefined);
});
