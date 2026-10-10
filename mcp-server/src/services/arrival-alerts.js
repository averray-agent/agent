import { SelfIdentityRegistry } from "../core/self-identity-registry.js";

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
  "external_wallet_first_submit",
  "suppressed_firsts"
]);

/**
 * Operator-facing arrival milestones. This service records and rate-limits.
 * It does not send. The monitor alert bridge in depre-dev/averray-reference-agent
 * (services/slack-operator/src/alert-bridge.ts) is the sending side.
 * A queued milestone is flushed immediately. The 30s interval applies only to
 * a non-forced flush; process death before that flush can drop an unqueued edit.
 * Concurrent backend processes overwrite `seen` (last write wins). That is
 * acceptable with one backend; a second process can drop or revive a milestone.
 */
export class ArrivalAlerts {
  constructor({
    stateStore,
    sessionTrail,
    identityRegistry,
    now = () => Date.now(),
    cooldownMs = ARRIVAL_ALERT_COOLDOWN_MS,
    flushIntervalMs = 30_000
  } = {}) {
    this.stateStore = stateStore;
    this.sessionTrail = sessionTrail;
    this.identityRegistry = identityRegistry instanceof SelfIdentityRegistry
      ? identityRegistry
      : new SelfIdentityRegistry();
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.flushIntervalMs = flushIntervalMs;
    this.suppressed = 0;
    this.suppressedSubjects = new Set();
    this.untrackedFirsts = 0;
    this.summaryWindowStartMs = undefined;
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
    wallet,
    clientInfo,
    stage,
    success = false,
    authenticated = false,
    nowMs = this.now()
  } = {}) {
    try {
      if (!(await this.ensureLoaded())) return;
      // Anonymous pre-auth names are attacker-controlled and must not occupy
      // the dedup set. Client names are classified on their own, so a self or
      // ambiguous name riding an external wallet is not an external client.
      const name = bounded(clientInfo?.name, 64)?.toLowerCase();
      const version = bounded(clientInfo?.version, 32)?.toLowerCase();
      const clientActor = name
        ? this.identityRegistry.classify({ clientInfo: { name, version } }).actor
        : undefined;
      const walletActor = wallet
        ? this.identityRegistry.classify({ wallet }).actor
        : undefined;
      const normalizedWallet = String(wallet ?? "").trim().toLowerCase();
      const trailId = authenticated && normalizedWallet ? `wallet:${normalizedWallet}` : undefined;
      const trailLink = await this.resolveTrail(trailId);
      if (authenticated && clientActor === "external" && name) {
        this.consider(nowMs, "external_client_first", `${name}@${version ?? "unknown"}`, trailLink);
      }
      if (authenticated && success && walletActor === "external") {
        this.consider(nowMs, "external_wallet_first", normalizedWallet, trailLink);
        if (stage === "claimed") this.consider(nowMs, "external_wallet_first_claim", normalizedWallet, trailLink);
        if (stage === "submitted") this.consider(nowMs, "external_wallet_first_submit", normalizedWallet, trailLink);
      }
      this.release(nowMs);
      if (this.dirty) await this.maybeFlush(true);
    } catch {
      // An alert must not change the visit it describes.
    }
  }

  consider(nowMs, kind, subject, trailLink) {
    if (!KINDS.has(kind) || kind === "suppressed_firsts" || !subject) return;
    const key = `${kind}:${subject}`;
    if (this.seen.has(key)) return;
    const queued = this.pending.filter((alert) => alert.kind !== "suppressed_firsts").length;
    if (this.seen.size >= ARRIVAL_ALERT_SEEN_CAP || queued >= PENDING_CAP) {
      this.noteSuppressed(nowMs, key);
      return;
    }
    this.seen.add(key);
    this.pending.push({
      id: key,
      kind,
      subject,
      atMs: nowMs,
      status: "pending",
      trailId: trailLink?.trail === "linked" ? trailLink.trailId : null,
      trail: trailLink?.trail === "linked" ? "linked" : NOT_REPORTED,
      href: trailLink?.trail === "linked" ? trailLink.href : null,
      ...(trailLink?.trail === "linked" ? {} : { trailNote: trailLink?.trailNote ?? "no session record" })
    });
    this.dirty = true;
  }

  noteSuppressed(nowMs, key) {
    if (!this.suppressedSubjects.has(key)) {
      this.suppressedSubjects.add(key);
      this.suppressed += 1;
      if (this.seen.size >= ARRIVAL_ALERT_SEEN_CAP) this.untrackedFirsts += 1;
    }
    this.saturated = true;
    this.upsertSummary(nowMs);
    this.dirty = true;
  }

  upsertSummary(nowMs) {
    if (this.summaryWindowStartMs === undefined) this.summaryWindowStartMs = nowMs;
    const id = `suppressed_firsts:${this.summaryWindowStartMs}:${this.suppressed}`;
    this.pending = this.pending.filter((alert) => alert.kind !== "suppressed_firsts");
    this.ready = this.ready.filter((alert) => alert.kind !== "suppressed_firsts");
    this.pending.push({
      id,
      kind: "suppressed_firsts",
      subject: String(this.suppressed),
      suppressedCount: this.suppressed,
      atMs: nowMs,
      status: "pending",
      trail: NOT_REPORTED,
      trailId: null,
      href: null,
      trailNote: "suppressed; individual session not linked"
    });
  }

  async resolveTrail(trailId) {
    if (!trailId) {
      return { trail: NOT_REPORTED, trailNote: "no authenticated wallet" };
    }
    if (typeof this.sessionTrail?.get !== "function") {
      return { trail: NOT_REPORTED, trailNote: "session trail is not available" };
    }
    try {
      const record = await this.sessionTrail.get(trailId);
      if (record?.unavailable) {
        return { trail: NOT_REPORTED, trailNote: "session trail could not be read" };
      }
      if (!record?.session) {
        return { trail: NOT_REPORTED, trailNote: "no session record" };
      }
      return {
        trail: "linked",
        trailId,
        href: `/admin/arrivals/sessions?id=${encodeURIComponent(trailId)}`
      };
    } catch {
      return { trail: NOT_REPORTED, trailNote: "session trail could not be read" };
    }
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
        saturated: NOT_REPORTED,
        firstsNoLongerTracked: NOT_REPORTED
      };
    }
    this.release(this.now());
    if (this.dirty) await this.maybeFlush().catch(() => undefined);
    return {
      schemaVersion: ARRIVAL_ALERT_SCHEMA,
      generatedAtMs: this.now(),
      cooldownMs: this.cooldownMs,
      saturated: this.saturated,
      suppressed: this.suppressed,
      firstsNoLongerTracked: this.untrackedFirsts,
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
      this.suppressed = Number.isSafeInteger(stored?.suppressed) && stored.suppressed >= 0 ? stored.suppressed : 0;
      this.untrackedFirsts = Number.isSafeInteger(stored?.untrackedFirsts) && stored.untrackedFirsts >= 0
        ? stored.untrackedFirsts
        : 0;
      this.suppressedSubjects = new Set(
        Array.isArray(stored?.suppressedSubjects)
          ? stored.suppressedSubjects.filter((key) => typeof key === "string")
          : []
      );
      const windowStart = Number(stored?.summaryWindowStartMs);
      this.summaryWindowStartMs = Number.isFinite(windowStart) ? windowStart : undefined;
      this.loaded = true;
      this.loadFailed = null;
    } catch (error) {
      this.loaded = false;
      this.loadFailed = "arrival alerts could not be read";
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
      await this.stateStore?.upsertServiceState?.(STATE_SCOPE, {
        seen: [...this.seen],
        pending: this.pending,
        ready: this.ready,
        lastReadyAtMs: this.lastReadyAtMs,
        saturated: this.saturated,
        suppressed: this.suppressed,
        untrackedFirsts: this.untrackedFirsts,
        suppressedSubjects: [...this.suppressedSubjects],
        summaryWindowStartMs: this.summaryWindowStartMs ?? null
      });
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
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
    href: alert.href,
    ...(alert.trailNote ? { trailNote: alert.trailNote } : {}),
    ...(alert.suppressedCount === undefined ? {} : { suppressedCount: alert.suppressedCount })
  };
}

function validAlert(alert) {
  return alert && KINDS.has(alert.kind) && typeof alert.id === "string" && typeof alert.subject === "string";
}
