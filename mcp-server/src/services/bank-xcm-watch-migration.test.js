import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStateStore, RedisStateStore } from "../core/state-store.js";
import {
  BANK_XCM_V21_WATCH_MIGRATION,
  migrateLegacyBankV21BalanceWatch
} from "./bank-xcm-watch-migration.js";

test("legacy v2.1 watch is archived terminal under its wrapper generation", async () => {
  const store = new MemoryStateStore();
  const migration = BANK_XCM_V21_WATCH_MIGRATION;
  store.xcmBalanceWatches.set(migration.requestId, {
    requestId: migration.requestId,
    status: "pending",
    phase: "leg2-dispatched",
    target: { ledger: "substrate_tokens", account: migration.targetAccount, assetId: 22 },
    direction: "increase",
    startedAt: "2026-08-04T10:36:13.645Z",
    deadlineAt: "2026-08-04T10:51:13.645Z"
  });

  const first = await migrateLegacyBankV21BalanceWatch(store, { logger: { info() {} } });
  assert.equal(first.status, "migrated");
  assert.equal(store.xcmBalanceWatches.has(migration.requestId), false);
  const archived = await store.getXcmBalanceWatch(migration.wrapperAddress, migration.requestId);
  assert.equal(archived.wrapperAddress, migration.wrapperAddress);
  assert.equal(archived.status, "failed");
  assert.equal(archived.phase, "terminal");
  assert.equal(archived.registrationSource, "legacy_generation_migration");
  assert.equal(archived.archive.releaseStatus, "released_closed");
  assert.equal((await store.listPendingXcmBalanceWatches()).length, 0);
  assert.deepEqual((await store.listRecentTerminalXcmBalanceWatches()).map((watch) => watch.requestId), [
    migration.requestId
  ]);

  const replay = await migrateLegacyBankV21BalanceWatch(store, { logger: { info() {} } });
  assert.equal(replay.status, "already_migrated");
});

test("legacy watch migration refuses an unaudited target account", async () => {
  const store = new MemoryStateStore();
  const migration = BANK_XCM_V21_WATCH_MIGRATION;
  store.xcmBalanceWatches.set(migration.requestId, {
    requestId: migration.requestId,
    target: { account: `0x${"99".repeat(32)}` }
  });

  await assert.rejects(
    migrateLegacyBankV21BalanceWatch(store, { logger: { info() {} } }),
    /did not match the audited generation target/u
  );
});

test("Redis migration atomically replaces the legacy index with a generation-scoped terminal index", async () => {
  const migration = BANK_XCM_V21_WATCH_MIGRATION;
  const values = new Map();
  const sortedSets = new Map();
  const client = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async del(key) { return values.delete(key) ? 1 : 0; },
    async zAdd(key, entry) {
      const set = sortedSets.get(key) ?? new Map();
      set.set(entry.value, entry.score);
      sortedSets.set(key, set);
    },
    async zRem(key, value) { return sortedSets.get(key)?.delete(value) ? 1 : 0; },
    async zRange(key, start, stop, options = {}) {
      const entries = [...(sortedSets.get(key) ?? new Map()).entries()]
        .sort((left, right) => left[1] - right[1]);
      if (options.REV) entries.reverse();
      return entries.slice(start, stop + 1).map(([value]) => value);
    },
    multi() {
      const transaction = {
        set: (...args) => { void client.set(...args); return transaction; },
        del: (...args) => { void client.del(...args); return transaction; },
        zRem: (...args) => { void client.zRem(...args); return transaction; },
        zAdd: (...args) => { void client.zAdd(...args); return transaction; },
        async exec() { return []; }
      };
      return transaction;
    }
  };
  const namespace = "agent-platform-mainnet";
  const store = new RedisStateStore("redis://unused", namespace);
  store.client = client;
  store.connectionPromise = Promise.resolve();
  const legacyKey = `${namespace}:xcm-balance-watch:${migration.requestId}`;
  const pendingKey = `${namespace}:xcm-balance-watches:pending`;
  values.set(legacyKey, JSON.stringify({
    requestId: migration.requestId,
    status: "pending",
    target: { account: migration.targetAccount },
    startedAt: "2026-08-04T10:36:13.645Z"
  }));
  sortedSets.set(pendingKey, new Map([[migration.requestId, 1]]));

  const result = await migrateLegacyBankV21BalanceWatch(store, { logger: { info() {} } });
  const storageId = `${migration.wrapperAddress}:${migration.requestId}`;
  assert.equal(result.status, "migrated");
  assert.equal(values.has(legacyKey), false);
  assert.equal(sortedSets.get(pendingKey).has(migration.requestId), false);
  assert.equal((await store.getXcmBalanceWatch(migration.wrapperAddress, migration.requestId)).status, "failed");
  assert.deepEqual((await store.listRecentTerminalXcmBalanceWatches()).map((watch) => (
    `${watch.wrapperAddress}:${watch.requestId}`
  )), [storageId]);
});
