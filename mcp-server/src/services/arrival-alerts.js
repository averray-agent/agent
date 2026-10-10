import { createHash } from "node:crypto";

import { SelfIdentityRegistry } from "../core/self-identity-registry.js";

export const NOT_REPORTED = "not reported";
export const ARRIVAL_ALERT_SCHEMA = "averray.arrival-alerts.v1";
export const ARRIVAL_ALERT_COOLDOWN_MS = 15 * 60 * 1_000;
export const ARRIVAL_ALERT_SEEN_CAP = 2_000;
export const CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY = 3;
export const CLIENT_FIRSTS_WALLET_CAP = 2_000;
export const SUPPRESSED_SUBJECT_CAP = 500;
const DAY_MS = 24 * 60 * 60 * 1_000;
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
 * Only a queued milestone flushes immediately. Suppressed subjects, the
 * summary count, and other counters wait for the 30s timer. `stop()` flushes
 * those counters on a normal shutdown; a hard kill can still drop the last interval.
 * Concurrent backend processes overwrite `seen` (last write wins). That is
 * acceptable with one backend; a second process can drop or revive a milestone.
 *
 * Client-name firsts are capped per wallet per UTC day (`floor(nowMs / 86400000)`),
 * not a rolling 24h. Three names before midnight and three different names
 * after it are six alertable firsts. Previous UTC days are dropped on write
 * and on load. The map keeps at most 2,000 wallets; the rest are evicted
 * oldest day first. Each wallet stores those names as the first 8 hex digits
 * of sha256(`name@version`), so one name uses one slot.
 * `clientNameFirstEventsOverCap` counts later requests, not distinct names.
 * Suppressed subjects are remembered up to 500. The next 500 distinct subjects
 * are remembered as the same 8-hex hash and counted once each in
 * `suppressedSubjectOverflow`. Subjects beyond that are not remembered; each
 * request counts as an event, the same way the client-name counter does.
 * Neither case flushes the blob. Worst case is about 523 KB: 2,000 wallet-day
 * records, 2,000 seen keys, 500 suppressed subjects, 500 overflow hashes, and
 * 50 pending alerts.
 */
export class ArrivalAlerts {
  constructor({
    stateStore,
    sessionTrail,
    identityRegistry,
    now = () => Date.now(),
    cooldownMs = ARRIVAL_ALERT_COOLDOWN_MS,
    flushIntervalMs = 30_000,
    schedule = defaultSchedule,
    clearSchedule = (timer) => clearTimeout(timer)
  } = {}) {
    this.stateStore = stateStore;
    this.sessionTrail = sessionTrail;
    this.identityRegistry = identityRegistry instanceof SelfIdentityRegistry
      ? identityRegistry
      : new SelfIdentityRegistry();
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.flushIntervalMs = flushIntervalMs;
    this.schedule = schedule;
    this.clearSchedule = clearSchedule;
    this.suppressed = 0;
    this.suppressedSubjects = new Set();
    this.suppressedOverflowSubjects = new Set();
    this.suppressedSubjectOverflow = 0;
    this.clientFirsts = new Map();
    this.clientNameFirstEventsOverCap = 0;
    this.clientFirstsEvicted = 0;
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
    this.countersDirty = false;
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
      this.plannedSlots = 0;
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
      const planned = [];
      const suppressed = [];
      const take = (kind, subject) => {
        const how = this.classifyArrival(kind, subject);
        if (how === "queue") planned.push([kind, subject]);
        else if (how === "suppress") suppressed.push([kind, subject]);
      };
      if (authenticated && clientActor === "external" && name) {
        const subject = `${name}@${version ?? "unknown"}`;
        if (this.admitClientFirst(normalizedWallet, subject, nowMs)) take("external_client_first", subject);
      }
      if (authenticated && success && walletActor === "external") {
        take("external_wallet_first", normalizedWallet);
        if (stage === "claimed") take("external_wallet_first_claim", normalizedWallet);
        if (stage === "submitted") take("external_wallet_first_submit", normalizedWallet);
      }
      const plain = { trail: NOT_REPORTED, trailNote: "no session record" };
      for (const [kind, subject] of suppressed) this.consider(nowMs, kind, subject, plain);
      // Persist only a record a new alert is about to link, and skip a record
      // that is already stored at this revision. Repeat signed-in traffic keeps
      // the 30s trail batch.
      if (planned.length > 0) {
        if (trailId && this.sessionTrail?.needsPersist?.(trailId)) {
          await this.sessionTrail.persist(trailId);
        }
        const trailLink = await this.resolveTrail(trailId);
        for (const [kind, subject] of planned) this.consider(nowMs, kind, subject, trailLink);
      }
      this.release(nowMs);
      if (this.dirty) await this.maybeFlush(true);
    } catch {
      // An alert must not change the visit it describes.
    }
  }

  classifyArrival(kind, subject) {
    const key = `${kind}:${subject}`;
    if (this.seen.has(key)) return "seen";
    const queued = this.pending.filter((alert) => alert.kind !== "suppressed_firsts").length + this.plannedSlots;
    if (this.seen.size + this.plannedSlots >= ARRIVAL_ALERT_SEEN_CAP || queued >= PENDING_CAP) return "suppress";
    this.plannedSlots = (this.plannedSlots ?? 0) + 1;
    return "queue";
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
      trailId: trailLink?.trailId ?? null,
      trail: trailLink?.trail === "linked" ? "linked" : NOT_REPORTED,
      href: trailLink?.trail === "linked" ? trailLink.href : null,
      ...(trailLink?.trail === "linked" ? {} : { trailNote: trailLink?.trailNote ?? "no session record" })
    });
    this.dirty = true;
  }

  noteSuppressed(nowMs, key) {
    this.saturated = true;
    if (this.suppressedSubjects.has(key)) return;
    const overflowKey = shortHash(key);
    if (this.suppressedOverflowSubjects.has(overflowKey)) return;
    if (this.suppressedSubjects.size < SUPPRESSED_SUBJECT_CAP) {
      this.suppressedSubjects.add(key);
    } else if (this.suppressedOverflowSubjects.size < SUPPRESSED_SUBJECT_CAP) {
      this.suppressedOverflowSubjects.add(overflowKey);
      this.suppressedSubjectOverflow += 1;
    } else {
      // Not remembered. Each request counts, same as clientNameFirstEventsOverCap.
      this.suppressedSubjectOverflow += 1;
    }
    this.suppressed += 1;
    if (this.seen.size >= ARRIVAL_ALERT_SEEN_CAP) this.untrackedFirsts += 1;
    this.upsertSummary(nowMs);
    this.countersDirty = true;
    this.armCounterTimer();
  }

  admitClientFirst(wallet, subject, nowMs) {
    const day = Math.floor(nowMs / DAY_MS);
    this.pruneClientFirsts(day);
    const key = wallet || "none";
    let bucket = this.clientFirsts.get(key);
    if (!bucket || bucket.day !== day) {
      bucket = { day, names: new Set() };
      this.clientFirsts.set(key, bucket);
    }
    const slot = clientNameSlot(subject);
    if (bucket.names.has(slot)) return true;
    if (bucket.names.size >= CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY) {
      // Events, not distinct names. A repeat of the same over-cap name counts again.
      this.clientNameFirstEventsOverCap += 1;
      this.countersDirty = true;
      this.armCounterTimer();
      return false;
    }
    bucket.names.add(slot);
    this.capClientFirsts();
    return true;
  }

  pruneClientFirsts(day) {
    for (const [wallet, bucket] of this.clientFirsts) {
      if (bucket.day !== day) this.clientFirsts.delete(wallet);
    }
  }

  capClientFirsts() {
    while (this.clientFirsts.size > CLIENT_FIRSTS_WALLET_CAP) {
      let oldestKey;
      let oldestDay = Infinity;
      for (const [wallet, bucket] of this.clientFirsts) {
        if (bucket.day < oldestDay) {
          oldestDay = bucket.day;
          oldestKey = wallet;
        }
      }
      if (!oldestKey) return;
      this.clientFirsts.delete(oldestKey);
      this.clientFirstsEvicted += 1;
      this.countersDirty = true;
      this.armCounterTimer();
    }
  }

  armCounterTimer() {
    if (this.counterTimer || !this.countersDirty) return;
    const timer = this.schedule(() => {
      this.counterTimer = undefined;
      void this.maybeFlush(false).catch(() => undefined);
    }, this.flushIntervalMs);
    timer?.unref?.();
    this.counterTimer = timer;
  }

  async stop() {
    if (this.counterTimer) {
      this.clearSchedule(this.counterTimer);
      this.counterTimer = undefined;
    }
    if (!this.dirty && !this.countersDirty) return;
    await this.writeState();
  }

  async close() {
    return this.stop();
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
        return { trail: NOT_REPORTED, trailId, trailNote: "no session record" };
      }
      if (record.persisted !== true) {
        return { trail: NOT_REPORTED, trailId, trailNote: "unpersisted" };
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
        firstsNoLongerTracked: NOT_REPORTED,
        clientNameFirstEventsOverCap: NOT_REPORTED,
        clientFirstsEvicted: NOT_REPORTED,
        suppressedSubjectOverflow: NOT_REPORTED
      };
    }
    this.release(this.now());
    if (this.dirty || this.countersDirty) await this.maybeFlush(false).catch(() => undefined);
    return {
      schemaVersion: ARRIVAL_ALERT_SCHEMA,
      generatedAtMs: this.now(),
      cooldownMs: this.cooldownMs,
      saturated: this.saturated,
      suppressed: this.suppressed,
      firstsNoLongerTracked: this.untrackedFirsts,
      clientNameFirstEventsOverCap: this.clientNameFirstEventsOverCap,
      clientFirstsEvicted: this.clientFirstsEvicted,
      suppressedSubjectOverflow: this.suppressedSubjectOverflow,
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
      const storedSubjects = Array.isArray(stored?.suppressedSubjects)
        ? stored.suppressedSubjects.filter((key) => typeof key === "string")
        : [];
      this.suppressedSubjects = new Set(storedSubjects.slice(0, SUPPRESSED_SUBJECT_CAP));
      const storedOverflow = Array.isArray(stored?.suppressedOverflowSubjects)
        ? stored.suppressedOverflowSubjects.filter((key) => typeof key === "string" && /^[0-9a-f]{8}$/u.test(key))
        : [];
      this.suppressedOverflowSubjects = new Set(storedOverflow.slice(0, SUPPRESSED_SUBJECT_CAP));
      const trimmed = Math.max(0, storedSubjects.length - SUPPRESSED_SUBJECT_CAP);
      this.suppressedSubjectOverflow = (Number.isSafeInteger(stored?.suppressedSubjectOverflow)
        && stored.suppressedSubjectOverflow >= 0
        ? stored.suppressedSubjectOverflow
        : 0) + trimmed;
      this.clientNameFirstEventsOverCap = Number.isSafeInteger(stored?.clientNameFirstEventsOverCap)
        && stored.clientNameFirstEventsOverCap >= 0
        ? stored.clientNameFirstEventsOverCap
        : (Number.isSafeInteger(stored?.clientFirstsCounted) && stored.clientFirstsCounted >= 0
          ? stored.clientFirstsCounted
          : 0);
      this.clientFirstsEvicted = Number.isSafeInteger(stored?.clientFirstsEvicted) && stored.clientFirstsEvicted >= 0
        ? stored.clientFirstsEvicted
        : 0;
      this.clientFirsts = new Map();
      for (const entry of Array.isArray(stored?.clientFirsts) ? stored.clientFirsts : []) {
        const day = Number(entry?.day);
        const names = Array.isArray(entry?.names)
          ? entry.names.filter((name) => typeof name === "string").slice(0, CLIENT_NAME_FIRSTS_PER_WALLET_PER_DAY).map(clientNameSlot)
          : [];
        if (!entry?.wallet || !Number.isFinite(day)) continue;
        this.clientFirsts.set(String(entry.wallet), { day, names: new Set(names) });
      }
      this.pruneClientFirsts(Math.floor(this.now() / DAY_MS));
      this.capClientFirsts();
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
    if (!this.dirty && !this.countersDirty) return;
    const nowMs = this.now();
    // A queued alert flushes now. Counters and suppressed subjects wait.
    if (!(force && this.dirty) && nowMs - this.lastFlushMs < this.flushIntervalMs) return;
    await this.writeState();
  }

  async writeState() {
    this.lastFlushMs = this.now();
    this.dirty = false;
    this.countersDirty = false;
    if (this.counterTimer) {
      this.clearSchedule(this.counterTimer);
      this.counterTimer = undefined;
    }
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
        suppressedOverflowSubjects: [...this.suppressedOverflowSubjects],
        suppressedSubjectOverflow: this.suppressedSubjectOverflow,
        clientNameFirstEventsOverCap: this.clientNameFirstEventsOverCap,
        clientFirstsEvicted: this.clientFirstsEvicted,
        clientFirsts: [...this.clientFirsts].map(([wallet, bucket]) => ({
          wallet,
          day: bucket.day,
          names: [...bucket.names]
        })),
        summaryWindowStartMs: this.summaryWindowStartMs ?? null
      });
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
}

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function clientNameSlot(value) {
  if (typeof value === "string" && /^[0-9a-f]{8}$/u.test(value)) return value;
  return shortHash(value);
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
