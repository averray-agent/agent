import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REFRESH_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_BYTES,
  REVOCATION_GRACE_SECONDS,
  RefreshError,
  consumeRefreshToken,
  generateRefreshToken,
  hashRefreshToken,
  hashesEqual,
  issueRefreshToken,
  logHash,
  revokeChain,
  rotateRefreshToken,
} from "./refresh.js";

/**
 * In-memory store adapter matching the `RefreshTokenStore` shape used
 * by the refresh module. Stores values verbatim (no clone), tracks TTL
 * for assertion purposes, and exposes diagnostic helpers.
 */
function makeMemoryStore({ now = () => Date.now() } = {}) {
  const data = new Map();
  return {
    data,
    async get(key) {
      const entry = data.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs <= now()) {
        data.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      assert.ok(
        Number.isFinite(ttlSeconds) && ttlSeconds > 0,
        "store.set requires a positive ttlSeconds",
      );
      data.set(key, {
        value,
        expiresAtMs: now() + ttlSeconds * 1000,
        ttlSecondsAtWrite: ttlSeconds,
      });
    },
    /** Inspect the raw entry (value + TTL bookkeeping). */
    raw(key) {
      return data.get(key);
    },
    /** Test-only: count records under the refresh namespace. */
    refreshKeyCount() {
      let n = 0;
      for (const k of data.keys()) if (k.startsWith("auth:refresh:")) n += 1;
      return n;
    },
  };
}

const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("generateRefreshToken: 32-byte CSPRNG, base64url-encoded", () => {
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) {
    const { rawToken, hash } = generateRefreshToken();
    // base64url of 32 bytes is 43 chars (no padding)
    assert.equal(rawToken.length, 43, `iteration ${i}: raw length`);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(rawToken), "base64url charset");
    assert.equal(hash.length, 64, "sha256 hex length");
    assert.ok(/^[0-9a-f]+$/.test(hash), "hex charset");
    assert.ok(!seen.has(rawToken), "tokens must be unique across calls");
    seen.add(rawToken);
  }
});

test("hashRefreshToken: deterministic, matches generateRefreshToken's hash", () => {
  const { rawToken, hash } = generateRefreshToken();
  assert.equal(hashRefreshToken(rawToken), hash);
  // Repeating should yield the same value (no salt — the input itself is
  // the entropy source).
  assert.equal(hashRefreshToken(rawToken), hash);
});

test("hashRefreshToken: rejects empty / non-string", () => {
  assert.throws(() => hashRefreshToken(""), /invalid_token_format/);
  assert.throws(() => hashRefreshToken(null), /invalid_token_format/);
  assert.throws(() => hashRefreshToken(undefined), /invalid_token_format/);
  assert.throws(() => hashRefreshToken(42), /invalid_token_format/);
});

test("hashesEqual: timing-safe, length-strict", () => {
  const a = "a".repeat(64);
  const b = "a".repeat(64);
  const c = "a".repeat(63) + "b";
  const d = "a".repeat(63);
  assert.equal(hashesEqual(a, b), true);
  assert.equal(hashesEqual(a, c), false);
  assert.equal(hashesEqual(a, d), false); // length mismatch
  assert.equal(hashesEqual(null, a), false);
  assert.equal(hashesEqual(a, null), false);
});

test("logHash: redacts to 8 hex chars + ellipsis", () => {
  assert.equal(logHash("0123456789abcdef".repeat(4)), "01234567…");
  assert.equal(logHash("short"), "(invalid)");
  assert.equal(logHash(null), "(invalid)");
});

test("issueRefreshToken: creates a record with the expected shape + TTL", async () => {
  const now = 1_700_000_000_000;
  const store = makeMemoryStore({ now: () => now });
  const { rawToken, hash, record } = await issueRefreshToken({
    wallet: WALLET_A,
    role: "admin",
    store,
    now,
  });

  assert.equal(rawToken.length, 43);
  assert.equal(hash.length, 64);
  assert.deepEqual(record, {
    wallet: WALLET_A,
    role: "admin",
    issuedAt: now,
    expiresAt: now + DEFAULT_REFRESH_TTL_SECONDS * 1000,
    replacedBy: null,
    revokedAt: null,
    ancestorHashes: [],
  });

  // TTL on the store key is refresh TTL + forensic grace.
  const rawEntry = store.raw(`auth:refresh:${hash}`);
  assert.equal(rawEntry.ttlSecondsAtWrite, DEFAULT_REFRESH_TTL_SECONDS + REVOCATION_GRACE_SECONDS);
});

test("issueRefreshToken: raw token is NOT stored — only hash and metadata", async () => {
  const store = makeMemoryStore();
  const { rawToken, hash, record } = await issueRefreshToken({
    wallet: WALLET_A,
    role: "admin",
    store,
  });
  // No store entry should contain the rawToken anywhere in its value.
  for (const [key, entry] of store.data) {
    assert.ok(!key.includes(rawToken), `key ${key} contains raw token`);
    const serialized = JSON.stringify(entry.value);
    assert.ok(!serialized.includes(rawToken), `value at ${key} contains raw token`);
  }
  // The hash IS in the storage key, which is fine (hashes are not secrets).
  assert.ok(store.data.has(`auth:refresh:${hash}`));
  // Record sanity.
  assert.equal(record.wallet, WALLET_A);
});

test("issueRefreshToken: rejects missing wallet/role/store", async () => {
  await assert.rejects(
    () => issueRefreshToken({ wallet: "", role: "admin", store: makeMemoryStore() }),
    (err) =>
      err instanceof RefreshError &&
      err.code === "invalid_token_format" &&
      err.details.reason === "missing_wallet",
  );
  await assert.rejects(
    () => issueRefreshToken({ wallet: WALLET_A, role: "", store: makeMemoryStore() }),
    (err) =>
      err instanceof RefreshError &&
      err.code === "invalid_token_format" &&
      err.details.reason === "missing_role",
  );
  await assert.rejects(
    () => issueRefreshToken({ wallet: WALLET_A, role: "admin", store: null }),
    (err) =>
      err instanceof RefreshError &&
      err.code === "store_failure" &&
      err.details.reason === "invalid_store_adapter",
  );
});

test("consumeRefreshToken: happy path returns the record", async () => {
  const store = makeMemoryStore();
  const { rawToken, hash, record } = await issueRefreshToken({
    wallet: WALLET_A,
    role: "admin",
    store,
  });
  const consumed = await consumeRefreshToken({ rawToken, store });
  assert.deepEqual(consumed.record, record);
  assert.equal(consumed.hash, hash);
});

test("consumeRefreshToken: unknown token → invalid_refresh_token", async () => {
  const store = makeMemoryStore();
  const { rawToken } = generateRefreshToken();
  await assert.rejects(
    () => consumeRefreshToken({ rawToken, store }),
    (err) => err instanceof RefreshError && err.code === "invalid_refresh_token",
  );
});

test("consumeRefreshToken: expired → refresh_expired (does not auto-revoke)", async () => {
  let now = 1_700_000_000_000;
  const store = makeMemoryStore({ now: () => now });
  const { rawToken } = await issueRefreshToken({
    wallet: WALLET_A,
    role: "admin",
    store,
    now,
    ttlSeconds: 60,
  });
  now += 61_000; // jump past expiry
  // Note: with TTL=60+REVOCATION_GRACE, the store entry is still alive;
  // we want consume to see "expired" specifically (not "missing"), so
  // the store should still hold the record. Stub store has stricter
  // TTL — manually re-fetch.
  // For this test, use a store that ignores its own TTL so we can prove
  // consume's expiresAt check fires:
  const persistentStore = {
    ...store,
    async get(key) {
      const entry = store.data.get(key);
      if (!entry) return null;
      return entry.value;
    },
  };
  await assert.rejects(
    () => consumeRefreshToken({ rawToken, store: persistentStore, now }),
    (err) => err instanceof RefreshError && err.code === "refresh_expired",
  );
});

test("consumeRefreshToken: revoked → refresh_revoked", async () => {
  const store = makeMemoryStore();
  const { rawToken, hash } = await issueRefreshToken({
    wallet: WALLET_A,
    role: "admin",
    store,
  });
  await revokeChain({ hash, store });
  await assert.rejects(
    () => consumeRefreshToken({ rawToken, store }),
    (err) => err instanceof RefreshError && err.code === "refresh_revoked",
  );
});

test("rotateRefreshToken: happy path issues a new token in the same chain", async () => {
  const store = makeMemoryStore();
  const { rawToken: t1, hash: h1 } = await issueRefreshToken({
    wallet: WALLET_A,
    role: "admin",
    store,
  });
  const { record } = await consumeRefreshToken({ rawToken: t1, store });
  const rotated = await rotateRefreshToken({ oldRecord: record, oldHash: h1, store });

  assert.notEqual(rotated.rawToken, t1, "new raw token must differ");
  assert.notEqual(rotated.hash, h1, "new hash must differ");
  assert.deepEqual(rotated.record.ancestorHashes, [h1]);
  assert.equal(rotated.record.wallet, WALLET_A);
  assert.equal(rotated.record.role, "admin");
  assert.equal(rotated.record.replacedBy, null);

  // Old record is now marked replaced.
  const oldEntry = store.raw(`auth:refresh:${h1}`);
  assert.equal(oldEntry.value.replacedBy, rotated.hash);
  assert.equal(oldEntry.value.revokedAt, null, "old record is replaced, not revoked");
});

test("strict replay: re-presenting an already-rotated token revokes the entire chain", async () => {
  const store = makeMemoryStore();
  const { rawToken: t1, hash: h1 } = await issueRefreshToken({
    wallet: WALLET_A,
    role: "admin",
    store,
  });
  // Normal rotation: t1 → t2
  const consumed1 = await consumeRefreshToken({ rawToken: t1, store });
  const rotated = await rotateRefreshToken({
    oldRecord: consumed1.record,
    oldHash: h1,
    store,
  });

  // Now attempt to re-use t1 (replay).
  await assert.rejects(
    () => consumeRefreshToken({ rawToken: t1, store }),
    (err) =>
      err instanceof RefreshError &&
      err.code === "refresh_replay_detected" &&
      err.details.chainRevoked === true,
  );

  // Both t1 AND t2 must now be revoked.
  const e1 = store.raw(`auth:refresh:${h1}`);
  const e2 = store.raw(`auth:refresh:${rotated.hash}`);
  assert.ok(e1.value.revokedAt, "t1 should be revoked after replay detection");
  assert.ok(e2.value.revokedAt, "t2 (descendant of t1) should also be revoked");
});

test("strict replay across a deep chain: t1→t2→t3→t4, replay t2 → all four revoked", async () => {
  const store = makeMemoryStore();
  const wallet = WALLET_A;
  const role = "admin";

  // Issue and rotate three times.
  const { rawToken: t1, hash: h1 } = await issueRefreshToken({ wallet, role, store });

  const c1 = await consumeRefreshToken({ rawToken: t1, store });
  const r2 = await rotateRefreshToken({ oldRecord: c1.record, oldHash: h1, store });

  const c2 = await consumeRefreshToken({ rawToken: r2.rawToken, store });
  const r3 = await rotateRefreshToken({ oldRecord: c2.record, oldHash: r2.hash, store });

  const c3 = await consumeRefreshToken({ rawToken: r3.rawToken, store });
  const r4 = await rotateRefreshToken({ oldRecord: c3.record, oldHash: r3.hash, store });

  // Now an attacker replays t2.
  await assert.rejects(
    () => consumeRefreshToken({ rawToken: r2.rawToken, store }),
    (err) => err instanceof RefreshError && err.code === "refresh_replay_detected",
  );

  // ALL FOUR must be revoked.
  for (const [label, hash] of [
    ["t1", h1],
    ["t2", r2.hash],
    ["t3", r3.hash],
    ["t4", r4.hash],
  ]) {
    const entry = store.raw(`auth:refresh:${hash}`);
    assert.ok(entry?.value?.revokedAt, `${label} should be revoked but was not`);
  }
});

test("refresh chain preserves wallet/role even after many rotations", async () => {
  const store = makeMemoryStore();
  let token = await issueRefreshToken({ wallet: WALLET_A, role: "verifier", store });
  for (let i = 0; i < 5; i += 1) {
    const consumed = await consumeRefreshToken({ rawToken: token.rawToken, store });
    token = await rotateRefreshToken({
      oldRecord: consumed.record,
      oldHash: consumed.hash,
      store,
    });
    assert.equal(token.record.wallet, WALLET_A);
    assert.equal(token.record.role, "verifier");
  }
  assert.equal(token.record.ancestorHashes.length, 5, "should have 5 ancestors after 5 rotations");
});

test("revokeChain: idempotent — revoking an already-revoked record is a no-op", async () => {
  const store = makeMemoryStore();
  const { hash } = await issueRefreshToken({ wallet: WALLET_A, role: "admin", store });
  const r1 = await revokeChain({ hash, store });
  assert.equal(r1.revokedHashes.length, 1);
  const r2 = await revokeChain({ hash, store });
  assert.equal(r2.revokedHashes.length, 0, "second revoke must be a no-op");
});

test("revokeChain: missing record returns empty (not an error)", async () => {
  const store = makeMemoryStore();
  const fakeHash = "0".repeat(64);
  const result = await revokeChain({ hash: fakeHash, store });
  assert.deepEqual(result.revokedHashes, []);
});

test("revokeChain: walks ancestors AND descendants from any node in the chain", async () => {
  const store = makeMemoryStore();
  const t1 = await issueRefreshToken({ wallet: WALLET_A, role: "admin", store });
  const c1 = await consumeRefreshToken({ rawToken: t1.rawToken, store });
  const t2 = await rotateRefreshToken({ oldRecord: c1.record, oldHash: t1.hash, store });
  const c2 = await consumeRefreshToken({ rawToken: t2.rawToken, store });
  const t3 = await rotateRefreshToken({ oldRecord: c2.record, oldHash: t2.hash, store });

  // Revoke starting from the middle node.
  const result = await revokeChain({ hash: t2.hash, store });
  // Should revoke t1 (ancestor), t2 (self), t3 (descendant).
  const revoked = new Set(result.revokedHashes);
  assert.ok(revoked.has(t1.hash), "ancestor t1 should be in revokedHashes");
  assert.ok(revoked.has(t2.hash), "self t2 should be in revokedHashes");
  assert.ok(revoked.has(t3.hash), "descendant t3 should be in revokedHashes");
  assert.equal(revoked.size, 3);
});

test("cross-wallet refresh: record wallet is preserved through rotation (no leakage)", async () => {
  // Adversary scenario: two independent users have independent refresh
  // chains; rotating one must NEVER touch the other.
  const store = makeMemoryStore();
  const userA = await issueRefreshToken({ wallet: WALLET_A, role: "admin", store });
  const userB = await issueRefreshToken({ wallet: WALLET_B, role: "verifier", store });

  // Rotate userA — userB's record must be untouched.
  const consumedA = await consumeRefreshToken({ rawToken: userA.rawToken, store });
  const rotatedA = await rotateRefreshToken({
    oldRecord: consumedA.record,
    oldHash: userA.hash,
    store,
  });

  const userBEntry = store.raw(`auth:refresh:${userB.hash}`);
  assert.equal(userBEntry.value.replacedBy, null, "userB unaffected");
  assert.equal(userBEntry.value.revokedAt, null, "userB unaffected");
  assert.equal(userBEntry.value.wallet, WALLET_B);

  // And rotated A's record still has WALLET_A, not WALLET_B.
  assert.equal(rotatedA.record.wallet, WALLET_A);
});

test("hashes are deterministic but raw tokens are unique (high entropy)", () => {
  // Already covered above, but assert at the API contract level: hashing
  // the same input twice yields the same output (idempotence of the
  // store-lookup primitive).
  const { rawToken, hash: hashA } = generateRefreshToken();
  const hashB = hashRefreshToken(rawToken);
  assert.equal(hashA, hashB);
});

test("constants match design doc §8 TTLs table", () => {
  assert.equal(REFRESH_TOKEN_BYTES, 32, "32-byte CSPRNG per §8 'Refresh-token hashing'");
  assert.equal(DEFAULT_REFRESH_TTL_SECONDS, 30 * 24 * 3600, "30-day refresh TTL per §8 TTLs table");
  assert.equal(REVOCATION_GRACE_SECONDS, 7 * 24 * 3600, "7-day forensic window per §8 TTLs table");
  assert.equal(REFRESH_COOKIE_NAME, "refresh_token", "stable cookie name for HTTP layer");
});
