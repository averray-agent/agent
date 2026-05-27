/**
 * Hermes Handoff Monitor — localStorage snapshot writer.
 *
 * Records timestamped board snapshots so a future time-travel UI
 * (v1.1) can page back through "what did the board look like at
 * 14:30?" without a server round-trip.
 *
 * Per §21 decision #4 of docs/HERMES_MONITOR_REDESIGN_SPEC.md:
 *   - Storage: localStorage
 *   - Key shape: `monitor.snapshot.<isoTimestamp>`
 *   - TTL: 24h sliding window (oldest entries evicted on each write)
 *   - No UI surfaces this in v1; M4 only writes, v1.1 reads.
 *
 * Pure functions — no React. The page wires the writer to fire on
 * every successful SWR / SSE refresh.
 */

const KEY_PREFIX = "monitor.snapshot.";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * @typedef {Object} StorageLike
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 * @property {number} length
 * @property {(index: number) => string | null} key
 */

/**
 * Resolve the storage interface. Browsers expose `window.localStorage`;
 * tests inject a Map-backed mock; SSR / no-storage environments get
 * a noop that silently drops writes.
 *
 * @param {StorageLike} [override]
 * @returns {StorageLike}
 */
function resolveStorage(override) {
  if (override) return override;
  if (typeof globalThis !== "undefined" && globalThis.localStorage) {
    return /** @type {StorageLike} */ (globalThis.localStorage);
  }
  return noopStorage();
}

function noopStorage() {
  return {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    length: 0,
    key: () => null,
  };
}

/**
 * Write a snapshot to storage and evict any entries older than the
 * sliding TTL.
 *
 * @param {{ at: string, cards: unknown[] }} snapshot
 * @param {{ storage?: StorageLike, now?: () => number, ttlMs?: number }} [opts]
 * @returns {{ key: string, evicted: number }}
 */
export function writeSnapshot(snapshot, opts = {}) {
  const storage = resolveStorage(opts.storage);
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? TTL_MS;

  const key = `${KEY_PREFIX}${snapshot.at}`;
  try {
    storage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // Storage quota exceeded / disabled / private-mode. Evict
    // aggressively and try once more before giving up silently.
    evictExpired(storage, now(), ttlMs);
    try {
      storage.setItem(key, JSON.stringify(snapshot));
    } catch {
      return { key, evicted: 0 };
    }
  }

  const evicted = evictExpired(storage, now(), ttlMs);
  return { key, evicted };
}

/**
 * List every snapshot key currently in storage, sorted oldest →
 * newest. Useful for the future time-travel UI.
 *
 * @param {{ storage?: StorageLike }} [opts]
 * @returns {string[]} the timestamp portion of each key (the `at`
 *   field of the stored snapshot)
 */
export function listSnapshotTimestamps(opts = {}) {
  const storage = resolveStorage(opts.storage);
  const stamps = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (typeof k === "string" && k.startsWith(KEY_PREFIX)) {
      stamps.push(k.slice(KEY_PREFIX.length));
    }
  }
  stamps.sort();
  return stamps;
}

/**
 * Read a single snapshot by its `at` timestamp, or undefined if
 * absent / corrupt.
 *
 * @param {string} at  ISO timestamp matching a previously-written snapshot
 * @param {{ storage?: StorageLike }} [opts]
 * @returns {{ at: string, cards: unknown[] } | undefined}
 */
export function readSnapshot(at, opts = {}) {
  const storage = resolveStorage(opts.storage);
  const raw = storage.getItem(`${KEY_PREFIX}${at}`);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Evict every snapshot older than now - ttl. Called automatically
 * by writeSnapshot but exposed for explicit cleanup (e.g. on
 * sign-out).
 *
 * @param {StorageLike} storage
 * @param {number} nowMs
 * @param {number} ttlMs
 * @returns {number} number of keys evicted
 */
export function evictExpired(storage, nowMs, ttlMs) {
  // Collect candidates first; mutating during iteration is brittle.
  const candidates = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (typeof k === "string" && k.startsWith(KEY_PREFIX)) {
      const iso = k.slice(KEY_PREFIX.length);
      const ts = Date.parse(iso);
      if (Number.isFinite(ts) && nowMs - ts > ttlMs) {
        candidates.push(k);
      }
    }
  }
  for (const k of candidates) {
    try {
      storage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  return candidates.length;
}

export const SNAPSHOT_KEY_PREFIX = KEY_PREFIX;
export const SNAPSHOT_TTL_MS = TTL_MS;
