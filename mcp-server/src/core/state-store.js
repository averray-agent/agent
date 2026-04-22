import { createClient } from "redis";
import { ExternalServiceError } from "./errors.js";

const RELEASE_CLAIM_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const CONSUME_NONCE_SCRIPT = `
local value = redis.call("get", KEYS[1])
if value then
  redis.call("del", KEYS[1])
end
return value
`;

// Fixed-window rate limit: INCR the counter, set TTL on first hit so the
// window closes cleanly, then return both count and remaining TTL so the
// caller can compute reset-at. Returned as a two-element array {count, ttl}.
const RATE_LIMIT_SCRIPT = `
local current = redis.call("incr", KEYS[1])
if current == 1 then
  redis.call("pexpire", KEYS[1], ARGV[1])
end
local ttl = redis.call("pttl", KEYS[1])
return {current, ttl}
`;

export class MemoryStateStore {
  constructor() {
    this.sessions = new Map();
    this.idempotency = new Map();
    this.jobSessions = new Map();
    this.chainJobSessions = new Map();
    this.jobSessionHistory = new Map();
    this.walletSessions = new Map();
    this.recentSessionIds = [];
    this.verificationResults = new Map();
    this.claimLocks = new Map();
    this.nonces = new Map();
    this.rateLimits = new Map();
    this.mutationReceipts = new Map();
    this.xcmObservations = new Map();
    this.serviceStates = new Map();
  }

  async getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  async upsertSession(session) {
    const persistedSession = {
      ...session,
      updatedAt: new Date().toISOString()
    };

    this.sessions.set(persistedSession.sessionId, persistedSession);
    this.idempotency.set(persistedSession.idempotencyKey, persistedSession.sessionId);
    this.jobSessions.set(persistedSession.jobId, persistedSession.sessionId);
    if (persistedSession.chainJobId) {
      this.chainJobSessions.set(persistedSession.chainJobId, persistedSession.sessionId);
    }

    const existingJobHistory = this.jobSessionHistory.get(persistedSession.jobId) ?? [];
    this.jobSessionHistory.set(
      persistedSession.jobId,
      [persistedSession.sessionId, ...existingJobHistory.filter((sessionId) => sessionId !== persistedSession.sessionId)]
    );

    const existing = this.walletSessions.get(persistedSession.wallet) ?? [];
    this.walletSessions.set(
      persistedSession.wallet,
      [persistedSession.sessionId, ...existing.filter((sessionId) => sessionId !== persistedSession.sessionId)]
    );
    this.recentSessionIds = [
      persistedSession.sessionId,
      ...this.recentSessionIds.filter((sessionId) => sessionId !== persistedSession.sessionId)
    ];

    return persistedSession;
  }

  async findSessionByIdempotencyKey(idempotencyKey) {
    const sessionId = this.idempotency.get(idempotencyKey);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  async findSessionByJobId(jobId) {
    const sessionId = this.jobSessions.get(jobId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  async findSessionByChainJobId(chainJobId) {
    const sessionId = this.chainJobSessions.get(chainJobId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  async getVerificationResult(sessionId) {
    return this.verificationResults.get(sessionId);
  }

  async upsertVerificationResult(sessionId, result) {
    this.verificationResults.set(sessionId, result);
    return result;
  }

  async listSessionsByWallet(wallet, limit = 10, offset = 0) {
    const sessionIds = (this.walletSessions.get(wallet) ?? []).slice(offset, offset + limit);
    return sessionIds.map((sessionId) => this.sessions.get(sessionId)).filter(Boolean);
  }

  async listSessionsByJob(jobId, limit = 10, offset = 0) {
    const sessionIds = (this.jobSessionHistory.get(jobId) ?? []).slice(offset, offset + limit);
    return sessionIds.map((sessionId) => this.sessions.get(sessionId)).filter(Boolean);
  }

  async listRecentSessions(limit = 10, offset = 0) {
    const sessionIds = this.recentSessionIds.slice(offset, offset + limit);
    return sessionIds.map((sessionId) => this.sessions.get(sessionId)).filter(Boolean);
  }

  async acquireClaimLock(lockId, owner, ttlSeconds = 30) {
    const now = Date.now();
    const existing = this.claimLocks.get(lockId);
    if (existing && existing.expiresAt > now && existing.owner !== owner) {
      return false;
    }

    this.claimLocks.set(lockId, {
      owner,
      expiresAt: now + (ttlSeconds * 1000)
    });
    return true;
  }

  async releaseClaimLock(lockId, owner) {
    const existing = this.claimLocks.get(lockId);
    if (existing?.owner === owner) {
      this.claimLocks.delete(lockId);
    }
  }

  async storeNonce(nonce, wallet, ttlSeconds = 300) {
    this._evictExpiredNonces();
    if (this.nonces.has(nonce)) {
      return false;
    }
    this.nonces.set(nonce, {
      wallet,
      expiresAt: Date.now() + (ttlSeconds * 1000)
    });
    return true;
  }

  async consumeNonce(nonce) {
    this._evictExpiredNonces();
    const entry = this.nonces.get(nonce);
    if (!entry) {
      return undefined;
    }
    this.nonces.delete(nonce);
    return entry.wallet;
  }

  _evictExpiredNonces() {
    const now = Date.now();
    for (const [nonce, entry] of this.nonces) {
      if (entry.expiresAt <= now) {
        this.nonces.delete(nonce);
      }
    }
  }

  async consumeRateLimit(bucket, key, { limit, windowSeconds }) {
    const mapKey = `${bucket}:${key}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const entry = this.rateLimits.get(mapKey);
    if (!entry || entry.resetAt <= now) {
      const resetAt = now + windowMs;
      this.rateLimits.set(mapKey, { count: 1, resetAt });
      return { allowed: 1 <= limit, count: 1, limit, remaining: Math.max(limit - 1, 0), resetAt };
    }
    entry.count += 1;
    this.rateLimits.set(mapKey, entry);
    return {
      allowed: entry.count <= limit,
      count: entry.count,
      limit,
      remaining: Math.max(limit - entry.count, 0),
      resetAt: entry.resetAt
    };
  }

  async getMutationReceipt(bucket, key) {
    return this.mutationReceipts.get(`${bucket}:${key}`);
  }

  async upsertMutationReceipt(bucket, key, receipt) {
    this.mutationReceipts.set(`${bucket}:${key}`, receipt);
    return receipt;
  }

  async getXcmObservation(requestId) {
    return this.xcmObservations.get(requestId);
  }

  async upsertXcmObservation(observation) {
    const existing = this.xcmObservations.get(observation.requestId) ?? {};
    const merged = {
      ...existing,
      ...observation,
      observedAt: observation.observedAt ?? existing.observedAt ?? new Date().toISOString(),
      processed: Boolean(observation.processed ?? existing.processed),
      attemptCount: Number(observation.attemptCount ?? existing.attemptCount ?? 0)
    };
    this.xcmObservations.set(observation.requestId, merged);
    return merged;
  }

  async listPendingXcmObservations(limit = 50) {
    return [...this.xcmObservations.values()]
      .filter((entry) => !entry.processed)
      .sort((left, right) => String(left.observedAt ?? "").localeCompare(String(right.observedAt ?? "")))
      .slice(0, Math.max(limit, 0));
  }

  async markXcmObservationProcessed(requestId, result = undefined) {
    const current = this.xcmObservations.get(requestId);
    if (!current) return undefined;
    const updated = {
      ...current,
      processed: true,
      processedAt: new Date().toISOString(),
      result,
      lastError: undefined
    };
    this.xcmObservations.set(requestId, updated);
    return updated;
  }

  async markXcmObservationFailed(requestId, error) {
    const current = this.xcmObservations.get(requestId);
    if (!current) return undefined;
    const updated = {
      ...current,
      processed: false,
      attemptCount: Number(current.attemptCount ?? 0) + 1,
      lastError: error?.message ?? String(error ?? "unknown_error"),
      lastTriedAt: new Date().toISOString()
    };
    this.xcmObservations.set(requestId, updated);
    return updated;
  }

  async getServiceState(scope) {
    return this.serviceStates.get(scope);
  }

  async upsertServiceState(scope, state) {
    const existing = this.serviceStates.get(scope) ?? {};
    const merged = {
      ...existing,
      ...state,
      updatedAt: new Date().toISOString()
    };
    this.serviceStates.set(scope, merged);
    return merged;
  }

  async revokeToken(jti, ttlSeconds) {
    if (!this.revokedTokens) {
      this.revokedTokens = new Map();
    }
    // Memory backend honours sub-second TTLs so tests can exercise expiry
    // quickly; the Redis backend ceils to whole seconds because Redis `EX`
    // only accepts integer seconds.
    const expiresAt = Date.now() + Math.max(0, ttlSeconds) * 1000;
    this.revokedTokens.set(jti, expiresAt);
  }

  async isTokenRevoked(jti) {
    if (!this.revokedTokens) return false;
    const expiresAt = this.revokedTokens.get(jti);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.revokedTokens.delete(jti);
      return false;
    }
    return true;
  }

  async healthCheck() {
    return {
      ok: true,
      backend: "memory",
      mode: "ephemeral"
    };
  }
}

export class RedisStateStore {
  constructor(redisUrl, namespace = "agent-platform") {
    this.redisUrl = redisUrl;
    this.namespace = namespace;
    this.client = createClient({ url: redisUrl });
    this.connectionPromise = undefined;
  }

  async getSession(sessionId) {
    await this.connect();
    const raw = await this.client.get(this.key("session", sessionId));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertSession(session) {
    await this.connect();
    const persistedSession = {
      ...session,
      updatedAt: new Date().toISOString()
    };
    await this.client.set(this.key("session", persistedSession.sessionId), JSON.stringify(persistedSession));
    await this.client.set(this.key("idempotency", persistedSession.idempotencyKey), persistedSession.sessionId);
    await this.client.set(this.key("job", persistedSession.jobId), persistedSession.sessionId);
    if (persistedSession.chainJobId) {
      await this.client.set(this.key("chain-job", persistedSession.chainJobId), persistedSession.sessionId);
    }
    await this.client.zAdd(this.key("job-sessions", persistedSession.jobId), {
      score: Date.now(),
      value: persistedSession.sessionId
    });
    await this.client.zAdd(this.key("wallet-sessions", persistedSession.wallet), {
      score: Date.now(),
      value: persistedSession.sessionId
    });
    await this.client.zAdd(this.key("sessions", "recent"), {
      score: Date.now(),
      value: persistedSession.sessionId
    });
    return persistedSession;
  }

  async findSessionByIdempotencyKey(idempotencyKey) {
    await this.connect();
    const sessionId = await this.client.get(this.key("idempotency", idempotencyKey));
    return sessionId ? this.getSession(sessionId) : undefined;
  }

  async findSessionByJobId(jobId) {
    await this.connect();
    const sessionId = await this.client.get(this.key("job", jobId));
    return sessionId ? this.getSession(sessionId) : undefined;
  }

  async findSessionByChainJobId(chainJobId) {
    await this.connect();
    const sessionId = await this.client.get(this.key("chain-job", chainJobId));
    return sessionId ? this.getSession(sessionId) : undefined;
  }

  async getVerificationResult(sessionId) {
    await this.connect();
    const raw = await this.client.get(this.key("verification", sessionId));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertVerificationResult(sessionId, result) {
    await this.connect();
    await this.client.set(this.key("verification", sessionId), JSON.stringify(result));
    return result;
  }

  async listSessionsByWallet(wallet, limit = 10, offset = 0) {
    await this.connect();
    const start = Math.max(offset, 0);
    const stop = start + Math.max(limit - 1, 0);
    const sessionIds = await this.client.zRange(this.key("wallet-sessions", wallet), start, stop, {
      REV: true
    });
    const sessions = await Promise.all(sessionIds.map((sessionId) => this.getSession(sessionId)));
    return sessions.filter(Boolean);
  }

  async listSessionsByJob(jobId, limit = 10, offset = 0) {
    await this.connect();
    const start = Math.max(offset, 0);
    const stop = start + Math.max(limit - 1, 0);
    const sessionIds = await this.client.zRange(this.key("job-sessions", jobId), start, stop, {
      REV: true
    });
    const sessions = await Promise.all(sessionIds.map((sessionId) => this.getSession(sessionId)));
    return sessions.filter(Boolean);
  }

  async listRecentSessions(limit = 10, offset = 0) {
    await this.connect();
    const start = Math.max(offset, 0);
    const stop = start + Math.max(limit - 1, 0);
    const sessionIds = await this.client.zRange(this.key("sessions", "recent"), start, stop, {
      REV: true
    });
    const sessions = await Promise.all(sessionIds.map((sessionId) => this.getSession(sessionId)));
    return sessions.filter(Boolean);
  }

  async acquireClaimLock(lockId, owner, ttlSeconds = 30) {
    await this.connect();
    const reply = await this.client.set(this.key("claim-lock", lockId), owner, {
      NX: true,
      EX: ttlSeconds
    });
    return reply === "OK";
  }

  async releaseClaimLock(lockId, owner) {
    await this.connect();
    const key = this.key("claim-lock", lockId);
    await this.client.eval(RELEASE_CLAIM_LOCK_SCRIPT, {
      keys: [key],
      arguments: [owner]
    });
  }

  async storeNonce(nonce, wallet, ttlSeconds = 300) {
    await this.connect();
    const reply = await this.client.set(this.key("nonce", nonce), wallet, {
      NX: true,
      EX: ttlSeconds
    });
    return reply === "OK";
  }

  async consumeNonce(nonce) {
    await this.connect();
    const key = this.key("nonce", nonce);
    const reply = await this.client.eval(CONSUME_NONCE_SCRIPT, {
      keys: [key],
      arguments: []
    });
    return reply ?? undefined;
  }

  async consumeRateLimit(bucket, key, { limit, windowSeconds }) {
    await this.connect();
    const redisKey = this.key(`rl:${bucket}`, key);
    const windowMs = windowSeconds * 1000;
    const reply = await this.client.eval(RATE_LIMIT_SCRIPT, {
      keys: [redisKey],
      arguments: [String(windowMs)]
    });
    const [countRaw, ttlRaw] = Array.isArray(reply) ? reply : [0, windowMs];
    const count = Number(countRaw);
    const ttlMs = Number(ttlRaw);
    const resetAt = Date.now() + (ttlMs > 0 ? ttlMs : windowMs);
    return {
      allowed: count <= limit,
      count,
      limit,
      remaining: Math.max(limit - count, 0),
      resetAt
    };
  }

  async getMutationReceipt(bucket, key) {
    await this.connect();
    const raw = await this.client.get(this.key("mutation-receipt", `${bucket}:${key}`));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertMutationReceipt(bucket, key, receipt) {
    await this.connect();
    await this.client.set(this.key("mutation-receipt", `${bucket}:${key}`), JSON.stringify(receipt));
    return receipt;
  }

  async getXcmObservation(requestId) {
    await this.connect();
    const raw = await this.client.get(this.key("xcm-observation", requestId));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertXcmObservation(observation) {
    await this.connect();
    const existing = await this.getXcmObservation(observation.requestId);
    const merged = {
      ...existing,
      ...observation,
      observedAt: observation.observedAt ?? existing?.observedAt ?? new Date().toISOString(),
      processed: Boolean(observation.processed ?? existing?.processed),
      attemptCount: Number(observation.attemptCount ?? existing?.attemptCount ?? 0)
    };
    await this.client.set(this.key("xcm-observation", observation.requestId), JSON.stringify(merged));
    if (!merged.processed) {
      await this.client.zAdd(this.key("xcm-observations", "pending"), {
        score: Date.parse(merged.observedAt) || Date.now(),
        value: observation.requestId
      });
    } else {
      await this.client.zRem(this.key("xcm-observations", "pending"), observation.requestId);
    }
    return merged;
  }

  async listPendingXcmObservations(limit = 50) {
    await this.connect();
    const requestIds = await this.client.zRange(
      this.key("xcm-observations", "pending"),
      0,
      Math.max(limit - 1, 0)
    );
    const entries = await Promise.all(requestIds.map((requestId) => this.getXcmObservation(requestId)));
    return entries.filter((entry) => entry && !entry.processed);
  }

  async markXcmObservationProcessed(requestId, result = undefined) {
    await this.connect();
    const current = await this.getXcmObservation(requestId);
    if (!current) return undefined;
    const updated = {
      ...current,
      processed: true,
      processedAt: new Date().toISOString(),
      result,
      lastError: undefined
    };
    await this.client.set(this.key("xcm-observation", requestId), JSON.stringify(updated));
    await this.client.zRem(this.key("xcm-observations", "pending"), requestId);
    return updated;
  }

  async markXcmObservationFailed(requestId, error) {
    await this.connect();
    const current = await this.getXcmObservation(requestId);
    if (!current) return undefined;
    const updated = {
      ...current,
      processed: false,
      attemptCount: Number(current.attemptCount ?? 0) + 1,
      lastError: error?.message ?? String(error ?? "unknown_error"),
      lastTriedAt: new Date().toISOString()
    };
    await this.client.set(this.key("xcm-observation", requestId), JSON.stringify(updated));
    await this.client.zAdd(this.key("xcm-observations", "pending"), {
      score: Date.parse(updated.observedAt) || Date.now(),
      value: requestId
    });
    return updated;
  }

  async getServiceState(scope) {
    await this.connect();
    const raw = await this.client.get(this.key("service-state", scope));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertServiceState(scope, state) {
    await this.connect();
    const existing = await this.getServiceState(scope);
    const merged = {
      ...(existing ?? {}),
      ...state,
      updatedAt: new Date().toISOString()
    };
    await this.client.set(this.key("service-state", scope), JSON.stringify(merged));
    return merged;
  }

  async revokeToken(jti, ttlSeconds) {
    await this.connect();
    // `EX` + a sentinel value. Expiry matches the JWT's remaining lifetime so
    // Redis auto-cleans revocations rather than growing unbounded.
    await this.client.set(this.key("revoked", jti), "1", {
      EX: Math.max(1, Math.ceil(ttlSeconds))
    });
  }

  async isTokenRevoked(jti) {
    await this.connect();
    const reply = await this.client.get(this.key("revoked", jti));
    return reply !== null && reply !== undefined;
  }

  async healthCheck() {
    try {
      await this.connect();
      const reply = await this.client.ping();
      return {
        ok: reply === "PONG",
        backend: "redis",
        mode: "durable"
      };
    } catch (error) {
      return {
        ok: false,
        backend: "redis",
        mode: "durable",
        error: new ExternalServiceError(`Redis health check failed: ${error?.message ?? "unknown_error"}`).message
      };
    }
  }

  async connect() {
    if (!this.connectionPromise) {
      this.connectionPromise = this.client.connect();
    }
    await this.connectionPromise;
  }

  key(kind, id) {
    return `${this.namespace}:${kind}:${id}`;
  }
}

export function createStateStore(env = process.env, { logger = console } = {}) {
  if (env.REDIS_URL) {
    return new RedisStateStore(env.REDIS_URL, env.REDIS_NAMESPACE ?? "agent-platform");
  }

  // A missing REDIS_URL in production means every restart wipes sessions,
  // nonces, claim locks, and rate-limit counters — that's an availability and
  // security bug, not an operational convenience. Require an explicit override
  // (STATE_STORE_ALLOW_MEMORY=1) before booting without Redis.
  const isProduction = env.NODE_ENV === "production";
  const isStrictAuth = env.AUTH_MODE === "strict" || (!env.AUTH_MODE && isProduction);
  const allowMemory = ["1", "true", "yes", "on"].includes(
    String(env.STATE_STORE_ALLOW_MEMORY ?? "").trim().toLowerCase()
  );

  if ((isProduction || isStrictAuth) && !allowMemory) {
    throw new ExternalServiceError(
      "REDIS_URL is required in production / strict-auth mode. " +
        "Set REDIS_URL (preferred) or STATE_STORE_ALLOW_MEMORY=1 to opt into ephemeral memory state."
    );
  }

  logger.warn?.(
    {
      backend: "memory",
      nodeEnv: env.NODE_ENV ?? "development",
      authMode: env.AUTH_MODE ?? "unset"
    },
    "state-store.memory_fallback"
  );
  return new MemoryStateStore();
}
