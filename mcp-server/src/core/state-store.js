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

export class MemoryStateStore {
  constructor() {
    this.sessions = new Map();
    this.idempotency = new Map();
    this.jobSessions = new Map();
    this.chainJobSessions = new Map();
    this.jobSessionHistory = new Map();
    this.walletSessions = new Map();
    this.verificationResults = new Map();
    this.claimLocks = new Map();
    this.nonces = new Map();
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

  async listSessionsByWallet(wallet, limit = 10) {
    const sessionIds = (this.walletSessions.get(wallet) ?? []).slice(0, limit);
    return sessionIds.map((sessionId) => this.sessions.get(sessionId)).filter(Boolean);
  }

  async listSessionsByJob(jobId, limit = 10) {
    const sessionIds = (this.jobSessionHistory.get(jobId) ?? []).slice(0, limit);
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

  async listSessionsByWallet(wallet, limit = 10) {
    await this.connect();
    const sessionIds = await this.client.zRange(this.key("wallet-sessions", wallet), 0, Math.max(limit - 1, 0), {
      REV: true
    });
    const sessions = await Promise.all(sessionIds.map((sessionId) => this.getSession(sessionId)));
    return sessions.filter(Boolean);
  }

  async listSessionsByJob(jobId, limit = 10) {
    await this.connect();
    const sessionIds = await this.client.zRange(this.key("job-sessions", jobId), 0, Math.max(limit - 1, 0), {
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

export function createStateStore(env = process.env) {
  if (env.REDIS_URL) {
    return new RedisStateStore(env.REDIS_URL, env.REDIS_NAMESPACE ?? "agent-platform");
  }
  return new MemoryStateStore();
}
