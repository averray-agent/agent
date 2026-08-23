import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MemoryStateStore, RedisStateStore } from "../core/state-store.js";
import {
  WALLET_SESSION_INDEX_REPAIR_SCOPE,
  repairWalletSessionIndex
} from "./wallet-session-index-repair.js";

const WALLET = "0x97450BF69Cb4aEB0b33db3aE51AC2D18224d4b5c";
const NORMALIZED_WALLET = WALLET.toLowerCase();

function settledSession(revision, wallet = WALLET) {
  return {
    sessionId: `wiki-en-80171159-citation-repair-in-the-suburbs-of-moscow-r${revision}:${wallet}`,
    jobId: `wiki-en-80171159-citation-repair-in-the-suburbs-of-moscow-r${revision}`,
    wallet,
    status: "resolved",
    updatedAt: `2026-08-${revision === 24 ? "23" : "22"}T${String(revision).padStart(2, "0")}:00:00.000Z`
  };
}

function seedLegacySplit(store) {
  const sessions = [
    settledSession(21),
    settledSession(22, NORMALIZED_WALLET),
    settledSession(23),
    settledSession(24)
  ];
  for (const session of sessions) store.sessions.set(session.sessionId, session);
  store.walletSessions.set(WALLET, [sessions[3].sessionId, sessions[2].sessionId, sessions[0].sessionId]);
  store.walletSessions.set(NORMALIZED_WALLET, [sessions[1].sessionId]);
  return sessions;
}

test("wallet-session index repair joins the exact QA10 casing split, logs its count, and is idempotent", async () => {
  const store = new MemoryStateStore();
  const sessions = seedLegacySplit(store);
  const logs = [];
  const logger = { info(fields, message) { logs.push({ fields, message }); } };

  const repaired = await repairWalletSessionIndex({
    stateStore: store,
    logger,
    now: () => new Date("2026-08-23T10:30:00.000Z")
  });

  assert.deepEqual(repaired, {
    documentsScanned: 4,
    walletsScanned: 1,
    invalidSessions: 0,
    mismatchedWallets: 1,
    missingEntries: 3,
    orphanedEntries: 0,
    repairedEntries: 3,
    completedAt: "2026-08-23T10:30:00.000Z",
    skipped: false
  });
  assert.deepEqual(
    new Set((await store.listSessionsByWallet(WALLET, 10)).map((session) => session.sessionId)),
    new Set(sessions.map((session) => session.sessionId))
  );
  assert.deepEqual(
    new Set((await store.listSessionsByWallet(NORMALIZED_WALLET, 10)).map((session) => session.sessionId)),
    new Set(sessions.map((session) => session.sessionId))
  );
  assert.equal(logs[0].message, "wallet_session_index_repair.completed");
  assert.equal((await store.getServiceState(WALLET_SESSION_INDEX_REPAIR_SCOPE)).result.repairedEntries, 3);

  const replay = await repairWalletSessionIndex({ stateStore: store, logger });
  assert.equal(replay.skipped, true);
  assert.equal(replay.repairedEntries, 3);
  assert.equal(logs[1].message, "wallet_session_index_repair.already_complete");
});

test("new memory-store writes and reads use one normalized wallet-session key", async () => {
  const store = new MemoryStateStore();
  const session = settledSession(24);
  await store.upsertSession(session);

  assert.equal(store.walletSessions.has(WALLET), false);
  assert.deepEqual(store.walletSessions.get(NORMALIZED_WALLET), [session.sessionId]);
  assert.equal((await store.listSessionsByWallet(WALLET, 10))[0].sessionId, session.sessionId);
});

test("Redis wallet-session reconciliation scans documents and adds only missing normalized links", async () => {
  const store = new RedisStateStore("redis://unused", "qa10");
  const sessions = [
    settledSession(21),
    settledSession(22, NORMALIZED_WALLET),
    settledSession(23),
    settledSession(24)
  ];
  const indexed = [sessions[1].sessionId];
  const writes = [];
  let scanOptions;
  store.connect = async () => {};
  store.client = {
    async *scanIterator(options) {
      scanOptions = options;
      yield sessions.map((session) => `qa10:session:${session.sessionId}`);
    },
    async mGet() {
      return sessions.map((session) => JSON.stringify(session));
    },
    async zRange(key) {
      assert.equal(key, `qa10:wallet-sessions:${NORMALIZED_WALLET}`);
      return indexed;
    },
    async zAdd(key, entries) {
      writes.push({ key, entries });
      return entries.length;
    }
  };

  const result = await store.reconcileWalletSessionIndex();

  assert.deepEqual(scanOptions, { MATCH: "qa10:session:*", COUNT: 200 });
  assert.equal(result.mismatchedWallets, 1);
  assert.equal(result.missingEntries, 3);
  assert.equal(result.repairedEntries, 3);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, `qa10:wallet-sessions:${NORMALIZED_WALLET}`);
  assert.deepEqual(
    new Set(writes[0].entries.map((entry) => entry.value)),
    new Set([sessions[0].sessionId, sessions[2].sessionId, sessions[3].sessionId])
  );
});

test("Redis upsert normalizes the wallet index without rewriting the session document wallet", async () => {
  const store = new RedisStateStore("redis://unused", "qa10");
  const zAddKeys = [];
  let storedSession;
  store.connect = async () => {};
  store.client = {
    async set(key, value) {
      if (key.startsWith("qa10:session:")) storedSession = JSON.parse(value);
    },
    async zAdd(key) { zAddKeys.push(key); }
  };

  await store.upsertSession(settledSession(24));

  assert.equal(storedSession.wallet, WALLET);
  assert.ok(zAddKeys.includes(`qa10:wallet-sessions:${NORMALIZED_WALLET}`));
  assert.equal(zAddKeys.includes(`qa10:wallet-sessions:${WALLET}`), false);
});

test("production bootstrap awaits the named repair before constructing PlatformService", async () => {
  const source = await readFile(new URL("./bootstrap.js", import.meta.url), "utf8");
  const repairCall = source.indexOf("await repairWalletSessionIndex({ stateStore, logger })");
  const platformConstruction = source.indexOf("new PlatformService(", repairCall);

  assert.ok(repairCall >= 0, "bootstrap must await the wallet-session repair");
  assert.ok(platformConstruction > repairCall, "repair must complete before progression-capable service construction");
});
