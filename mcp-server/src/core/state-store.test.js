import test from "node:test";
import assert from "node:assert/strict";

import { createStateStore, MemoryStateStore } from "./state-store.js";
import { ExternalServiceError } from "./errors.js";

function silentLogger() {
  return { warn() {}, error() {}, info() {}, log() {} };
}

test("createStateStore returns MemoryStateStore in dev without REDIS_URL", () => {
  const store = createStateStore({ NODE_ENV: "development", AUTH_MODE: "permissive" }, { logger: silentLogger() });
  assert.ok(store instanceof MemoryStateStore);
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

test("MemoryStateStore mutation receipts round-trip", async () => {
  const store = new MemoryStateStore();
  const receipt = { id: "job-123", status: "created" };
  await store.upsertMutationReceipt("admin_jobs", "wallet:key-1", receipt);
  const loaded = await store.getMutationReceipt("admin_jobs", "wallet:key-1");
  assert.deepEqual(loaded, receipt);
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
  assert.deepEqual((await store.listFundedJobs({ limit: 2 })).map((entry) => entry.jobId), ["job-2", "job-1"]);
  assert.deepEqual((await store.listFundedJobs({ finalOnly: true })).map((entry) => entry.jobId), ["job-2"]);
});

test("MemoryStateStore xcm observations round-trip and clear from pending when processed", async () => {
  const store = new MemoryStateStore();
  await store.upsertXcmObservation({
    requestId: "0x1111111111111111111111111111111111111111111111111111111111111111",
    status: "succeeded",
    settledAssets: 5,
    processed: false
  });

  const pending = await store.listPendingXcmObservations(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].settledAssets, 5);

  await store.markXcmObservationProcessed(
    "0x1111111111111111111111111111111111111111111111111111111111111111",
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
