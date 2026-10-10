export const NOT_REPORTED = "not reported";
export const ARRIVAL_ALERT_SCHEMA = "averray.arrival-alerts.v1";
export const ARRIVAL_ALERT_COOLDOWN_MS = 15 * 60 * 1_000;
export const ARRIVAL_ALERT_SEEN_CAP = 2_000;
const STATE_SCOPE = "arrival-alerts";
const DELIVERED_CAP = 100;
const PENDING_CAP = 50;

const KINDS = new Set([
  "external_client_first",
  "external_wallet_first",
  "external_wallet_first_claim",
  "external_wallet_first_submit"
]);

/**
 * Operator-facing arrival milestones. This service records and rate-limits.
 * It does not send. The monitor alert bridge in depre-dev/averray-reference-agent
 * (services/slack-operator/src/alert-bridge.ts) is the sending side.
 */
export class ArrivalAlerts {
  constructor({
    stateStore,
    now = () => Date.now(),
    cooldownMs = ARRIVAL_ALERT_COOLDOWN_MS,
    flushIntervalMs = 30_000
  } = {}) {
    this.stateStore = stateStore;
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.flushIntervalMs = flushIntervalMs;
    this.seen = new Set();
    this.pending = [];
    this.ready = [];
    this.lastReadyAtMs = 0;
    this.saturated = false;
    this.loaded = false;
    this.loadFailed = null;
    this.loadPromise = null;
    this.dirty = false;
    this.lastFlushMs = 0;
  }

  async note({
    actor,
    wallet,
    clientInfo,
    stage,
    mcpSessionId,
    nowMs = this.now()
  } = {}) {
    try {
      if (actor !== "external" && actor !== "client" && actor !== "anonymous") return;
      if (!(await this.ensureLoaded())) return;
      const trailId = trailIdFor(wallet, mcpSessionId);
      const name = bounded(clientInfo?.name, 64)?.toLowerCase();
      const version = bounded(clientInfo?.version, 32)?.toLowerCase();
      if (name) this.consider(nowMs, "external_client_first", `${name}@${version ?? "unknown"}`, trailId);
      if (wallet) this.consider(nowMs, "external_wallet_first", wallet, trailId ?? `wallet:${wallet}`);
      if (wallet && stage === "claimed") {
        this.consider(nowMs, "external_wallet_first_claim", wallet, trailId ?? `wallet:${wallet}`);
      }
      if (wallet && stage === "submitted") {
        this.consider(nowMs, "external_wallet_first_submit", wallet, trailId ?? `wallet:${wallet}`);
      }
      this.release(nowMs);
      if (this.dirty) await this.maybeFlush();
    } catch {
      // An alert must not change the visit it describes.
    }
  }

  consider(nowMs, kind, subject, trailId) {
    if (!KINDS.has(kind) || !subject) return;
    const key = `${kind}:${subject}`;
    if (this.seen.has(key)) return;
    if (this.seen.size >= ARRIVAL_ALERT_SEEN_CAP) {
      this.saturated = true;
      this.dirty = true;
      return;
    }
    this.seen.add(key);
    if (this.pending.length >= PENDING_CAP) {
      this.saturated = true;
      this.dirty = true;
      return;
    }
    this.pending.push({
      id: key,
      kind,
      subject,
      atMs: nowMs,
      status: "pending",
      trailId: trailId ?? null,
      trail: trailId ? "linked" : NOT_REPORTED,
      href: trailId ? `/admin/arrivals/sessions?id=${encodeURIComponent(trailId)}` : null
    });
    this.dirty = true;
  }

  release(nowMs) {
    if (this.pending.length === 0) return;
    if (this.lastReadyAtMs && nowMs - this.lastReadyAtMs < this.cooldownMs) return;
    const next = this.pending.shift();
    next.status = "ready";
    next.readyAtMs = nowMs;
    this.ready.push(next);
    if (this.ready.length > DELIVERED_CAP) this.ready.splice(0, this.ready.length - DELIVERED_CAP);
    this.lastReadyAtMs = nowMs;
    this.dirty = true;
  }

  async list() {
    if (!(await this.ensureLoaded())) {
      return {
        schemaVersion: ARRIVAL_ALERT_SCHEMA,
        unavailable: this.loadFailed ?? "arrival alerts could not be read",
        ready: null,
        pending: null,
        saturated: NOT_REPORTED
      };
    }
    this.release(this.now());
    if (this.dirty) await this.maybeFlush().catch(() => undefined);
    return {
      schemaVersion: ARRIVAL_ALERT_SCHEMA,
      generatedAtMs: this.now(),
      cooldownMs: this.cooldownMs,
      saturated: this.saturated,
      sending: "monitor_alert_bridge",
      ready: this.ready.map(publicAlert),
      pending: this.pending.map(publicAlert)
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
      this.seen = new Set(Array.isArray(stored?.seen) ? stored.seen.filter((key) => typeof key === "string") : []);
      this.pending = Array.isArray(stored?.pending) ? stored.pending.filter(validAlert) : [];
      this.ready = Array.isArray(stored?.ready) ? stored.ready.filter(validAlert) : [];
      this.lastReadyAtMs = Number(stored?.lastReadyAtMs) || 0;
      this.saturated = stored?.saturated === true;
      this.loaded = true;
      this.loadFailed = null;
    } catch (error) {
      this.loaded = false;
      this.loadFailed = "arrival alerts could not be read";
      throw error;
    }
  }

  async maybeFlush() {
    if (!this.dirty) return;
    const nowMs = this.now();
    if (nowMs - this.lastFlushMs < this.flushIntervalMs) return;
    this.lastFlushMs = nowMs;
    this.dirty = false;
    try {
      await this.stateStore?.upsertServiceState?.(STATE_SCOPE, {
        seen: [...this.seen],
        pending: this.pending,
        ready: this.ready,
        lastReadyAtMs: this.lastReadyAtMs,
        saturated: this.saturated
      });
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
}

function trailIdFor(wallet, mcpSessionId) {
  if (typeof wallet === "string" && /^0x[0-9a-f]{40}$/u.test(wallet)) return `wallet:${wallet}`;
  const sessionId = String(mcpSessionId ?? "").trim().toLowerCase();
  if (/^[a-z0-9-]{1,80}$/u.test(sessionId)) return `mcp:${sessionId}`;
  return undefined;
}

function bounded(value, max) {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/[\u0000-\u001f]/gu, "").slice(0, max);
  return text || undefined;
}

function publicAlert(alert) {
  return {
    id: alert.id,
    kind: alert.kind,
    subject: alert.subject,
    atMs: alert.atMs,
    status: alert.status,
    readyAtMs: alert.readyAtMs,
    trail: alert.trail,
    trailId: alert.trailId,
    href: alert.href
  };
}

function validAlert(alert) {
  return alert && KINDS.has(alert.kind) && typeof alert.id === "string" && typeof alert.subject === "string";
}
