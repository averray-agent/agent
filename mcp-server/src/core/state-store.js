import { createClient } from "redis";
import { ExternalServiceError } from "./errors.js";
import { listEventLogFromRecords } from "./event-log-query.js";
import {
  cloneJsonRecord,
  filterCapabilityGrantRecords,
  filterFinalFundedJobRecords,
  listCapabilityGrantRecords,
  listFundedJobRecords,
  markXcmObservationFailedRecord,
  markXcmObservationProcessedRecord,
  mergeServiceStateRecord,
  mergeXcmObservationRecord,
  normalizeContentHash,
  normalizeFundedJobId,
  redisRangeFromLimitOffset,
  sliceWindow,
  timestampScore
} from "./state-store-records.js";

const DEFAULT_EVENT_LOG_RETENTION = 5_000;
const DEFAULT_SIWE_AUTH_WALLET_RETENTION = 1_000;
const BANK_V22_LEG_DISPATCH_TOPIC = "bank.v22_leg_dispatched";
const BANK_V22_LEGS = new Set([
  "deposit_funding",
  "deposit_sell",
  "withdraw_sell",
  "withdraw_home"
]);

function hasIndexableIdempotencyKey(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function verificationRunLockId(runId) {
  return `verification-run:${String(runId)}`;
}

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

// Atomically reserve capacity from a named daily aggregate. Reservation ids
// make claim retries idempotent, while the day in the Redis key makes a wallet
// change irrelevant and gives the budget an unambiguous UTC reset boundary.
const RESERVE_DAILY_BUDGET_SCRIPT = `
local existing = redis.call("hget", KEYS[1], ARGV[1])
local used = tonumber(redis.call("hget", KEYS[1], "used") or "0")
if existing then
  return {1, used, 1}
end
local amount = tonumber(ARGV[2])
local budget = tonumber(ARGV[3])
if used + amount > budget then
  return {0, used, 0}
end
local nextUsed = used + amount
redis.call("hset", KEYS[1], "used", tostring(nextUsed), ARGV[1], ARGV[2])
redis.call("expire", KEYS[1], ARGV[4])
return {1, nextUsed, 0}
`;

const MATERIALIZE_EXTERNAL_DRAFT_SCRIPT = `
if redis.call("exists", KEYS[1]) == 1 or redis.call("exists", KEYS[3]) == 1 then
  return 0
end
redis.call("set", KEYS[1], ARGV[1])
redis.call("zadd", KEYS[2], ARGV[2], ARGV[3])
redis.call("set", KEYS[3], ARGV[3])
return 1
`;

const RESERVE_VERIFICATION_RUN_SCRIPT = `
local existing = redis.call("get", KEYS[1])
if existing then
  return {0, existing}
end
redis.call("set", KEYS[1], ARGV[1])
redis.call("set", KEYS[2], ARGV[2])
if ARGV[3] ~= "" then
  redis.call("set", KEYS[3], ARGV[3])
end
redis.call("zadd", KEYS[4], ARGV[4], ARGV[1])
redis.call("zadd", KEYS[5], ARGV[4], ARGV[1])
return {1, ARGV[1]}
`;

const CLAIM_VERIFICATION_RUN_SCRIPT = `
local runIds = redis.call("zrange", KEYS[1], 0, 31)
local acceptedProfiles = cjson.decode(ARGV[6] or "[]")
for _, runId in ipairs(runIds) do
  local runKey = ARGV[1] .. runId
  local raw = redis.call("get", runKey)
  if not raw then
    redis.call("zrem", KEYS[1], runId)
    redis.call("zrem", KEYS[2], runId)
  else
    local run = cjson.decode(raw)
    if run.status ~= "queued" then
      redis.call("zrem", KEYS[1], runId)
    else
      local profileAllowed = #acceptedProfiles == 0
      for _, accepted in ipairs(acceptedProfiles) do
        if run.profileRef == accepted then profileAllowed = true end
      end
      if profileAllowed then
        local lockKey = ARGV[2] .. runId
        local acquired = redis.call("set", lockKey, ARGV[3], "NX", "EX", ARGV[4])
        if acquired then
          run.status = "running"
          run.startedAt = ARGV[5]
          local encoded = cjson.encode(run)
          redis.call("set", runKey, encoded)
          redis.call("zrem", KEYS[1], runId)
          return encoded
        end
      end
    end
  end
end
return false
`;

const CLAIM_EXACT_VERIFICATION_RUN_SCRIPT = `
local raw = redis.call("get", KEYS[1])
if not raw then return false end
local run = cjson.decode(raw)
if run.status ~= "queued" or run.profileRef ~= ARGV[1] then return false end
local acquired = redis.call("set", KEYS[2], ARGV[2], "NX", "EX", ARGV[3])
if not acquired then return false end
run.status = "running"
run.startedAt = ARGV[4]
local encoded = cjson.encode(run)
redis.call("set", KEYS[1], encoded)
redis.call("zrem", KEYS[3], run.runId)
return encoded
`;

const STORE_VERIFICATION_EXECUTION_SCRIPT = `
if redis.call("get", KEYS[2]) ~= ARGV[1] then
  return false
end
local raw = redis.call("get", KEYS[1])
if not raw then
  redis.call("del", KEYS[2])
  return false
end
local run = cjson.decode(raw)
if run.status ~= "running" then
  redis.call("del", KEYS[2])
  return false
end
run.status = "executed"
run.executedAt = ARGV[2]
run.execution = cjson.decode(ARGV[3])
local encoded = cjson.encode(run)
redis.call("set", KEYS[1], encoded)
redis.call("del", KEYS[2])
return encoded
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
    this.badgeDocuments = new Map();
    this.runReceiptDocuments = new Map();
    this.workReceiptDocuments = new Map();
    this.sessionWorkReceiptDocuments = new Map();
    this.verificationRuns = new Map();
    this.verificationPaymentRuns = new Map();
    this.verificationRunAuthorizations = new Map();
    this.claimLocks = new Map();
    this.nonces = new Map();
    this.rateLimits = new Map();
    this.dailyBudgets = new Map();
    this.mutationReceipts = new Map();
    this.xcmObservations = new Map();
    this.xcmBalanceWatches = new Map();
    this.serviceStates = new Map();
    this.content = new Map();
    this.fundedJobs = new Map();
    this.capabilityGrants = new Map();
    this.eventLog = [];
    this.bankXcmLegDispatchEvidence = new Map();
    this.accountOverlays = new Map();
    this.policyProposals = new Map();
    this.siweAuthActivity = new Map();
    this.externalJobDrafts = new Map();
    this.externalDraftJobIndex = new Map();
    this.externalPostingDemandSignals = [];
    this.externalPostingQuoteJobIndex = new Map();
    this.externalJobDelistings = new Map();
    this.externalPaymentFundings = new Map();
  }

  // ── policy proposals (Package G) ──────────────────────────────────
  //
  // Backs the PolicyService write-through cache. Built-in policies are
  // seed data loaded from builtin-policies.js; only operator-proposed
  // policies land here. Mirrors the account-overlay storage shape:
  // async API + deep-clone on the way in and out so callers cannot
  // mutate the internal Map.

  async getPolicyProposal(tag) {
    if (!tag) return undefined;
    const stored = this.policyProposals.get(String(tag));
    return cloneJsonRecord(stored);
  }

  async upsertPolicyProposal(tag, proposal) {
    if (!tag) return;
    this.policyProposals.set(String(tag), cloneJsonRecord(proposal ?? {}));
  }

  async listPolicyProposalTags() {
    return Array.from(this.policyProposals.keys());
  }

  // ── account overlays (Package C Phase 2) ───────────────────────────
  //
  // Backs the AccountOverlayStore write-through cache. Each entry holds
  // the per-wallet derived_cache + display_only fields documented in
  // ACCOUNT_OVERLAY_CLASSIFICATION (see account-mutation-service.js).
  // chain_authoritative fields are still resolved live against the
  // blockchain gateway on every read; persisting them here is harmless
  // since attachStoredTreasuryMetadata makes live win per-key.

  async getAccountOverlay(wallet) {
    if (!wallet) return undefined;
    const stored = this.accountOverlays.get(String(wallet));
    return stored ? cloneAccountOverlay(stored) : undefined;
  }

  async upsertAccountOverlay(wallet, overlay) {
    if (!wallet) return;
    this.accountOverlays.set(String(wallet), cloneAccountOverlay(overlay));
  }

  async listAccountOverlayWallets() {
    return Array.from(this.accountOverlays.keys());
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
    if (hasIndexableIdempotencyKey(persistedSession.idempotencyKey)) {
      this.idempotency.set(persistedSession.idempotencyKey, persistedSession.sessionId);
    }
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
    if (!hasIndexableIdempotencyKey(idempotencyKey)) return undefined;
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

  async getBadgeDocument(sessionId) {
    return cloneJsonRecord(this.badgeDocuments.get(sessionId));
  }

  async putBadgeDocument(sessionId, document) {
    const existing = this.badgeDocuments.get(sessionId);
    if (existing) {
      return cloneJsonRecord(existing);
    }
    const stored = cloneJsonRecord(document);
    this.badgeDocuments.set(sessionId, stored);
    return cloneJsonRecord(stored);
  }

  async setBadgeDocumentSignature(sessionId, signature) {
    const existing = this.badgeDocuments.get(sessionId);
    if (!existing || existing.signature) {
      return cloneJsonRecord(existing);
    }
    const signed = { ...cloneJsonRecord(existing), signature: cloneJsonRecord(signature) };
    this.badgeDocuments.set(sessionId, signed);
    return cloneJsonRecord(signed);
  }

  async getRunReceiptDocument(sessionId) {
    return cloneJsonRecord(
      this.sessionWorkReceiptDocuments.get(sessionId) ?? this.runReceiptDocuments.get(sessionId)
    );
  }

  async putRunReceiptDocument(sessionId, document) {
    const existing = this.runReceiptDocuments.get(sessionId);
    if (existing) return cloneJsonRecord(existing);
    const stored = cloneJsonRecord(document);
    this.runReceiptDocuments.set(sessionId, stored);
    return cloneJsonRecord(stored);
  }

  async getWorkReceiptDocument(receiptId) {
    return cloneJsonRecord(this.workReceiptDocuments.get(String(receiptId).toLowerCase()));
  }

  async putWorkReceiptDocument(sessionId, document) {
    const receiptId = String(document?.receiptId ?? "").toLowerCase();
    const existing = this.workReceiptDocuments.get(receiptId);
    if (existing) return cloneJsonRecord(existing);
    const stored = cloneJsonRecord(document);
    this.workReceiptDocuments.set(receiptId, stored);
    if (!this.sessionWorkReceiptDocuments.has(sessionId)) {
      this.sessionWorkReceiptDocuments.set(sessionId, stored);
    }
    return cloneJsonRecord(stored);
  }

  async getVerificationRun(runId) {
    return cloneJsonRecord(this.verificationRuns.get(String(runId)));
  }

  async getVerificationRunByPaymentId(paymentId) {
    const runId = this.verificationPaymentRuns.get(String(paymentId));
    return runId ? this.getVerificationRun(runId) : undefined;
  }

  async reserveVerificationRun(run, { paymentId, authorization } = {}) {
    const key = String(paymentId ?? "");
    const existingRunId = this.verificationPaymentRuns.get(key);
    if (existingRunId) {
      return { created: false, run: await this.getVerificationRun(existingRunId) };
    }
    const stored = cloneJsonRecord(run);
    this.verificationPaymentRuns.set(key, stored.runId);
    this.verificationRuns.set(stored.runId, stored);
    if (authorization) {
      this.verificationRunAuthorizations.set(stored.runId, cloneJsonRecord(authorization));
    }
    return { created: true, run: cloneJsonRecord(stored) };
  }

  async getVerificationRunAuthorization(runId) {
    return cloneJsonRecord(this.verificationRunAuthorizations.get(String(runId)));
  }

  async listActiveVerificationRuns(limit = 100) {
    return [...this.verificationRuns.values()]
      .filter((run) => run.status !== "complete")
      .sort((left, right) => String(left.submittedAt ?? "").localeCompare(String(right.submittedAt ?? "")))
      .slice(0, Math.max(0, Number(limit)))
      .map((run) => cloneJsonRecord(run));
  }

  async claimNextVerificationRun({ owner, claimedAt, leaseSeconds = 180, profileRefs = [] } = {}) {
    const accepted = new Set(profileRefs.map(String));
    const candidates = await this.listActiveVerificationRuns();
    for (const candidate of candidates) {
      if (candidate.status !== "queued") continue;
      if (accepted.size > 0 && !accepted.has(candidate.profileRef)) continue;
      const lockId = verificationRunLockId(candidate.runId);
      if (!await this.acquireClaimLock(lockId, owner, leaseSeconds)) continue;
      const current = this.verificationRuns.get(candidate.runId);
      if (current?.status !== "queued") {
        await this.releaseClaimLock(lockId, owner);
        continue;
      }
      const claimed = cloneJsonRecord({ ...current, status: "running", startedAt: claimedAt });
      this.verificationRuns.set(candidate.runId, claimed);
      return cloneJsonRecord(claimed);
    }
    return undefined;
  }

  async claimVerificationRun(runId, { owner, claimedAt, leaseSeconds = 180, profileRef } = {}) {
    const normalizedRunId = String(runId);
    const current = this.verificationRuns.get(normalizedRunId);
    if (current?.status !== "queued" || current.profileRef !== String(profileRef)) return undefined;
    const lockId = verificationRunLockId(normalizedRunId);
    if (!await this.acquireClaimLock(lockId, owner, leaseSeconds)) return undefined;
    const claimed = cloneJsonRecord({ ...current, status: "running", startedAt: claimedAt });
    this.verificationRuns.set(normalizedRunId, claimed);
    return cloneJsonRecord(claimed);
  }

  async storeVerificationRunExecution(runId, { owner, execution, executedAt } = {}) {
    const normalizedRunId = String(runId);
    const lockId = verificationRunLockId(normalizedRunId);
    const lock = this.claimLocks.get(lockId);
    if (!lock || lock.owner !== owner || lock.expiresAt <= Date.now()) return undefined;
    const current = this.verificationRuns.get(normalizedRunId);
    if (current?.status !== "running") {
      await this.releaseClaimLock(lockId, owner);
      return undefined;
    }
    const stored = cloneJsonRecord({ ...current, status: "executed", executedAt, execution });
    this.verificationRuns.set(normalizedRunId, stored);
    await this.releaseClaimLock(lockId, owner);
    return cloneJsonRecord(stored);
  }

  async updateVerificationRun(runId, run) {
    const stored = cloneJsonRecord(run);
    this.verificationRuns.set(String(runId), stored);
    if (stored.status === "complete") {
      this.verificationRunAuthorizations.delete(String(runId));
    }
    return cloneJsonRecord(stored);
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

  async getDailyBudgetUsage(scope, day) {
    const entry = this.dailyBudgets.get(`${scope}:${day}`);
    return {
      usedUnits: entry?.usedUnits ?? 0,
      reservationCount: entry?.reservations.size ?? 0
    };
  }

  async reserveDailyBudget(scope, day, {
    reservationId,
    amountUnits,
    limitUnits
  } = {}) {
    const key = `${scope}:${day}`;
    const entry = this.dailyBudgets.get(key) ?? {
      usedUnits: 0,
      reservations: new Map()
    };
    const existing = entry.reservations.get(reservationId);
    if (existing !== undefined) {
      return dailyBudgetReservationResult({
        accepted: true,
        usedUnits: entry.usedUnits,
        limitUnits,
        alreadyReserved: true
      });
    }
    if (entry.usedUnits + amountUnits > limitUnits) {
      return dailyBudgetReservationResult({
        accepted: false,
        usedUnits: entry.usedUnits,
        limitUnits,
        alreadyReserved: false
      });
    }
    entry.usedUnits += amountUnits;
    entry.reservations.set(reservationId, amountUnits);
    this.dailyBudgets.set(key, entry);
    return dailyBudgetReservationResult({
      accepted: true,
      usedUnits: entry.usedUnits,
      limitUnits,
      alreadyReserved: false
    });
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

  async recordSiweAuthEvent({ wallet, event, at = new Date().toISOString() }) {
    const input = normalizeSiweAuthEvent({ wallet, event, at });
    const existing = this.siweAuthActivity.get(input.wallet);
    const updated = applySiweAuthEvent(existing, input);
    this.siweAuthActivity.set(input.wallet, updated);
    if (this.siweAuthActivity.size > DEFAULT_SIWE_AUTH_WALLET_RETENTION) {
      const staleWallets = [...this.siweAuthActivity.values()]
        .sort((left, right) => String(left.lastSeenAt).localeCompare(String(right.lastSeenAt)))
        .slice(0, this.siweAuthActivity.size - DEFAULT_SIWE_AUTH_WALLET_RETENTION);
      for (const stale of staleWallets) {
        this.siweAuthActivity.delete(stale.wallet);
      }
    }
    return cloneJsonRecord(updated);
  }

  async listSiweAuthActivity({ limit = 100 } = {}) {
    const safeLimit = normalizeSiweActivityLimit(limit);
    return [...this.siweAuthActivity.values()]
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))
      .slice(0, safeLimit)
      .map((record) => cloneJsonRecord(record));
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

  async getContent(hash) {
    return this.content.get(normalizeContentHash(hash));
  }

  async upsertContent(record) {
    const key = normalizeContentHash(record?.hash);
    this.content.set(key, record);
    return record;
  }

  async getFundedJob(jobId) {
    return this.fundedJobs.get(normalizeFundedJobId(jobId));
  }

  async upsertFundedJob(record) {
    this.fundedJobs.set(normalizeFundedJobId(record?.jobId), record);
    return record;
  }

  async listFundedJobs({ limit = 100, offset = 0, finalOnly = false } = {}) {
    return listFundedJobRecords(this.fundedJobs.values(), { limit, offset, finalOnly });
  }

  async materializeExternalJobDraft(record) {
    const draftId = String(record?.draftId ?? "");
    const jobId = normalizeExternalJobId(record?.jobId);
    if (this.externalJobDrafts.has(draftId) || this.externalDraftJobIndex.has(jobId)) {
      return false;
    }
    this.externalJobDrafts.set(draftId, cloneJsonRecord(record));
    this.externalDraftJobIndex.set(jobId, draftId);
    return true;
  }

  async getExternalJobDraft(draftId) {
    return cloneJsonRecord(this.externalJobDrafts.get(String(draftId ?? "")));
  }

  async getExternalJobDraftByJobId(jobId) {
    const draftId = this.externalDraftJobIndex.get(normalizeExternalJobId(jobId));
    return draftId ? this.getExternalJobDraft(draftId) : undefined;
  }

  async updateExternalJobDraft(draftId, patch) {
    const key = String(draftId ?? "");
    const existing = this.externalJobDrafts.get(key);
    if (!existing) return undefined;
    const updated = cloneJsonRecord({ ...existing, ...patch });
    this.externalJobDrafts.set(key, updated);
    this.externalDraftJobIndex.set(normalizeExternalJobId(updated.jobId), key);
    return cloneJsonRecord(updated);
  }

  async listExternalJobDrafts({ status, limit = 10_000, offset = 0 } = {}) {
    return [...this.externalJobDrafts.values()]
      .filter((entry) => !status || String(entry?.status ?? "awaiting_funding") === status)
      .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")))
      .slice(offset, offset + limit)
      .map((entry) => cloneJsonRecord(entry));
  }

  async appendExternalPostingDemandSignal(signal) {
    const stored = cloneJsonRecord(signal);
    const index = this.externalPostingDemandSignals.findIndex((entry) => entry.id === stored.id);
    if (index >= 0) {
      this.externalPostingDemandSignals[index] = stored;
    } else {
      this.externalPostingDemandSignals.push(stored);
    }
    if (stored?.quote?.jobId) {
      this.externalPostingQuoteJobIndex.set(normalizeExternalJobId(stored.quote.jobId), stored.id);
    }
    return cloneJsonRecord(stored);
  }

  async getExternalPostingDemandSignal(id) {
    return cloneJsonRecord(this.externalPostingDemandSignals.find((entry) => entry.id === String(id ?? "")));
  }

  async getExternalPostingQuoteByJobId(jobId) {
    const id = this.externalPostingQuoteJobIndex.get(normalizeExternalJobId(jobId));
    return id ? this.getExternalPostingDemandSignal(id) : undefined;
  }

  async updateExternalPostingDemandSignal(id, patch) {
    const existing = await this.getExternalPostingDemandSignal(id);
    if (!existing) return undefined;
    return this.appendExternalPostingDemandSignal({ ...existing, ...patch });
  }

  async listExternalPostingDemandSignals({ limit = 10_000, offset = 0 } = {}) {
    return this.externalPostingDemandSignals
      .slice(offset, offset + limit)
      .map((entry) => cloneJsonRecord(entry));
  }

  async upsertExternalPaymentFunding(record) {
    const id = normalizeExternalPaymentFundingId(record?.id);
    const stored = cloneJsonRecord({ ...record, id });
    this.externalPaymentFundings.set(id, stored);
    return cloneJsonRecord(stored);
  }

  async getExternalPaymentFunding(id) {
    return cloneJsonRecord(
      this.externalPaymentFundings.get(normalizeExternalPaymentFundingId(id))
    );
  }

  async listExternalPaymentFundings({ limit = 10_000, offset = 0 } = {}) {
    return [...this.externalPaymentFundings.values()]
      .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")))
      .slice(offset, offset + limit)
      .map((entry) => cloneJsonRecord(entry));
  }

  async upsertExternalJobDelisting(record) {
    const jobId = normalizeExternalJobId(record?.jobId);
    const stored = cloneJsonRecord({ ...record, jobId });
    this.externalJobDelistings.set(jobId, stored);
    return cloneJsonRecord(stored);
  }

  async getExternalJobDelisting(jobId) {
    return cloneJsonRecord(this.externalJobDelistings.get(normalizeExternalJobId(jobId)));
  }

  async isExternalJobDelisted(jobId) {
    return this.externalJobDelistings.has(normalizeExternalJobId(jobId));
  }

  async getXcmObservation(wrapperAddress, requestId) {
    return cloneJsonRecord(this.xcmObservations.get(xcmRequestStorageId(wrapperAddress, requestId)));
  }

  async upsertXcmObservation(observation) {
    const identity = normalizeXcmRequestIdentity(observation?.wrapperAddress, observation?.requestId);
    const storageId = xcmRequestStorageId(identity.wrapperAddress, identity.requestId);
    const existing = this.xcmObservations.get(storageId) ?? {};
    const merged = mergeXcmObservationRecord(existing, { ...observation, ...identity });
    this.xcmObservations.set(storageId, merged);
    return cloneJsonRecord(merged);
  }

  async listPendingXcmObservations(limit = 50) {
    return sliceWindow([...this.xcmObservations.values()]
      .filter((entry) => !entry.processed)
      .sort((left, right) => String(left.observedAt ?? "").localeCompare(String(right.observedAt ?? ""))), { limit, offset: 0 });
  }

  async appendEventLog(event) {
    if (event?.topic === BANK_V22_LEG_DISPATCH_TOPIC) {
      await this.recordBankXcmLegDispatchEvidence(event);
    }
    const existingIndex = this.eventLog.findIndex((entry) => entry.id === event.id);
    if (existingIndex >= 0) {
      this.eventLog.splice(existingIndex, 1);
    }
    this.eventLog.push(event);
    if (this.eventLog.length > DEFAULT_EVENT_LOG_RETENTION) {
      this.eventLog.splice(0, this.eventLog.length - DEFAULT_EVENT_LOG_RETENTION);
    }
    return event;
  }

  async recordBankXcmLegDispatchEvidence(event) {
    const normalized = normalizeBankXcmLegDispatchEvidence(event);
    this.bankXcmLegDispatchEvidence.set(
      bankXcmLegDispatchStorageId(
        normalized.data.wrapper,
        normalized.data.requestId,
        normalized.data.leg
      ),
      normalized
    );
    return cloneJsonRecord(normalized);
  }

  async getBankXcmLegDispatchEvidence(wrapperAddress, requestId, leg) {
    return cloneJsonRecord(this.bankXcmLegDispatchEvidence.get(
      bankXcmLegDispatchStorageId(wrapperAddress, requestId, leg)
    ));
  }

  async getLatestBankXcmLegDispatchEvidence(wrapperAddress, leg) {
    const identity = normalizeBankXcmLegIdentity(wrapperAddress, leg);
    const candidates = [...this.bankXcmLegDispatchEvidence.values()]
      .filter((event) => event.data.wrapper === identity.wrapperAddress && event.data.leg === identity.leg)
      .sort(compareBankXcmLegDispatchEvidence);
    return cloneJsonRecord(candidates.at(-1));
  }

  async listEventLog(filter = {}) {
    return listEventLogFromRecords(this.eventLog, filter);
  }

  async markXcmObservationProcessed(wrapperAddress, requestId, result = undefined) {
    const storageId = xcmRequestStorageId(wrapperAddress, requestId);
    const current = this.xcmObservations.get(storageId);
    const updated = markXcmObservationProcessedRecord(current, result);
    if (!updated) return undefined;
    this.xcmObservations.set(storageId, updated);
    return cloneJsonRecord(updated);
  }

  async markXcmObservationFailed(wrapperAddress, requestId, error, retry = undefined) {
    const storageId = xcmRequestStorageId(wrapperAddress, requestId);
    const current = this.xcmObservations.get(storageId);
    const updated = markXcmObservationFailedRecord(current, error, retry);
    if (!updated) return undefined;
    this.xcmObservations.set(storageId, updated);
    return cloneJsonRecord(updated);
  }

  async migrateLegacyXcmObservation({ requestId, wrapperAddress, expected }) {
    const legacyId = normalizeXcmRequestId(requestId);
    const identity = normalizeXcmRequestIdentity(wrapperAddress, legacyId);
    const storageId = xcmRequestStorageId(identity.wrapperAddress, identity.requestId);
    const migrated = this.xcmObservations.get(storageId);
    if (migrated) return { status: "already_migrated", observation: cloneJsonRecord(migrated) };
    const legacy = this.xcmObservations.get(legacyId);
    if (!legacy) return { status: "not_found" };
    assertLegacyXcmObservation(legacy, expected);
    const stored = cloneJsonRecord({ ...legacy, ...identity, migrationSource: "legacy_request_id_only" });
    this.xcmObservations.delete(legacyId);
    this.xcmObservations.set(storageId, stored);
    return { status: "migrated", observation: cloneJsonRecord(stored) };
  }

  async getXcmBalanceWatch(wrapperAddress, requestId) {
    return cloneJsonRecord(this.xcmBalanceWatches.get(xcmBalanceWatchStorageId(wrapperAddress, requestId)));
  }

  async upsertXcmBalanceWatch(watch) {
    const identity = normalizeXcmBalanceWatchIdentity(watch?.wrapperAddress, watch?.requestId);
    const storageId = xcmBalanceWatchStorageId(identity.wrapperAddress, identity.requestId);
    const existing = this.xcmBalanceWatches.get(storageId) ?? {};
    const stored = cloneJsonRecord({ ...existing, ...watch, ...identity });
    this.xcmBalanceWatches.set(storageId, stored);
    return cloneJsonRecord(stored);
  }

  async migrateLegacyXcmBalanceWatch({ requestId, expectedTargetAccount, wrapperAddress, terminal }) {
    const legacyId = normalizeXcmBalanceWatchRequestId(requestId);
    const identity = normalizeXcmBalanceWatchIdentity(wrapperAddress, legacyId);
    const storageId = xcmBalanceWatchStorageId(identity.wrapperAddress, identity.requestId);
    const migrated = this.xcmBalanceWatches.get(storageId);
    if (migrated) return { status: "already_migrated", watch: cloneJsonRecord(migrated) };
    const legacy = this.xcmBalanceWatches.get(legacyId);
    if (!legacy) return { status: "not_found" };
    assertLegacyXcmWatchTarget(legacy, expectedTargetAccount);
    const archived = cloneJsonRecord({ ...legacy, ...terminal, ...identity });
    this.xcmBalanceWatches.delete(legacyId);
    this.xcmBalanceWatches.set(storageId, archived);
    return { status: "migrated", watch: cloneJsonRecord(archived) };
  }

  async listPendingXcmBalanceWatches(limit = 50) {
    return sliceWindow([...this.xcmBalanceWatches.values()]
      .filter((entry) => entry.status === "pending")
      .sort((left, right) => String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? ""))), {
      limit,
      offset: 0
    }).map((entry) => cloneJsonRecord(entry));
  }

  async listRecentTerminalXcmBalanceWatches(limit = 10) {
    return sliceWindow([...this.xcmBalanceWatches.values()]
      .filter((entry) => entry.status !== "pending")
      .sort((left, right) => String(right.completedAt ?? right.startedAt ?? "")
        .localeCompare(String(left.completedAt ?? left.startedAt ?? ""))), {
      limit,
      offset: 0
    }).map((entry) => cloneJsonRecord(entry));
  }

  async getServiceState(scope) {
    return this.serviceStates.get(scope);
  }

  async upsertServiceState(scope, state) {
    const existing = this.serviceStates.get(scope) ?? {};
    const merged = mergeServiceStateRecord(existing, state);
    this.serviceStates.set(scope, merged);
    return merged;
  }

  async getCapabilityGrant(id) {
    return this.capabilityGrants.get(String(id ?? ""));
  }

  async upsertCapabilityGrant(record) {
    const id = String(record?.id ?? "");
    if (!id) return record;
    this.capabilityGrants.set(id, record);
    return record;
  }

  async listCapabilityGrants({ subject, status, limit = 100, offset = 0 } = {}) {
    return listCapabilityGrantRecords(this.capabilityGrants.values(), { subject, status, limit, offset });
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

  // ── Phase 4b.5b: refresh-token persistence ─────────────────────────────
  // Keyed by SHA-256(rawToken) hex. TTL = refresh-TTL + forensic grace
  // (see mcp-server/src/auth/refresh.js for the design).
  _evictExpiredRefreshRecords() {
    if (!this.refreshRecords) return;
    const now = Date.now();
    for (const [hash, entry] of this.refreshRecords) {
      if (entry.expiresAtMs <= now) this.refreshRecords.delete(hash);
    }
  }

  async getRefreshRecord(hash) {
    if (!this.refreshRecords) return null;
    this._evictExpiredRefreshRecords();
    const entry = this.refreshRecords.get(hash);
    return entry ? entry.value : null;
  }

  async upsertRefreshRecord(hash, record, ttlSeconds) {
    if (!this.refreshRecords) this.refreshRecords = new Map();
    this.refreshRecords.set(hash, {
      value: record,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
    });
  }
}

export class RedisStateStore {
  constructor(redisUrl, namespace = "agent-platform") {
    this.redisUrl = redisUrl;
    this.namespace = namespace;
    this.client = createClient({ url: redisUrl });
    this.connectionPromise = undefined;
  }

  // ── account overlays (Package C Phase 2) ───────────────────────────
  // Persisted as a single Redis hash `<namespace>:account-overlay` with
  // wallet → JSON.stringified overlay. See MemoryStateStore for the
  // contract and ACCOUNT_OVERLAY_CLASSIFICATION for field semantics.

  async getAccountOverlay(wallet) {
    if (!wallet) return undefined;
    await this.connect();
    const raw = await this.client.hGet(this.key("account-overlay", "all"), String(wallet));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertAccountOverlay(wallet, overlay) {
    if (!wallet) return;
    await this.connect();
    await this.client.hSet(
      this.key("account-overlay", "all"),
      String(wallet),
      JSON.stringify(overlay ?? {})
    );
  }

  async listAccountOverlayWallets() {
    await this.connect();
    return await this.client.hKeys(this.key("account-overlay", "all"));
  }

  // ── policy proposals (Package G) ──────────────────────────────────
  // Mirrors the account-overlay shape: single hash
  // `<namespace>:policy-proposal` keyed by tag.

  async getPolicyProposal(tag) {
    if (!tag) return undefined;
    await this.connect();
    const raw = await this.client.hGet(this.key("policy-proposal", "all"), String(tag));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertPolicyProposal(tag, proposal) {
    if (!tag) return;
    await this.connect();
    await this.client.hSet(
      this.key("policy-proposal", "all"),
      String(tag),
      JSON.stringify(proposal ?? {})
    );
  }

  async listPolicyProposalTags() {
    await this.connect();
    return await this.client.hKeys(this.key("policy-proposal", "all"));
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
    if (hasIndexableIdempotencyKey(persistedSession.idempotencyKey)) {
      await this.client.set(this.key("idempotency", persistedSession.idempotencyKey), persistedSession.sessionId);
    }
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
    if (!hasIndexableIdempotencyKey(idempotencyKey)) return undefined;
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

  async getBadgeDocument(sessionId) {
    await this.connect();
    const raw = await this.client.get(this.key("badge", sessionId));
    return raw ? JSON.parse(raw) : undefined;
  }

  async putBadgeDocument(sessionId, document) {
    await this.connect();
    const key = this.key("badge", sessionId);
    await this.client.set(key, JSON.stringify(document), { NX: true });
    return this.getBadgeDocument(sessionId);
  }

  async setBadgeDocumentSignature(sessionId, signature) {
    await this.connect();
    const key = this.key("badge", sessionId);
    const raw = await this.client.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return false end
       local document = cjson.decode(raw)
       if document.signature then return raw end
       document.signature = cjson.decode(ARGV[1])
       local signed = cjson.encode(document)
       redis.call('SET', KEYS[1], signed)
       return signed`,
      { keys: [key], arguments: [JSON.stringify(signature)] }
    );
    return raw ? JSON.parse(raw) : undefined;
  }

  async getRunReceiptDocument(sessionId) {
    await this.connect();
    const raw = await this.client.get(this.key("work-receipt-session", sessionId))
      ?? await this.client.get(this.key("run-receipt", sessionId));
    return raw ? JSON.parse(raw) : undefined;
  }

  async putRunReceiptDocument(sessionId, document) {
    await this.connect();
    const key = this.key("run-receipt", sessionId);
    await this.client.set(key, JSON.stringify(document), { NX: true });
    return this.getRunReceiptDocument(sessionId);
  }

  async getWorkReceiptDocument(receiptId) {
    await this.connect();
    const raw = await this.client.get(this.key("work-receipt", String(receiptId).toLowerCase()));
    return raw ? JSON.parse(raw) : undefined;
  }

  async putWorkReceiptDocument(sessionId, document) {
    await this.connect();
    const receiptId = String(document?.receiptId ?? "").toLowerCase();
    const encoded = JSON.stringify(document);
    await this.client.set(this.key("work-receipt", receiptId), encoded, { NX: true });
    await this.client.set(this.key("work-receipt-session", sessionId), encoded, { NX: true });
    return this.getWorkReceiptDocument(receiptId);
  }

  async getVerificationRun(runId) {
    await this.connect();
    const raw = await this.client.get(this.key("verification-run", String(runId)));
    return raw ? JSON.parse(raw) : undefined;
  }

  async getVerificationRunByPaymentId(paymentId) {
    await this.connect();
    const runId = await this.client.get(this.key("verification-payment", String(paymentId)));
    return runId ? this.getVerificationRun(runId) : undefined;
  }

  async reserveVerificationRun(run, { paymentId, authorization } = {}) {
    await this.connect();
    const reply = await this.client.eval(RESERVE_VERIFICATION_RUN_SCRIPT, {
      keys: [
        this.key("verification-payment", String(paymentId ?? "")),
        this.key("verification-run", String(run.runId)),
        this.key("verification-run-authorization", String(run.runId)),
        this.key("verification-runs", "queued"),
        this.key("verification-runs", "active")
      ],
      arguments: [
        String(run.runId),
        JSON.stringify(run),
        authorization ? JSON.stringify(authorization) : "",
        String(timestampScore(run.submittedAt))
      ]
    });
    const [createdRaw, runId] = Array.isArray(reply) ? reply : [0, undefined];
    return {
      created: Number(createdRaw) === 1,
      run: await this.getVerificationRun(runId)
    };
  }

  async getVerificationRunAuthorization(runId) {
    await this.connect();
    const raw = await this.client.get(this.key("verification-run-authorization", String(runId)));
    return raw ? JSON.parse(raw) : undefined;
  }

  async listActiveVerificationRuns(limit = 100) {
    await this.connect();
    const normalizedLimit = Math.max(0, Number(limit));
    if (normalizedLimit === 0) return [];
    const runIds = await this.client.zRange(this.key("verification-runs", "active"), 0, normalizedLimit - 1);
    const runs = await Promise.all(runIds.map((runId) => this.getVerificationRun(runId)));
    return runs.filter(Boolean);
  }

  async claimNextVerificationRun({ owner, claimedAt, leaseSeconds = 180, profileRefs = [] } = {}) {
    await this.connect();
    const raw = await this.client.eval(CLAIM_VERIFICATION_RUN_SCRIPT, {
      keys: [
        this.key("verification-runs", "queued"),
        this.key("verification-runs", "active")
      ],
      arguments: [
        this.key("verification-run", ""),
        this.key("claim-lock", "verification-run:"),
        String(owner),
        String(Math.max(1, Math.ceil(leaseSeconds))),
        String(claimedAt),
        JSON.stringify(profileRefs.map(String))
      ]
    });
    return raw ? JSON.parse(raw) : undefined;
  }

  async claimVerificationRun(runId, { owner, claimedAt, leaseSeconds = 180, profileRef } = {}) {
    await this.connect();
    const normalizedRunId = String(runId);
    const raw = await this.client.eval(CLAIM_EXACT_VERIFICATION_RUN_SCRIPT, {
      keys: [
        this.key("verification-run", normalizedRunId),
        this.key("claim-lock", verificationRunLockId(normalizedRunId)),
        this.key("verification-runs", "queued")
      ],
      arguments: [
        String(profileRef),
        String(owner),
        String(Math.max(1, Math.ceil(leaseSeconds))),
        String(claimedAt)
      ]
    });
    return raw ? JSON.parse(raw) : undefined;
  }

  async storeVerificationRunExecution(runId, { owner, execution, executedAt } = {}) {
    await this.connect();
    const raw = await this.client.eval(STORE_VERIFICATION_EXECUTION_SCRIPT, {
      keys: [
        this.key("verification-run", String(runId)),
        this.key("claim-lock", verificationRunLockId(runId))
      ],
      arguments: [String(owner), String(executedAt), JSON.stringify(execution)]
    });
    return raw ? JSON.parse(raw) : undefined;
  }

  async updateVerificationRun(runId, run) {
    await this.connect();
    const normalizedRunId = String(runId);
    const transaction = this.client.multi()
      .set(this.key("verification-run", normalizedRunId), JSON.stringify(run));
    if (run?.status === "complete") {
      transaction
        .del(this.key("verification-run-authorization", normalizedRunId))
        .zRem(this.key("verification-runs", "queued"), normalizedRunId)
        .zRem(this.key("verification-runs", "active"), normalizedRunId);
    }
    await transaction.exec();
    return this.getVerificationRun(runId);
  }

  async listSessionsByWallet(wallet, limit = 10, offset = 0) {
    await this.connect();
    const { start, stop } = redisRangeFromLimitOffset(limit, offset);
    const sessionIds = await this.client.zRange(this.key("wallet-sessions", wallet), start, stop, {
      REV: true
    });
    const sessions = await Promise.all(sessionIds.map((sessionId) => this.getSession(sessionId)));
    return sessions.filter(Boolean);
  }

  async listSessionsByJob(jobId, limit = 10, offset = 0) {
    await this.connect();
    const { start, stop } = redisRangeFromLimitOffset(limit, offset);
    const sessionIds = await this.client.zRange(this.key("job-sessions", jobId), start, stop, {
      REV: true
    });
    const sessions = await Promise.all(sessionIds.map((sessionId) => this.getSession(sessionId)));
    return sessions.filter(Boolean);
  }

  async listRecentSessions(limit = 10, offset = 0) {
    await this.connect();
    const { start, stop } = redisRangeFromLimitOffset(limit, offset);
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

  async getDailyBudgetUsage(scope, day) {
    await this.connect();
    const key = this.key("daily-budget", `${scope}:${day}`);
    const [usedRaw, fieldCount] = await Promise.all([
      this.client.hGet(key, "used"),
      this.client.hLen(key)
    ]);
    return {
      usedUnits: Number(usedRaw ?? 0),
      reservationCount: Math.max(Number(fieldCount ?? 0) - (usedRaw === null ? 0 : 1), 0)
    };
  }

  async reserveDailyBudget(scope, day, {
    reservationId,
    amountUnits,
    limitUnits,
    ttlSeconds = 86_400
  } = {}) {
    await this.connect();
    const key = this.key("daily-budget", `${scope}:${day}`);
    const reply = await this.client.eval(RESERVE_DAILY_BUDGET_SCRIPT, {
      keys: [key],
      arguments: [
        String(reservationId),
        String(amountUnits),
        String(limitUnits),
        String(Math.max(1, Math.ceil(ttlSeconds)))
      ]
    });
    const [acceptedRaw, usedRaw, alreadyReservedRaw] = Array.isArray(reply)
      ? reply
      : [0, 0, 0];
    return dailyBudgetReservationResult({
      accepted: Number(acceptedRaw) === 1,
      usedUnits: Number(usedRaw),
      limitUnits,
      alreadyReserved: Number(alreadyReservedRaw) === 1
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

  async recordSiweAuthEvent({ wallet, event, at = new Date().toISOString() }) {
    const input = normalizeSiweAuthEvent({ wallet, event, at });
    await this.connect();
    const recordKey = this.key("auth", `siwe:${input.wallet}`);
    const indexKey = this.key("auth", "siwe-wallets");
    const counterField = input.event === "nonce_issued"
      ? "noncesIssued"
      : "verifiesSucceeded";
    const timestampField = input.event === "nonce_issued"
      ? "lastNonceIssuedAt"
      : "lastVerifySucceededAt";

    // The counters are atomic even when one wallet races multiple auth
    // requests. Timestamps are diagnostic context; the sorted-set score keeps
    // the admin view ordered by the latest recorded server event.
    await this.client.hIncrBy(recordKey, counterField, 1);
    await this.client.hSetNX(recordKey, "firstSeenAt", input.at);
    await this.client.hSet(recordKey, "wallet", input.wallet);
    await this.client.hSet(recordKey, timestampField, input.at);
    await this.client.hSet(recordKey, "lastSeenAt", input.at);
    await this.client.zAdd(indexKey, {
      score: Date.parse(input.at),
      value: input.wallet
    });
    const staleWallets = await this.client.zRange(
      indexKey,
      0,
      -(DEFAULT_SIWE_AUTH_WALLET_RETENTION + 1)
    );
    if (staleWallets.length > 0) {
      await this.client.zRem(indexKey, staleWallets);
      await this.client.del(
        staleWallets.map((wallet) => this.key("auth", `siwe:${wallet}`))
      );
    }

    return normalizeSiweAuthActivityRecord(
      await this.client.hGetAll(recordKey),
      input.wallet
    );
  }

  async listSiweAuthActivity({ limit = 100 } = {}) {
    await this.connect();
    const safeLimit = normalizeSiweActivityLimit(limit);
    const wallets = await this.client.zRange(
      this.key("auth", "siwe-wallets"),
      0,
      Math.max(0, safeLimit - 1),
      { REV: true }
    );
    return await Promise.all(wallets.map(async (wallet) => normalizeSiweAuthActivityRecord(
      await this.client.hGetAll(this.key("auth", `siwe:${wallet}`)),
      wallet
    )));
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

  async getContent(hash) {
    await this.connect();
    const raw = await this.client.get(this.key("content", normalizeContentHash(hash)));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertContent(record) {
    await this.connect();
    const key = normalizeContentHash(record?.hash);
    await this.client.set(this.key("content", key), JSON.stringify(record));
    return record;
  }

  async getFundedJob(jobId) {
    await this.connect();
    const raw = await this.client.get(this.key("funded-job", normalizeFundedJobId(jobId)));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertFundedJob(record) {
    await this.connect();
    const jobId = normalizeFundedJobId(record?.jobId);
    await this.client.set(this.key("funded-job", jobId), JSON.stringify(record));
    await this.client.zAdd(this.key("funded-jobs", "all"), {
      score: timestampScore(record?.fundedAt ?? record?.updatedAt ?? ""),
      value: jobId
    });
    return record;
  }

  async listFundedJobs({ limit = 100, offset = 0, finalOnly = false } = {}) {
    await this.connect();
    const { start, stop } = redisRangeFromLimitOffset(limit, offset);
    const jobIds = await this.client.zRange(this.key("funded-jobs", "all"), start, stop, { REV: true });
    const records = await Promise.all(jobIds.map((jobId) => this.getFundedJob(jobId)));
    return filterFinalFundedJobRecords(records.filter(Boolean), finalOnly);
  }

  async materializeExternalJobDraft(record) {
    await this.connect();
    const draftId = String(record?.draftId ?? "");
    const jobId = normalizeExternalJobId(record?.jobId);
    const result = await this.client.eval(MATERIALIZE_EXTERNAL_DRAFT_SCRIPT, {
      keys: [
        this.key("external-draft", draftId),
        this.key("external-drafts", "all"),
        this.key("external-draft-job", jobId)
      ],
      arguments: [
        JSON.stringify(record),
        String(timestampScore(record?.materializedAt ?? record?.createdAt ?? "")),
        draftId
      ]
    });
    return Number(result) === 1;
  }

  async getExternalJobDraft(draftId) {
    await this.connect();
    const raw = await this.client.get(this.key("external-draft", String(draftId ?? "")));
    return raw ? JSON.parse(raw) : undefined;
  }

  async getExternalJobDraftByJobId(jobId) {
    await this.connect();
    const draftId = await this.client.get(this.key(
      "external-draft-job",
      normalizeExternalJobId(jobId)
    ));
    return draftId ? this.getExternalJobDraft(draftId) : undefined;
  }

  async updateExternalJobDraft(draftId, patch) {
    await this.connect();
    const existing = await this.getExternalJobDraft(draftId);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    await this.client.set(
      this.key("external-draft", String(draftId ?? "")),
      JSON.stringify(updated)
    );
    await this.client.set(
      this.key("external-draft-job", normalizeExternalJobId(updated.jobId)),
      String(draftId)
    );
    if (String(updated.status ?? "awaiting_funding") !== "awaiting_funding") {
      await this.client.zRem(
        this.key("external-drafts-wallet", String(updated.wallet ?? "").toLowerCase()),
        String(draftId)
      );
    }
    return updated;
  }

  async listExternalJobDrafts({ status, limit = 10_000, offset = 0 } = {}) {
    await this.connect();
    const ids = await this.client.zRange(this.key("external-drafts", "all"), 0, -1);
    const records = (await Promise.all(ids.map((id) => this.getExternalJobDraft(id))))
      .filter(Boolean)
      .filter((entry) => !status || String(entry?.status ?? "awaiting_funding") === status);
    return records.slice(offset, offset + limit);
  }

  async appendExternalPostingDemandSignal(signal) {
    await this.connect();
    const id = String(signal?.id ?? "");
    const transaction = this.client.multi()
      .set(this.key("external-posting-demand", id), JSON.stringify(signal))
      .zAdd(this.key("external-posting-demand", "all"), {
        score: timestampScore(signal?.lastAttemptedAt ?? signal?.attemptedAt ?? ""),
        value: id
      });
    if (signal?.quote?.jobId) {
      transaction.set(
        this.key("external-posting-quote-job", normalizeExternalJobId(signal.quote.jobId)),
        id
      );
    }
    await transaction.exec();
    return signal;
  }

  async getExternalPostingDemandSignal(id) {
    await this.connect();
    const raw = await this.client.get(this.key("external-posting-demand", String(id ?? "")));
    return raw ? JSON.parse(raw) : undefined;
  }

  async getExternalPostingQuoteByJobId(jobId) {
    await this.connect();
    const id = await this.client.get(this.key(
      "external-posting-quote-job",
      normalizeExternalJobId(jobId)
    ));
    return id ? this.getExternalPostingDemandSignal(id) : undefined;
  }

  async updateExternalPostingDemandSignal(id, patch) {
    const existing = await this.getExternalPostingDemandSignal(id);
    if (!existing) return undefined;
    return this.appendExternalPostingDemandSignal({ ...existing, ...patch });
  }

  async listExternalPostingDemandSignals({ limit = 10_000, offset = 0 } = {}) {
    await this.connect();
    const { start, stop } = redisRangeFromLimitOffset(limit, offset);
    const ids = await this.client.zRange(
      this.key("external-posting-demand", "all"),
      start,
      stop
    );
    const records = await Promise.all(ids.map(async (id) => {
      const raw = await this.client.get(this.key("external-posting-demand", id));
      return raw ? JSON.parse(raw) : undefined;
    }));
    return records.filter(Boolean);
  }

  async upsertExternalPaymentFunding(record) {
    await this.connect();
    const id = normalizeExternalPaymentFundingId(record?.id);
    const stored = { ...record, id };
    await this.client.multi()
      .set(this.key("external-payment-funding", id), JSON.stringify(stored))
      .zAdd(this.key("external-payment-funding", "all"), {
        // Creation order is stable across status updates, so paginated float
        // accounting cannot skip or double-count a record while it settles.
        score: timestampScore(stored.createdAt ?? ""),
        value: id
      })
      .exec();
    return stored;
  }

  async getExternalPaymentFunding(id) {
    await this.connect();
    const raw = await this.client.get(this.key(
      "external-payment-funding",
      normalizeExternalPaymentFundingId(id)
    ));
    return raw ? JSON.parse(raw) : undefined;
  }

  async listExternalPaymentFundings({ limit = 10_000, offset = 0 } = {}) {
    await this.connect();
    const { start, stop } = redisRangeFromLimitOffset(limit, offset);
    const ids = await this.client.zRange(
      this.key("external-payment-funding", "all"),
      start,
      stop
    );
    const records = await Promise.all(ids.map((id) => this.getExternalPaymentFunding(id)));
    return records.filter(Boolean);
  }

  async upsertExternalJobDelisting(record) {
    await this.connect();
    const jobId = normalizeExternalJobId(record?.jobId);
    const stored = { ...record, jobId };
    await this.client.set(
      this.key("external-job-delisting", jobId),
      JSON.stringify(stored)
    );
    return stored;
  }

  async getExternalJobDelisting(jobId) {
    await this.connect();
    const raw = await this.client.get(this.key(
      "external-job-delisting",
      normalizeExternalJobId(jobId)
    ));
    return raw ? JSON.parse(raw) : undefined;
  }

  async isExternalJobDelisted(jobId) {
    return Boolean(await this.getExternalJobDelisting(jobId));
  }

  async getXcmObservation(wrapperAddress, requestId) {
    await this.connect();
    const raw = await this.client.get(this.key("xcm-observation", xcmRequestStorageId(wrapperAddress, requestId)));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertXcmObservation(observation) {
    await this.connect();
    const identity = normalizeXcmRequestIdentity(observation?.wrapperAddress, observation?.requestId);
    const storageId = xcmRequestStorageId(identity.wrapperAddress, identity.requestId);
    const existing = await this.getXcmObservation(identity.wrapperAddress, identity.requestId);
    const merged = mergeXcmObservationRecord(existing, { ...observation, ...identity });
    await this.client.set(this.key("xcm-observation", storageId), JSON.stringify(merged));
    if (!merged.processed) {
      await this.client.zAdd(this.key("xcm-observations", "pending"), {
        score: timestampScore(merged.observedAt),
        value: storageId
      });
    } else {
      await this.client.zRem(this.key("xcm-observations", "pending"), storageId);
    }
    return merged;
  }

  async listPendingXcmObservations(limit = 50) {
    await this.connect();
    const { stop } = redisRangeFromLimitOffset(limit, 0);
    const storageIds = await this.client.zRange(
      this.key("xcm-observations", "pending"),
      0,
      stop
    );
    const entries = await Promise.all(storageIds.map(async (storageId) => {
      const raw = await this.client.get(this.key("xcm-observation", storageId));
      return raw ? JSON.parse(raw) : undefined;
    }));
    return entries.filter((entry) => entry && !entry.processed);
  }

  async appendEventLog(event) {
    await this.connect();
    if (event?.topic === BANK_V22_LEG_DISPATCH_TOPIC) {
      await this.recordBankXcmLegDispatchEvidence(event);
    }
    const id = String(event?.id ?? "");
    if (!id) return event;
    const score = timestampScore(event?.timestamp ?? "");
    const recordKey = this.key("event-log", id);
    const indexKey = this.key("event-log", "all");
    await this.client.set(recordKey, JSON.stringify(event));
    await this.client.zAdd(indexKey, { score, value: id });
    const staleIds = await this.client.zRange(indexKey, 0, -(DEFAULT_EVENT_LOG_RETENTION + 1));
    if (staleIds.length > 0) {
      await this.client.zRem(indexKey, staleIds);
      await this.client.del(staleIds.map((staleId) => this.key("event-log", staleId)));
    }
    return event;
  }

  async recordBankXcmLegDispatchEvidence(event) {
    await this.connect();
    const normalized = normalizeBankXcmLegDispatchEvidence(event);
    const { wrapper, requestId, leg, blockNumber } = normalized.data;
    const storageId = bankXcmLegDispatchStorageId(wrapper, requestId, leg);
    await this.client.multi()
      .set(this.key("bank-xcm-leg-dispatch", storageId), JSON.stringify(normalized))
      .zAdd(this.key("bank-xcm-leg-dispatch", bankXcmLegDispatchIndexId(wrapper, leg)), {
        score: blockNumber,
        value: storageId
      })
      .exec();
    return normalized;
  }

  async getBankXcmLegDispatchEvidence(wrapperAddress, requestId, leg) {
    await this.connect();
    const raw = await this.client.get(this.key(
      "bank-xcm-leg-dispatch",
      bankXcmLegDispatchStorageId(wrapperAddress, requestId, leg)
    ));
    return raw ? JSON.parse(raw) : undefined;
  }

  async getLatestBankXcmLegDispatchEvidence(wrapperAddress, leg) {
    await this.connect();
    const identity = normalizeBankXcmLegIdentity(wrapperAddress, leg);
    const [storageId] = await this.client.zRange(
      this.key("bank-xcm-leg-dispatch", bankXcmLegDispatchIndexId(identity.wrapperAddress, identity.leg)),
      0,
      0,
      { REV: true }
    );
    if (!storageId) return undefined;
    const raw = await this.client.get(this.key("bank-xcm-leg-dispatch", storageId));
    return raw ? JSON.parse(raw) : undefined;
  }

  async listEventLog(filter = {}) {
    await this.connect();
    const ids = await this.client.zRange(this.key("event-log", "all"), 0, -1);
    const records = await Promise.all(ids.map(async (id) => {
      const raw = await this.client.get(this.key("event-log", id));
      return raw ? JSON.parse(raw) : undefined;
    }));
    return listEventLogFromRecords(records.filter(Boolean), filter);
  }

  async markXcmObservationProcessed(wrapperAddress, requestId, result = undefined) {
    await this.connect();
    const storageId = xcmRequestStorageId(wrapperAddress, requestId);
    const current = await this.getXcmObservation(wrapperAddress, requestId);
    const updated = markXcmObservationProcessedRecord(current, result);
    if (!updated) return undefined;
    await this.client.set(this.key("xcm-observation", storageId), JSON.stringify(updated));
    await this.client.zRem(this.key("xcm-observations", "pending"), storageId);
    return updated;
  }

  async markXcmObservationFailed(wrapperAddress, requestId, error, retry = undefined) {
    await this.connect();
    const storageId = xcmRequestStorageId(wrapperAddress, requestId);
    const current = await this.getXcmObservation(wrapperAddress, requestId);
    const updated = markXcmObservationFailedRecord(current, error, retry);
    if (!updated) return undefined;
    await this.client.set(this.key("xcm-observation", storageId), JSON.stringify(updated));
    await this.client.zAdd(this.key("xcm-observations", "pending"), {
      score: timestampScore(updated.observedAt),
      value: storageId
    });
    return updated;
  }

  async migrateLegacyXcmObservation({ requestId, wrapperAddress, expected }) {
    await this.connect();
    const legacyId = normalizeXcmRequestId(requestId);
    const identity = normalizeXcmRequestIdentity(wrapperAddress, legacyId);
    const storageId = xcmRequestStorageId(identity.wrapperAddress, identity.requestId);
    const migrated = await this.getXcmObservation(identity.wrapperAddress, identity.requestId);
    if (migrated) return { status: "already_migrated", observation: migrated };
    const legacyKey = this.key("xcm-observation", legacyId);
    const raw = await this.client.get(legacyKey);
    if (!raw) return { status: "not_found" };
    const legacy = JSON.parse(raw);
    assertLegacyXcmObservation(legacy, expected);
    const stored = { ...legacy, ...identity, migrationSource: "legacy_request_id_only" };
    const transaction = this.client.multi()
      .set(this.key("xcm-observation", storageId), JSON.stringify(stored))
      .del(legacyKey)
      .zRem(this.key("xcm-observations", "pending"), legacyId);
    if (!stored.processed) {
      transaction.zAdd(this.key("xcm-observations", "pending"), {
        score: timestampScore(stored.observedAt),
        value: storageId
      });
    }
    await transaction.exec();
    return { status: "migrated", observation: stored };
  }

  async getXcmBalanceWatch(wrapperAddress, requestId) {
    await this.connect();
    const storageId = xcmBalanceWatchStorageId(wrapperAddress, requestId);
    const raw = await this.client.get(this.key("xcm-balance-watch", storageId));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertXcmBalanceWatch(watch) {
    await this.connect();
    const identity = normalizeXcmBalanceWatchIdentity(watch?.wrapperAddress, watch?.requestId);
    const storageId = xcmBalanceWatchStorageId(identity.wrapperAddress, identity.requestId);
    const existing = await this.getXcmBalanceWatch(identity.wrapperAddress, identity.requestId);
    const stored = { ...(existing ?? {}), ...watch, ...identity };
    await this.client.set(this.key("xcm-balance-watch", storageId), JSON.stringify(stored));
    if (stored.status === "pending") {
      await this.client.zAdd(this.key("xcm-balance-watches", "pending"), {
        score: timestampScore(stored.startedAt),
        value: storageId
      });
      await this.client.zRem(this.key("xcm-balance-watches", "terminal"), storageId);
    } else {
      await this.client.zRem(this.key("xcm-balance-watches", "pending"), storageId);
      await this.client.zAdd(this.key("xcm-balance-watches", "terminal"), {
        score: timestampScore(stored.completedAt ?? stored.startedAt),
        value: storageId
      });
    }
    return stored;
  }

  async migrateLegacyXcmBalanceWatch({ requestId, expectedTargetAccount, wrapperAddress, terminal }) {
    await this.connect();
    const legacyId = normalizeXcmBalanceWatchRequestId(requestId);
    const identity = normalizeXcmBalanceWatchIdentity(wrapperAddress, legacyId);
    const storageId = xcmBalanceWatchStorageId(identity.wrapperAddress, identity.requestId);
    const migrated = await this.getXcmBalanceWatch(identity.wrapperAddress, identity.requestId);
    if (migrated) return { status: "already_migrated", watch: migrated };
    const legacyKey = this.key("xcm-balance-watch", legacyId);
    const raw = await this.client.get(legacyKey);
    if (!raw) return { status: "not_found" };
    const legacy = JSON.parse(raw);
    assertLegacyXcmWatchTarget(legacy, expectedTargetAccount);
    const archived = { ...legacy, ...terminal, ...identity };
    await this.client.multi()
      .set(this.key("xcm-balance-watch", storageId), JSON.stringify(archived))
      .del(legacyKey)
      .zRem(this.key("xcm-balance-watches", "pending"), legacyId)
      .zRem(this.key("xcm-balance-watches", "terminal"), legacyId)
      .zAdd(this.key("xcm-balance-watches", "terminal"), {
        score: timestampScore(archived.completedAt ?? archived.startedAt),
        value: storageId
      })
      .exec();
    return { status: "migrated", watch: archived };
  }

  async listPendingXcmBalanceWatches(limit = 50) {
    await this.connect();
    const { stop } = redisRangeFromLimitOffset(limit, 0);
    const storageIds = await this.client.zRange(this.key("xcm-balance-watches", "pending"), 0, stop);
    const records = await Promise.all(storageIds.map((storageId) => this.getXcmBalanceWatchByStorageId(storageId)));
    return records.filter((entry) => entry?.status === "pending");
  }

  async listRecentTerminalXcmBalanceWatches(limit = 10) {
    await this.connect();
    const { stop } = redisRangeFromLimitOffset(limit, 0);
    const storageIds = await this.client.zRange(
      this.key("xcm-balance-watches", "terminal"),
      0,
      stop,
      { REV: true }
    );
    const records = await Promise.all(storageIds.map((storageId) => this.getXcmBalanceWatchByStorageId(storageId)));
    return records.filter((entry) => entry && entry.status !== "pending");
  }

  async getXcmBalanceWatchByStorageId(storageId) {
    const raw = await this.client.get(this.key("xcm-balance-watch", String(storageId ?? "")));
    return raw ? JSON.parse(raw) : undefined;
  }

  async getServiceState(scope) {
    await this.connect();
    const raw = await this.client.get(this.key("service-state", scope));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertServiceState(scope, state) {
    await this.connect();
    const existing = await this.getServiceState(scope);
    const merged = mergeServiceStateRecord(existing, state);
    await this.client.set(this.key("service-state", scope), JSON.stringify(merged));
    return merged;
  }

  async getCapabilityGrant(id) {
    await this.connect();
    const raw = await this.client.get(this.key("capability-grant", String(id ?? "")));
    return raw ? JSON.parse(raw) : undefined;
  }

  async upsertCapabilityGrant(record) {
    await this.connect();
    const id = String(record?.id ?? "");
    if (!id) return record;
    await this.client.set(this.key("capability-grant", id), JSON.stringify(record));
    // Sorted set indices so list queries by subject and by status are
    // O(log n + k) instead of scanning every grant key.
    await this.client.zAdd(this.key("capability-grants", "all"), {
      score: timestampScore(record?.issuedAt ?? ""),
      value: id
    });
    if (record?.subject) {
      await this.client.zAdd(
        this.key("capability-grants-by-subject", String(record.subject).toLowerCase()),
        { score: timestampScore(record?.issuedAt ?? ""), value: id }
      );
    }
    return record;
  }

  async listCapabilityGrants({ subject, status, limit = 100, offset = 0 } = {}) {
    await this.connect();
    const { start, stop } = redisRangeFromLimitOffset(limit, offset);
    const indexKey = subject
      ? this.key("capability-grants-by-subject", String(subject).toLowerCase())
      : this.key("capability-grants", "all");
    const ids = await this.client.zRange(indexKey, start, stop, { REV: true });
    const records = await Promise.all(ids.map((id) => this.getCapabilityGrant(id)));
    return filterCapabilityGrantRecords(records, { status });
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

  // ── Phase 4b.5b: refresh-token persistence ─────────────────────────────
  // Stores RefreshRecord JSON under `auth:refresh:<hash>` with explicit TTL.
  // Keyspace + payload shape defined in mcp-server/src/auth/refresh.js.
  async getRefreshRecord(hash) {
    await this.connect();
    const raw = await this.client.get(this.key("auth", `refresh:${hash}`));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async upsertRefreshRecord(hash, record, ttlSeconds) {
    await this.connect();
    await this.client.set(
      this.key("auth", `refresh:${hash}`),
      JSON.stringify(record),
      { EX: Math.max(1, Math.ceil(ttlSeconds)) },
    );
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

// Deep clone for the in-memory overlay path so callers cannot retain a
// reference into the store's internal Map and silently mutate it.
// Overlays are plain JSON (numbers, strings, arrays, nested objects) —
// JSON round-trip is the simplest correct clone for that shape.
function cloneAccountOverlay(overlay) {
  return cloneJsonRecord(overlay);
}

function dailyBudgetReservationResult({ accepted, usedUnits, limitUnits, alreadyReserved }) {
  return {
    accepted,
    usedUnits,
    limitUnits,
    remainingUnits: Math.max(limitUnits - usedUnits, 0),
    alreadyReserved
  };
}

function normalizeExternalJobId(jobId) {
  return String(jobId ?? "").trim().toLowerCase();
}

function normalizeExternalPaymentFundingId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(id)) {
    throw new ExternalServiceError(
      "External payment funding id must be a 32-byte value."
    );
  }
  return id;
}

const SIWE_AUTH_EVENTS = new Set(["nonce_issued", "verify_succeeded"]);

function normalizeSiweAuthEvent({ wallet, event, at }) {
  const normalizedWallet = String(wallet ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/u.test(normalizedWallet)) {
    throw new Error("SIWE auth telemetry requires a canonical wallet address.");
  }
  if (!SIWE_AUTH_EVENTS.has(event)) {
    throw new Error(`Unsupported SIWE auth telemetry event: ${event ?? "missing"}`);
  }
  const timestamp = new Date(at);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("SIWE auth telemetry requires a valid event timestamp.");
  }
  return {
    wallet: normalizedWallet,
    event,
    at: timestamp.toISOString()
  };
}

function applySiweAuthEvent(existing, input) {
  const current = normalizeSiweAuthActivityRecord(existing, input.wallet);
  const noncesIssued = current.noncesIssued + (input.event === "nonce_issued" ? 1 : 0);
  const verifiesSucceeded = current.verifiesSucceeded + (input.event === "verify_succeeded" ? 1 : 0);
  return {
    wallet: input.wallet,
    noncesIssued,
    verifiesSucceeded,
    verificationGap: Math.max(0, noncesIssued - verifiesSucceeded),
    firstSeenAt: current.firstSeenAt ?? input.at,
    lastNonceIssuedAt: input.event === "nonce_issued" ? input.at : current.lastNonceIssuedAt,
    lastVerifySucceededAt: input.event === "verify_succeeded" ? input.at : current.lastVerifySucceededAt,
    lastSeenAt: input.at
  };
}

function normalizeSiweAuthActivityRecord(record, wallet) {
  const source = record && typeof record === "object" ? record : {};
  const noncesIssued = Math.max(0, Number(source.noncesIssued) || 0);
  const verifiesSucceeded = Math.max(0, Number(source.verifiesSucceeded) || 0);
  return {
    wallet: String(source.wallet ?? wallet ?? "").toLowerCase(),
    noncesIssued,
    verifiesSucceeded,
    verificationGap: Math.max(0, noncesIssued - verifiesSucceeded),
    firstSeenAt: source.firstSeenAt ?? null,
    lastNonceIssuedAt: source.lastNonceIssuedAt ?? null,
    lastVerifySucceededAt: source.lastVerifySucceededAt ?? null,
    lastSeenAt: source.lastSeenAt ?? null
  };
}

function normalizeSiweActivityLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(Math.trunc(parsed), 1000);
}

function normalizeXcmRequestIdentity(wrapperAddress, requestId) {
  return {
    wrapperAddress: normalizeXcmWrapperAddress(wrapperAddress),
    requestId: normalizeXcmRequestId(requestId)
  };
}

function normalizeXcmWrapperAddress(wrapperAddress) {
  const wrapper = String(wrapperAddress ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/u.test(wrapper)) {
    throw new ExternalServiceError("XCM wrapperAddress must be a 20-byte address.");
  }
  return wrapper;
}

function normalizeXcmRequestId(requestId) {
  const normalized = String(requestId ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(normalized)) {
    throw new ExternalServiceError("XCM requestId must be a 32-byte value.");
  }
  return normalized;
}

function xcmRequestStorageId(wrapperAddress, requestId) {
  const identity = normalizeXcmRequestIdentity(wrapperAddress, requestId);
  return `${identity.wrapperAddress}:${identity.requestId}`;
}

function normalizeBankXcmLegIdentity(wrapperAddress, leg) {
  const wrapper = normalizeXcmWrapperAddress(wrapperAddress);
  const normalizedLeg = String(leg ?? "").trim();
  if (!BANK_V22_LEGS.has(normalizedLeg)) {
    throw new ExternalServiceError(`Unsupported bank v2.2 dispatch leg: ${normalizedLeg || "missing"}.`);
  }
  return { wrapperAddress: wrapper, leg: normalizedLeg };
}

function normalizeBankXcmLegDispatchEvidence(event) {
  if (event?.topic !== BANK_V22_LEG_DISPATCH_TOPIC) {
    throw new ExternalServiceError(`Bank dispatch evidence must use topic ${BANK_V22_LEG_DISPATCH_TOPIC}.`);
  }
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const identity = normalizeXcmRequestIdentity(data.wrapper, data.requestId ?? event.correlationId);
  const { leg } = normalizeBankXcmLegIdentity(identity.wrapperAddress, data.leg);
  const txHash = String(data.txHash ?? event.txHash ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(txHash)) {
    throw new ExternalServiceError("Bank dispatch evidence requires a 32-byte transaction hash.");
  }
  const blockNumber = Number(data.blockNumber ?? event.blockNumber);
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
    throw new ExternalServiceError("Bank dispatch evidence requires a positive block number.");
  }
  const hasDryRunEvents = Array.isArray(data.dryRun?.events);
  const hasRemoteExecutionEvent = data.remoteExecution?.event
    && typeof data.remoteExecution.event === "object";
  if (!hasDryRunEvents && !hasRemoteExecutionEvent) {
    throw new ExternalServiceError(
      "Bank dispatch evidence requires exact-message dry-run events or a chain-observed remote execution event."
    );
  }
  const timestamp = new Date(event.timestamp ?? data.capturedAt ?? "");
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ExternalServiceError("Bank dispatch evidence requires a valid capture timestamp.");
  }
  return cloneJsonRecord({
    ...event,
    topic: BANK_V22_LEG_DISPATCH_TOPIC,
    correlationId: identity.requestId,
    timestamp: timestamp.toISOString(),
    data: {
      ...data,
      wrapper: identity.wrapperAddress,
      requestId: identity.requestId,
      leg,
      txHash,
      blockNumber
    }
  });
}

function bankXcmLegDispatchStorageId(wrapperAddress, requestId, leg) {
  const identity = normalizeXcmRequestIdentity(wrapperAddress, requestId);
  const normalizedLeg = normalizeBankXcmLegIdentity(identity.wrapperAddress, leg).leg;
  return `${identity.wrapperAddress}:${identity.requestId}:${normalizedLeg}`;
}

function bankXcmLegDispatchIndexId(wrapperAddress, leg) {
  const identity = normalizeBankXcmLegIdentity(wrapperAddress, leg);
  return `${identity.wrapperAddress}:${identity.leg}:all`;
}

function compareBankXcmLegDispatchEvidence(left, right) {
  const blockDelta = Number(left?.data?.blockNumber ?? 0) - Number(right?.data?.blockNumber ?? 0);
  if (blockDelta !== 0) return blockDelta;
  return String(left?.timestamp ?? "").localeCompare(String(right?.timestamp ?? ""));
}

function normalizeXcmBalanceWatchIdentity(wrapperAddress, requestId) {
  return normalizeXcmRequestIdentity(wrapperAddress, requestId);
}

function normalizeXcmBalanceWatchRequestId(requestId) {
  return normalizeXcmRequestId(requestId);
}

function xcmBalanceWatchStorageId(wrapperAddress, requestId) {
  const identity = normalizeXcmBalanceWatchIdentity(wrapperAddress, requestId);
  return `${identity.wrapperAddress}:${identity.requestId}`;
}

function assertLegacyXcmWatchTarget(watch, expectedTargetAccount) {
  const expected = String(expectedTargetAccount ?? "").toLowerCase();
  const actual = String(watch?.target?.account ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(expected) || actual !== expected) {
    throw new ExternalServiceError(
      "Legacy XCM balance watch did not match the audited generation target; refusing migration."
    );
  }
}

function assertLegacyXcmObservation(observation, expected = {}) {
  for (const [field, value] of Object.entries(expected)) {
    const actual = field.split(".").reduce((current, part) => current?.[part], observation);
    if (String(actual ?? "") !== String(value)) {
      throw new ExternalServiceError(
        `Legacy XCM observation did not match audited ${field}; refusing migration.`
      );
    }
  }
}
