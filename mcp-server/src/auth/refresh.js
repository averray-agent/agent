/**
 * Opaque refresh-token store with strict-replay semantics.
 *
 * Phase 4b.5 per docs/PHASE_4B_KMS_JWT_PLAN.md §8. This module owns the
 * cryptographic + storage primitive used to bind short-lived (15 min)
 * access tokens to a long-lived (30 day) opaque refresh token, with
 * server-side rotation and replay-revokes-the-chain semantics.
 *
 * Design rationale: an opaque-token + server-side hash model is chosen
 * over a signed refresh JWT because refresh-token security depends on
 * **server-side revocation, rotation, replay detection, and chain
 * invalidation**. A self-contained signed token would not have the
 * HMAC "verifier can forge" problem, but it would still push us toward
 * offline validation and make replay-chain revocation harder than
 * necessary. Every refresh consultation goes through this store anyway,
 * so the JWT's stateless-verify property would be wasted.
 *
 * Threat model:
 *   - Vault or backend-env leak: an attacker cannot mint refresh tokens
 *     (they're CSPRNG-generated, the only copy is in the client's cookie
 *     and the server's hashed record). HMAC secret leak is irrelevant.
 *   - Refresh-token cookie theft via XSS or device compromise: the
 *     attacker can use the token ONCE. The legitimate client's next
 *     refresh (or the attacker's next refresh, if the legit client
 *     hasn't refreshed yet) triggers the replay-detection path that
 *     revokes the entire chain. User is forced to re-auth via SIWE.
 *   - Brute-force guess of a refresh token: 32 random bytes (256 bits)
 *     of entropy; uniformly infeasible.
 *
 * What this module does NOT do:
 *   - It does NOT mint access tokens (that's `signTokenFromConfig` in
 *     ./jwt.js — PR 4b.4's dispatcher).
 *   - It does NOT speak HTTP. The HTTP endpoint wiring + cookie
 *     handling lives in `mcp-server/src/protocols/http/server.js`
 *     (PR 4b.5b — separate follow-up).
 *   - It does NOT decide whether a wallet is currently authorized;
 *     callers pass an optional `recheck` callback for that.
 */

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Total length of the raw refresh token in bytes (before base64url).
 * 32 bytes = 256 bits of CSPRNG entropy. Encoded as base64url this is
 * 43 characters (no padding) — short enough to fit in a Set-Cookie
 * header comfortably, long enough that brute force is infeasible.
 */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * Default access-token TTL after a refresh. 15 min per design doc §8.
 * Callers may override per-call but should not exceed the configured
 * authConfig.maxTtlSeconds.
 */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Default refresh-token TTL. 30 days per design doc §8. Sliding —
 * each successful rotation issues a fresh refresh with this TTL.
 */
export const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 3600;

/**
 * Forensic window — how long a revoked-or-replaced record is retained
 * in the store past its `expiresAt`, for replay detection and audit.
 * 7 days per design doc §8 TTLs table.
 */
export const REVOCATION_GRACE_SECONDS = 7 * 24 * 3600;

/**
 * Cookie name used by the HTTP layer. Defined here so the HTTP layer
 * and tests share a single constant.
 */
export const REFRESH_COOKIE_NAME = "refresh_token";

/**
 * Maximum refresh-rotation chain length before we cap it. Prevents
 * unbounded `ancestorHashes` array growth if a client refreshes
 * pathologically often. 256 rotations is ~one per ~3 hours for 30 days
 * — far beyond any normal usage. If a chain exceeds this, the oldest
 * ancestor hashes are dropped from `ancestorHashes` (replay detection
 * still works for the most recent 256 ancestors; the dropped ones are
 * expired anyway).
 */
export const MAX_ANCESTOR_CHAIN_LENGTH = 256;

/**
 * Storage-key namespace inside the state store. Keyed by SHA-256 of the
 * raw token (hex-encoded).
 */
function recordKey(hash) {
  return `auth:refresh:${hash}`;
}

/**
 * Custom error thrown by the refresh service. `code` is a stable
 * machine-readable string the HTTP layer uses to shape error responses
 * and the audit log uses to categorize events.
 */
export class RefreshError extends Error {
  /**
   * @param {string} code  One of: `invalid_refresh_token`,
   *   `refresh_expired`, `refresh_revoked`, `refresh_replay_detected`,
   *   `role_revoked`, `store_failure`, `invalid_token_format`.
   * @param {object} [details]  Optional structured context. Never
   *   includes raw token material — only hash prefixes (first 8 chars)
   *   and wallet/role metadata.
   */
  constructor(code, details = {}) {
    super(`refresh: ${code}`);
    this.name = "RefreshError";
    this.code = code;
    this.details = details;
  }
}

/**
 * SHA-256 hex digest of a raw refresh token. The only form we ever
 * persist server-side.
 *
 * @param {string} rawToken  base64url-encoded refresh token from the client
 * @returns {string}  64-char lowercase hex hash
 */
export function hashRefreshToken(rawToken) {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    throw new RefreshError("invalid_token_format", { reason: "empty_or_non_string" });
  }
  // base64url uses [A-Za-z0-9_-], no padding. We don't strictly enforce
  // the character set because a leaked malformed token would simply
  // not match any stored hash — the hash lookup is the security boundary.
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Constant-time equality check between two hex hashes. Used when a
 * record lookup needs to confirm the hashes match (defense in depth
 * against any future storage layer that does case-insensitive or
 * fuzzy matching).
 *
 * @param {string} a  hex hash
 * @param {string} b  hex hash
 * @returns {boolean}
 */
export function hashesEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Generate a fresh refresh token. Returns the raw token (for the
 * Set-Cookie header) and its hash (for storage).
 *
 * @returns {{ rawToken: string, hash: string }}
 */
export function generateRefreshToken() {
  const bytes = randomBytes(REFRESH_TOKEN_BYTES);
  const rawToken = bytes.toString("base64url");
  const hash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  return { rawToken, hash };
}

/**
 * Truncated hash safe for logging. Never log the raw token; never log
 * the full hash either (a full hash leak combined with a future store
 * dump could speed up correlation). 8 hex chars = 32 bits, enough to
 * disambiguate audit log entries but not enough to do meaningful
 * brute-force.
 *
 * @param {string} hash  full hex hash
 * @returns {string}  e.g., `"a1b2c3d4…"`
 */
export function logHash(hash) {
  if (typeof hash !== "string" || hash.length < 8) return "(invalid)";
  return `${hash.slice(0, 8)}…`;
}

/**
 * Create a new refresh-token record and persist it.
 *
 * @param {object} opts
 * @param {string} opts.wallet  Canonical (lowercase H160) wallet address.
 * @param {string} opts.role  Role string from the auth config allowlist.
 * @param {RefreshTokenStore} opts.store  Storage adapter (Map-based in
 *   tests, Redis-backed in prod).
 * @param {number} [opts.now]  Override `Date.now()` for tests.
 * @param {number} [opts.ttlSeconds]  Override default 30-day TTL.
 * @param {string[]} [opts.ancestorHashes]  Carried forward by
 *   `rotateRefreshToken` to maintain the rotation chain.
 * @returns {Promise<{ rawToken: string, hash: string, record: RefreshRecord }>}
 */
export async function issueRefreshToken({
  wallet,
  role,
  store,
  now = Date.now(),
  ttlSeconds = DEFAULT_REFRESH_TTL_SECONDS,
  ancestorHashes = [],
}) {
  if (typeof wallet !== "string" || wallet.length === 0) {
    throw new RefreshError("invalid_token_format", { reason: "missing_wallet" });
  }
  if (typeof role !== "string" || role.length === 0) {
    throw new RefreshError("invalid_token_format", { reason: "missing_role" });
  }
  if (!store || typeof store.set !== "function" || typeof store.get !== "function") {
    throw new RefreshError("store_failure", { reason: "invalid_store_adapter" });
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new RefreshError("invalid_token_format", { reason: "invalid_ttl" });
  }

  const { rawToken, hash } = generateRefreshToken();
  const issuedAt = now;
  const expiresAt = now + ttlSeconds * 1000;

  // Cap ancestor chain length to prevent unbounded growth (see comment
  // on MAX_ANCESTOR_CHAIN_LENGTH).
  const cappedAncestors = ancestorHashes.length > MAX_ANCESTOR_CHAIN_LENGTH
    ? ancestorHashes.slice(-MAX_ANCESTOR_CHAIN_LENGTH)
    : [...ancestorHashes];

  /** @type {RefreshRecord} */
  const record = {
    wallet,
    role,
    issuedAt,
    expiresAt,
    replacedBy: null,
    revokedAt: null,
    ancestorHashes: cappedAncestors,
  };

  // TTL on the store key is (refresh TTL) + (forensic grace) so the
  // record survives past expiry for replay-detection lookups.
  const keyTtlSeconds = ttlSeconds + REVOCATION_GRACE_SECONDS;
  await store.set(recordKey(hash), record, keyTtlSeconds);

  return { rawToken, hash, record };
}

/**
 * Consume a refresh token. Validates the token is well-formed, looks
 * up the record, and applies the strict-replay semantics:
 *
 *   - If the record is missing → `invalid_refresh_token`
 *   - If the record is expired → `refresh_expired`
 *   - If the record is revoked → `refresh_revoked`
 *   - If the record was already replaced (replay) → REVOKE THE CHAIN
 *     (this record, its ancestors, its descendants) and throw
 *     `refresh_replay_detected` with `chainRevoked: true`
 *   - Otherwise → returns the record. The caller MUST then call
 *     `rotateRefreshToken` to finalize the rotation. This module does
 *     not auto-rotate because the caller may need to do additional
 *     checks (e.g., a role-recheck callback) before committing.
 *
 * @param {object} opts
 * @param {string} opts.rawToken  base64url-encoded raw refresh token
 *   from the client cookie.
 * @param {RefreshTokenStore} opts.store
 * @param {number} [opts.now]  Override `Date.now()` for tests.
 * @returns {Promise<{ record: RefreshRecord, hash: string }>}
 */
export async function consumeRefreshToken({ rawToken, store, now = Date.now() }) {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    throw new RefreshError("invalid_token_format", { reason: "empty_or_non_string" });
  }
  if (!store || typeof store.get !== "function" || typeof store.set !== "function") {
    throw new RefreshError("store_failure", { reason: "invalid_store_adapter" });
  }

  const hash = hashRefreshToken(rawToken);
  const record = await store.get(recordKey(hash));

  if (!record) {
    throw new RefreshError("invalid_refresh_token", { hashPrefix: logHash(hash) });
  }
  if (record.revokedAt) {
    throw new RefreshError("refresh_revoked", {
      hashPrefix: logHash(hash),
      revokedAt: record.revokedAt,
    });
  }
  if (record.expiresAt <= now) {
    throw new RefreshError("refresh_expired", {
      hashPrefix: logHash(hash),
      expiresAt: record.expiresAt,
    });
  }
  if (record.replacedBy) {
    // REPLAY DETECTED — this token was already rotated. Revoke the
    // entire chain (this token, its ancestors, its descendants).
    await revokeChain({
      hash,
      store,
      now,
      reason: "replay_detected",
    });
    throw new RefreshError("refresh_replay_detected", {
      hashPrefix: logHash(hash),
      wallet: record.wallet,
      chainRevoked: true,
    });
  }

  return { record, hash };
}

/**
 * Atomically rotate: mark the old record as replaced by the new one,
 * issue a fresh record for the new token. Must be called after a
 * successful `consumeRefreshToken`.
 *
 * Implementation note: the writes are not atomic in the
 * strictest sense (no multi-key transaction in the abstract store
 * adapter), but they're ordered:
 *
 *   1. Generate new token + insert new record
 *   2. Mark old record `replacedBy = newHash`
 *
 * Failure modes:
 *   - Step 1 fails: caller sees an error, no state change. Old token
 *     still consumable. Acceptable.
 *   - Step 1 succeeds, step 2 fails: new token exists in store but
 *     old token is NOT marked replaced. Next refresh from the OLD token
 *     would issue ANOTHER new token rather than detecting replay.
 *     This is the worst-case window: the old token effectively has a
 *     short period during which it can be used twice. We mitigate by
 *     keeping step 2 simple (a single store write) and accepting the
 *     residual risk; a fully transactional implementation requires
 *     Redis MULTI/EXEC support in the store adapter, which is a future
 *     improvement.
 *
 * @param {object} opts
 * @param {RefreshRecord} opts.oldRecord  From `consumeRefreshToken`.
 * @param {string} opts.oldHash  Hash of the old token (returned by consume).
 * @param {RefreshTokenStore} opts.store
 * @param {number} [opts.now]
 * @param {number} [opts.ttlSeconds]  Override default TTL on the new token.
 * @returns {Promise<{ rawToken: string, hash: string, record: RefreshRecord }>}
 */
export async function rotateRefreshToken({
  oldRecord,
  oldHash,
  store,
  now = Date.now(),
  ttlSeconds = DEFAULT_REFRESH_TTL_SECONDS,
}) {
  if (!oldRecord || typeof oldRecord !== "object") {
    throw new RefreshError("invalid_token_format", { reason: "missing_old_record" });
  }
  if (typeof oldHash !== "string" || oldHash.length !== 64) {
    throw new RefreshError("invalid_token_format", { reason: "invalid_old_hash" });
  }

  // Step 1: issue the new record (with the old hash appended to its
  // ancestor chain so future replay detection can revoke transitively).
  const newAncestors = [...(oldRecord.ancestorHashes ?? []), oldHash];
  const issued = await issueRefreshToken({
    wallet: oldRecord.wallet,
    role: oldRecord.role,
    store,
    now,
    ttlSeconds,
    ancestorHashes: newAncestors,
  });

  // Step 2: mark the old record as replaced (NOT revoked — replay
  // detection wants to distinguish "rotated normally" from "explicitly
  // revoked"). The key TTL keeps the record around for the forensic
  // window so replays can still be detected against it.
  const updatedOld = {
    ...oldRecord,
    replacedBy: issued.hash,
  };
  const remainingTtlMs = Math.max(0, oldRecord.expiresAt - now);
  const remainingTtlSeconds = Math.ceil(remainingTtlMs / 1000) + REVOCATION_GRACE_SECONDS;
  await store.set(recordKey(oldHash), updatedOld, remainingTtlSeconds);

  return issued;
}

/**
 * Revoke a refresh-token chain: this record, every ancestor, and every
 * descendant reachable via `replacedBy`. Sets `revokedAt = now` on each.
 * Idempotent — re-revoking an already-revoked record is a no-op.
 *
 * Walks the chain bounded by `MAX_ANCESTOR_CHAIN_LENGTH * 2` (ancestors
 * + descendants) to prevent pathological loops in a corrupted store.
 *
 * @param {object} opts
 * @param {string} opts.hash  Hash of a record in the chain (any node).
 * @param {RefreshTokenStore} opts.store
 * @param {number} [opts.now]
 * @param {string} [opts.reason]  Free-text reason for the audit log.
 * @returns {Promise<{ revokedHashes: string[] }>}
 */
export async function revokeChain({
  hash,
  store,
  now = Date.now(),
  reason = "manual_revoke",
}) {
  if (typeof hash !== "string" || hash.length !== 64) {
    throw new RefreshError("invalid_token_format", { reason: "invalid_hash_for_revoke" });
  }

  const record = await store.get(recordKey(hash));
  if (!record) {
    // Nothing to revoke — record may have already expired past the
    // forensic window. Returning empty is correct.
    return { revokedHashes: [] };
  }

  // Collect every hash in the chain.
  const chainHashes = new Set();
  chainHashes.add(hash);

  // Walk ancestors (already known from the record itself).
  for (const ancestor of record.ancestorHashes ?? []) {
    chainHashes.add(ancestor);
  }

  // Walk descendants forward via `replacedBy` pointers.
  let cursor = record.replacedBy;
  const maxWalk = MAX_ANCESTOR_CHAIN_LENGTH * 2;
  let walked = 0;
  while (cursor && walked < maxWalk) {
    if (chainHashes.has(cursor)) break; // cycle guard
    chainHashes.add(cursor);
    const next = await store.get(recordKey(cursor));
    if (!next) break;
    cursor = next.replacedBy;
    walked += 1;
  }

  // Revoke each.
  const revokedHashes = [];
  for (const h of chainHashes) {
    const r = await store.get(recordKey(h));
    if (!r) continue;
    if (r.revokedAt) continue; // already revoked — skip
    const updated = { ...r, revokedAt: now, revokeReason: reason };
    const remainingTtlMs = Math.max(0, r.expiresAt - now);
    const remainingTtlSeconds = Math.ceil(remainingTtlMs / 1000) + REVOCATION_GRACE_SECONDS;
    await store.set(recordKey(h), updated, remainingTtlSeconds);
    revokedHashes.push(h);
  }

  return { revokedHashes };
}

/**
 * @typedef {object} RefreshRecord
 * @property {string} wallet  Canonical lowercase H160.
 * @property {string} role  Role allowlist entry.
 * @property {number} issuedAt  Unix ms.
 * @property {number} expiresAt  Unix ms.
 * @property {string|null} replacedBy  Hash of the rotation successor,
 *   or `null` if not yet rotated.
 * @property {number|null} revokedAt  Unix ms, or `null` if not revoked.
 * @property {string[]} ancestorHashes  Forward-walkable replay-detection
 *   chain — every ancestor (rotation predecessor) of this record.
 * @property {string} [revokeReason]  Free-text audit reason set by
 *   `revokeChain`.
 */

/**
 * @typedef {object} RefreshTokenStore
 * @property {(key: string) => Promise<RefreshRecord | null | undefined>} get
 * @property {(key: string, value: RefreshRecord, ttlSeconds: number) => Promise<void>} set
 */
