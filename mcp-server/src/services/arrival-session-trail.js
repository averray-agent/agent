import { ARRIVAL_STAGES, stageRank } from "./arrival-stage-map.js";

export const ARRIVAL_SESSION_SCHEMA = "averray.arrival-sessions.v1";
export const NOT_REPORTED = "not reported";
export const SESSION_STEP_CAP = 200;
export const SESSION_RECORD_CAP = 200;
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const STATE_SCOPE = "arrival-session-trail";
const SESSION_SCOPE_PREFIX = "arrival-session-record:";
const WALLET_RE = /^0x[0-9a-f]{40}$/u;
const SESSION_ID_RE = /^[a-z0-9-]{1,80}$/u;
const FOUR_XX = new Set([400, 401, 403, 404, 409, 422, 429]);
const TOOL_CODES = new Set([
  "invalid_request", "invalid_submission_shape", "not_found", "conflict",
  "unauthorized", "forbidden", "rate_limited", "missing_capability",
  "missing_role", "internal_error", "chain_backend_required", "blockchain_revert"
]);
const PREAUTH_NOTE = "Stateless pre-auth requests are counted, not stitched together.";

/**
 * Operator-only trail. One record per authenticated wallet, or per legacy MCP
 * session id. Pre-auth requests that have neither are counted and not stitched.
 * Never served from /monitor/arrivals or /transparency.
 */
export class ArrivalSessionTrail {
  constructor({
    stateStore,
    now = () => Date.now(),
    flushIntervalMs = 30_000
  } = {}) {
    this.stateStore = stateStore;
    this.now = now;
    this.flushIntervalMs = flushIntervalMs;
    this.sessions = new Map();
    this.unstitched = 0;
    this.droppedRecords = 0;
    this.dirtyIds = new Set();
    this.collectionSinceMs = undefined;
    this.loaded = false;
    this.loadFailed = null;
    this.loadPromise = null;
    this.dirty = false;
    this.lastFlushMs = 0;
  }

  async observe({
    wallet,
    mcpSessionId,
    clientInfo,
    protocolVersion,
    door = "mcp",
    name,
    resultClass,
    stage = "reached"
  } = {}) {
    try {
      if (!(await this.ensureLoaded())) return;
      const nowMs = this.now();
      if (this.collectionSinceMs === undefined) this.collectionSinceMs = nowMs;
      this.prune(nowMs);
      const id = sessionIdFor(wallet, mcpSessionId);
      if (!id) {
        this.unstitched += 1;
        this.dirty = true;
        await this.maybeFlush();
        return;
      }
      const record = this.sessions.get(id) ?? {
        id,
        kind: id.startsWith("wallet:") ? "wallet" : "mcp_session",
        stitched: true,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        clientName: NOT_REPORTED,
        clientVersion: NOT_REPORTED,
        protocolVersion: NOT_REPORTED,
        furthestStage: NOT_REPORTED,
        clientNameSource: NOT_REPORTED,
        steps: [],
        stepsDropped: 0
      };
      record.lastSeenMs = nowMs;
      const clientName = boundedText(clientInfo?.name, 64);
      const clientVersion = boundedText(clientInfo?.version, 32);
      const protocol = boundedText(protocolVersion, 32);
      if (clientName) record.clientName = clientName;
      if (clientVersion) record.clientVersion = clientVersion;
      if (protocol) record.protocolVersion = protocol;
      if (clientInfo?.source === "user-agent") record.clientNameSource = "user-agent";
      else if (clientName) record.clientNameSource = "declared";
      const resolvedStage = ARRIVAL_STAGES.includes(stage) ? stage : "reached";
      const normalizedResult = normalizeResultClass(resultClass);
      if (normalizedResult === "ok" && stageRank(resolvedStage) > stageRank(record.furthestStage)) {
        record.furthestStage = resolvedStage;
      }
      record.steps.push({
        atMs: nowMs,
        door: door === "http" ? "http" : "mcp",
        name: boundedText(name, 120) ?? NOT_REPORTED,
        resultClass: normalizedResult
      });
      if (record.steps.length > SESSION_STEP_CAP) {
        const overflow = record.steps.length - SESSION_STEP_CAP;
        record.steps.splice(0, overflow);
        record.stepsDropped += overflow;
      }
      this.sessions.set(id, record);
      this.evictOverflow();
      this.dirtyIds.add(id);
      this.dirty = true;
      await this.maybeFlush();
    } catch {
      // A trail must not change the request it observes.
    }
  }

  async list({ limit = 50, offset = 0 } = {}) {
    if (!(await this.ensureLoaded())) return unavailableTrail(this.loadFailed);
    this.prune(this.now());
    const bounded = Math.min(100, Math.max(1, Number(limit) || 50));
    const start = Math.max(0, Number(offset) || 0);
    const ordered = [...this.sessions.values()].sort((left, right) => right.lastSeenMs - left.lastSeenMs);
    const sessions = ordered.slice(start, start + bounded).map(publicRecord);
    const nextOffset = start + sessions.length < ordered.length ? start + sessions.length : null;
    return {
      schemaVersion: ARRIVAL_SESSION_SCHEMA,
      generatedAtMs: this.now(),
      retentionDays: 30,
      stepCap: SESSION_STEP_CAP,
      recordCap: SESSION_RECORD_CAP,
      droppedRecords: this.droppedRecords,
      nextOffset,
      preAuth: {
        stitched: false,
        count: this.unstitched,
        note: PREAUTH_NOTE
      },
      sessions
    };
  }

  async get(id) {
    if (!(await this.ensureLoaded())) return unavailableTrail(this.loadFailed);
    this.prune(this.now());
    const record = this.sessions.get(String(id ?? ""));
    if (!record) return undefined;
    return {
      schemaVersion: ARRIVAL_SESSION_SCHEMA,
      generatedAtMs: this.now(),
      preAuth: { stitched: false, count: this.unstitched, note: PREAUTH_NOTE },
      session: publicRecord(record)
    };
  }

  async ensureLoaded() {
    if (this.loaded) return true;
    this.loadPromise ??= this.loadState();
    try {
      await this.loadPromise;
      return true;
    } catch {
      return false;
    } finally {
      this.loadPromise = null;
    }
  }

  async loadState() {
    try {
      const stored = await this.stateStore?.getServiceState?.(STATE_SCOPE);
      this.sessions = new Map();
      for (const entry of Array.isArray(stored?.sessions) ? stored.sessions : []) {
        const normalized = normalizeStored(entry);
        if (normalized) this.sessions.set(normalized.id, normalized);
      }
      this.unstitched = Number.isSafeInteger(stored?.unstitched) && stored.unstitched >= 0
        ? stored.unstitched : 0;
      this.droppedRecords = Number.isSafeInteger(stored?.droppedRecords) && stored.droppedRecords >= 0
        ? stored.droppedRecords : 0;
      const indexed = Array.isArray(stored?.sessionIds) ? stored.sessionIds : [];
      for (const id of indexed) {
        if (this.sessions.has(id)) continue;
        const record = normalizeStored(await this.stateStore?.getServiceState?.(sessionScope(id)));
        if (record) this.sessions.set(record.id, record);
      }
      const since = Number(stored?.collectionSinceMs);
      this.collectionSinceMs = Number.isFinite(since) ? since : this.now();
      this.prune(this.now());
      this.loaded = true;
      this.loadFailed = null;
    } catch (error) {
      this.loaded = false;
      this.loadFailed = "arrival session trail could not be read";
      throw error;
    }
  }

  async maybeFlush(force = false) {
    if (!this.dirty) return;
    const nowMs = this.now();
    if (!force && nowMs - this.lastFlushMs < this.flushIntervalMs) return;
    this.lastFlushMs = nowMs;
    this.dirty = false;
    try {
      const dirtyIds = [...this.dirtyIds];
      await this.stateStore?.upsertServiceState?.(STATE_SCOPE, {
        collectionSinceMs: this.collectionSinceMs,
        unstitched: this.unstitched,
        droppedRecords: this.droppedRecords,
        sessionIds: [...this.sessions.keys()]
      });
      for (const id of dirtyIds) {
        const record = this.sessions.get(id);
        if (record) await this.stateStore?.upsertServiceState?.(sessionScope(id), record);
      }
      this.dirtyIds.clear();
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  prune(nowMs) {
    const oldest = nowMs - SESSION_RETENTION_MS;
    for (const [id, record] of this.sessions) {
      if (record.lastSeenMs < oldest) {
        this.sessions.delete(id);
        this.droppedRecords += 1;
      }
    }
  }

  evictOverflow() {
    while (this.sessions.size > SESSION_RECORD_CAP) {
      let oldestId;
      let oldestSeen = Infinity;
      for (const [id, record] of this.sessions) {
        if (record.lastSeenMs < oldestSeen) {
          oldestSeen = record.lastSeenMs;
          oldestId = id;
        }
      }
      if (!oldestId) return;
      this.sessions.delete(oldestId);
      this.dirtyIds.delete(oldestId);
      this.droppedRecords += 1;
    }
  }
}

function sessionScope(id) {
  return `${SESSION_SCOPE_PREFIX}${id}`;
}

export function normalizeResultClass(value) {
  if (value === "ok" || value === "5xx" || value === "4xx" || value === NOT_REPORTED) return value;
  if (typeof value === "string" && FOUR_XX.has(Number(value))) return value;
  if (typeof value === "string" && TOOL_CODES.has(value)) return value;
  if (typeof value === "string" && value === "other") return "other";
  return "other";
}

export function resultClassFromOutcome({ outcome, statusCode } = {}) {
  if (outcome?.kind === "tool") {
    return typeof outcome.code === "string" && TOOL_CODES.has(outcome.code) ? outcome.code : "other";
  }
  const status = Number(outcome?.status ?? statusCode);
  if (!Number.isInteger(status) || status < 100) return NOT_REPORTED;
  if (status < 400) return "ok";
  if (status >= 500) return "5xx";
  return FOUR_XX.has(status) ? String(status) : "4xx";
}

function sessionIdFor(wallet, mcpSessionId) {
  const normalized = String(wallet ?? "").trim().toLowerCase();
  if (WALLET_RE.test(normalized)) return `wallet:${normalized}`;
  const sessionId = String(mcpSessionId ?? "").trim().toLowerCase();
  if (SESSION_ID_RE.test(sessionId)) return `mcp:${sessionId}`;
  return undefined;
}

function publicRecord(record) {
  return {
    id: record.id,
    kind: record.kind,
    stitched: true,
    firstSeenMs: record.firstSeenMs,
    lastSeenMs: record.lastSeenMs,
    clientName: record.clientName,
    clientVersion: record.clientVersion,
    protocolVersion: record.protocolVersion,
    furthestStage: record.furthestStage,
    clientNameSource: record.clientNameSource ?? NOT_REPORTED,
    stepsDropped: record.stepsDropped,
    stepsTruncated: record.stepsDropped > 0,
    steps: record.steps.map((step) => ({ ...step }))
  };
}

function unavailableTrail(reason) {
  return {
    schemaVersion: ARRIVAL_SESSION_SCHEMA,
    unavailable: reason ?? "arrival session trail could not be read",
    preAuth: { stitched: false, count: NOT_REPORTED, note: PREAUTH_NOTE },
    droppedRecords: NOT_REPORTED,
    sessions: null
  };
}

function boundedText(value, max) {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/[\u0000-\u001f]/gu, "");
  if (!text) return undefined;
  return text.slice(0, max);
}

function normalizeStored(entry) {
  if (typeof entry?.id !== "string" || !entry.id.startsWith("wallet:") && !entry.id.startsWith("mcp:")) {
    return undefined;
  }
  const steps = Array.isArray(entry.steps) ? entry.steps.slice(-SESSION_STEP_CAP).map((step) => ({
    atMs: Number(step?.atMs) || 0,
    door: step?.door === "http" ? "http" : "mcp",
    name: boundedText(step?.name, 120) ?? NOT_REPORTED,
    resultClass: normalizeResultClass(step?.resultClass)
  })) : [];
  return {
    id: entry.id,
    kind: entry.id.startsWith("wallet:") ? "wallet" : "mcp_session",
    stitched: true,
    firstSeenMs: Number(entry.firstSeenMs) || 0,
    lastSeenMs: Number(entry.lastSeenMs) || 0,
    clientName: boundedText(entry.clientName, 64) ?? NOT_REPORTED,
    clientVersion: boundedText(entry.clientVersion, 32) ?? NOT_REPORTED,
    protocolVersion: boundedText(entry.protocolVersion, 32) ?? NOT_REPORTED,
    furthestStage: ARRIVAL_STAGES.includes(entry.furthestStage) ? entry.furthestStage : NOT_REPORTED,
    clientNameSource: ["declared", "user-agent"].includes(entry.clientNameSource) ? entry.clientNameSource : NOT_REPORTED,
    steps,
    stepsDropped: Number.isSafeInteger(entry.stepsDropped) && entry.stepsDropped > 0 ? entry.stepsDropped : 0
  };
}
