// Tests for snapshot-store.js — localStorage snapshot writer +
// 24h sliding TTL eviction. M4 milestone.

import test from "node:test";
import assert from "node:assert/strict";

import {
  writeSnapshot,
  listSnapshotTimestamps,
  readSnapshot,
  evictExpired,
  SNAPSHOT_KEY_PREFIX,
  SNAPSHOT_TTL_MS,
} from "./snapshot-store.js";

// In-memory Map-backed storage that mirrors the localStorage API.
function makeMockStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return {
    get length() { return m.size; },
    key(i) {
      const keys = [...m.keys()];
      return keys[i] ?? null;
    },
    getItem(k) {
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      m.set(k, String(v));
    },
    removeItem(k) {
      m.delete(k);
    },
    clear() { m.clear(); },
    _map: m,
  };
}

// Frozen clock helper — returns a stable epoch ms.
function frozenNow(iso) {
  return () => Date.parse(iso);
}

// ── writeSnapshot ───────────────────────────────────────────────────

test("writeSnapshot: writes the snapshot under monitor.snapshot.<at>", () => {
  const storage = makeMockStorage();
  const result = writeSnapshot(
    { at: "2026-05-27T17:30:00Z", cards: [{ id: "a" }] },
    { storage, now: frozenNow("2026-05-27T17:30:00Z") }
  );
  assert.equal(result.key, `${SNAPSHOT_KEY_PREFIX}2026-05-27T17:30:00Z`);
  assert.equal(result.evicted, 0);
  assert.equal(storage.length, 1);
});

test("writeSnapshot: stored value is the round-trippable JSON of the snapshot", () => {
  const storage = makeMockStorage();
  const snap = { at: "2026-05-27T17:30:00Z", cards: [{ id: "a", lane: "drafts" }] };
  writeSnapshot(snap, { storage, now: frozenNow("2026-05-27T17:30:00Z") });
  const read = readSnapshot(snap.at, { storage });
  assert.deepEqual(read, snap);
});

test("writeSnapshot: subsequent writes accumulate (one entry per timestamp)", () => {
  const storage = makeMockStorage();
  const at1 = "2026-05-27T17:30:00Z";
  const at2 = "2026-05-27T17:31:00Z";
  writeSnapshot({ at: at1, cards: [] }, { storage, now: frozenNow(at1) });
  writeSnapshot({ at: at2, cards: [] }, { storage, now: frozenNow(at2) });
  assert.equal(storage.length, 2);
});

test("writeSnapshot: evicts entries older than the sliding TTL", () => {
  const storage = makeMockStorage();
  // Pre-seed with a 25-hour-old snapshot.
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-26T17:00:00Z`, JSON.stringify({ at: "old", cards: [] }));
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-26T15:00:00Z`, JSON.stringify({ at: "very old", cards: [] }));
  // And one entry inside the 24h window.
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-27T10:00:00Z`, JSON.stringify({ at: "kept", cards: [] }));

  const result = writeSnapshot(
    { at: "2026-05-27T18:00:00Z", cards: [] },
    { storage, now: frozenNow("2026-05-27T18:00:00Z") }
  );
  assert.equal(result.evicted, 2, "should have evicted the two >24h-old entries");
  const remaining = listSnapshotTimestamps({ storage });
  assert.ok(remaining.includes("2026-05-27T10:00:00Z"), "8h-old entry should be kept");
  assert.ok(remaining.includes("2026-05-27T18:00:00Z"), "new entry should be present");
  assert.ok(!remaining.includes("2026-05-26T17:00:00Z"), "25h-old entry should be evicted");
});

test("writeSnapshot: TTL is the published 24h value (SNAPSHOT_TTL_MS)", () => {
  // Locking the public constant so a future "let's bump to 48h"
  // change can't silently slip through.
  assert.equal(SNAPSHOT_TTL_MS, 24 * 60 * 60 * 1000);
});

// ── readSnapshot ────────────────────────────────────────────────────

test("readSnapshot: returns undefined for missing keys", () => {
  const storage = makeMockStorage();
  assert.equal(readSnapshot("nonexistent", { storage }), undefined);
});

test("readSnapshot: returns undefined for corrupt JSON", () => {
  const storage = makeMockStorage();
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}corrupt`, "{not json");
  assert.equal(readSnapshot("corrupt", { storage }), undefined);
});

// ── listSnapshotTimestamps ──────────────────────────────────────────

test("listSnapshotTimestamps: returns timestamps in ascending order", () => {
  const storage = makeMockStorage();
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-27T17:30:00Z`, "{}");
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-27T17:00:00Z`, "{}");
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-27T18:00:00Z`, "{}");
  const stamps = listSnapshotTimestamps({ storage });
  assert.deepEqual(stamps, [
    "2026-05-27T17:00:00Z",
    "2026-05-27T17:30:00Z",
    "2026-05-27T18:00:00Z",
  ]);
});

test("listSnapshotTimestamps: ignores keys without the monitor.snapshot. prefix", () => {
  const storage = makeMockStorage();
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-27T17:30:00Z`, "{}");
  storage.setItem("other.thing", "{}");
  storage.setItem("monitor.other", "{}");
  const stamps = listSnapshotTimestamps({ storage });
  assert.deepEqual(stamps, ["2026-05-27T17:30:00Z"]);
});

test("listSnapshotTimestamps: empty storage returns empty array", () => {
  assert.deepEqual(listSnapshotTimestamps({ storage: makeMockStorage() }), []);
});

// ── evictExpired ────────────────────────────────────────────────────

test("evictExpired: removes only entries older than the TTL", () => {
  const storage = makeMockStorage();
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-26T16:00:00Z`, "{}"); // 25h ago (evict)
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-27T16:00:00Z`, "{}"); // 1h ago (keep)
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-27T17:00:00Z`, "{}"); // 0h (keep)
  const evicted = evictExpired(storage, Date.parse("2026-05-27T17:00:00Z"), SNAPSHOT_TTL_MS);
  assert.equal(evicted, 1);
  assert.equal(storage.length, 2);
});

test("evictExpired: ignores entries with unparseable timestamps (defensive)", () => {
  const storage = makeMockStorage();
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}not-a-date`, "{}");
  const evicted = evictExpired(storage, Date.parse("2026-05-27T17:00:00Z"), SNAPSHOT_TTL_MS);
  assert.equal(evicted, 0);
  // The bad entry stays so a future fix could investigate it,
  // rather than silently dropping data we can't explain.
  assert.equal(storage.length, 1);
});

test("evictExpired: empty storage returns 0", () => {
  const evicted = evictExpired(makeMockStorage(), Date.now(), SNAPSHOT_TTL_MS);
  assert.equal(evicted, 0);
});

// ── Storage-quota fallback ──────────────────────────────────────────

test("writeSnapshot: handles QuotaExceededError gracefully (evicts and retries once)", () => {
  // Construct a storage mock that throws on setItem the first time
  // (simulating QuotaExceededError) but succeeds after eviction.
  let firstWriteFailed = false;
  const inner = makeMockStorage();
  const storage = {
    get length() { return inner.length; },
    key(i) { return inner.key(i); },
    getItem(k) { return inner.getItem(k); },
    setItem(k, v) {
      if (!firstWriteFailed && k.startsWith(SNAPSHOT_KEY_PREFIX) && !k.includes("expired")) {
        firstWriteFailed = true;
        throw new Error("QuotaExceededError");
      }
      inner.setItem(k, v);
    },
    removeItem(k) { inner.removeItem(k); },
  };
  // Pre-seed an expired entry so eviction has something to remove,
  // freeing space for the retry to succeed.
  storage.setItem(`${SNAPSHOT_KEY_PREFIX}2026-05-26T00:00:00Z-expired`, "{}");
  const result = writeSnapshot(
    { at: "2026-05-27T18:00:00Z", cards: [] },
    { storage, now: frozenNow("2026-05-27T18:00:00Z") }
  );
  // The retry succeeds; the new entry should be present.
  assert.equal(result.key, `${SNAPSHOT_KEY_PREFIX}2026-05-27T18:00:00Z`);
  assert.ok(readSnapshot("2026-05-27T18:00:00Z", { storage }));
});

test("writeSnapshot: never throws even when storage is fully broken (silent drop)", () => {
  const brokenStorage = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => { throw new Error("storage is dead"); },
    removeItem: () => undefined,
  };
  assert.doesNotThrow(() => {
    writeSnapshot({ at: "2026-05-27T18:00:00Z", cards: [] }, { storage: brokenStorage });
  });
});

// ── SSR-safe noop fallback ──────────────────────────────────────────

test("writeSnapshot: in a no-storage environment (SSR), silently drops the write", () => {
  // Simulate SSR: no globalThis.localStorage, no override passed.
  // The storage adapter resolves to noopStorage internally.
  const result = writeSnapshot(
    { at: "2026-05-27T18:00:00Z", cards: [] }
    // no opts.storage
  );
  // We can't observe noopStorage from outside; just assert it didn't throw.
  assert.equal(typeof result.key, "string");
});
