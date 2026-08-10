import { createHash } from "node:crypto";

export const ARRIVALS_SCHEMA_VERSION = "averray.arrivals.v1";
const STATE_SCOPE = "arrival-observatory";
const DEFAULT_MAX_CLIENTS = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_LOAD_RETRY_INTERVAL_MS = 10_000;
const UNREADABLE = "arrival state could not be read";

/**
 * Our own traffic, so the funnel can say what OUTSIDERS did.
 *
 * The settlement composition split already does this for jobs — platform
 * verification runs are counted apart from external work, because a settlement
 * count alone flatters us. Arrivals had no equivalent, so every canary, smoke
 * test and adversarial probe landed in the funnel indistinguishable from a real
 * agent, corrupting the one signal built to read demand.
 *
 * Marking is EXPLICIT and unmarked traffic counts as external. That direction is
 * deliberate: the failure we must never have is overstating outside interest.
 * Someone falsely declaring one of our names only removes themselves from the
 * external count, which costs them and tells us nothing we would believe anyway.
 *
 * The mark is spent in three places: the per-client `self` flag, the `actor`
 * metric label, and the funnel split. It has to reach the funnel too — a mark
 * that only decorates the client list still lets a headline count our probes
 * as arrivals, which is the exact evidence-manufacturing this exists to stop.
 */
const SELF_CLIENT_PREFIX = "averray-";

/**
 * Ordered funnel an arriving agent walks. "Furthest reached" is the max index
 * a client ever attained, so a client that browses again after claiming does
 * not appear to regress.
 */
export const ARRIVAL_STAGES = Object.freeze([
  "reached",
  "browsed",
  "evaluated",
  "identified",
  "authenticated",
  "claimed",
  "submitted"
]);

/**
 * Which stage each tool demonstrates. Deliberately maps intent, not mechanics:
 * fetchAuthNonce is "identified" because the caller has revealed a wallet it
 * intends to use, which is the first step past anonymous browsing and the one
 * nothing had ever taken when this was built.
 */
const TOOL_STAGE = Object.freeze({
  getPlatformCapabilities: "browsed",
  listJobs: "browsed",
  getJobDefinition: "browsed",
  preflightJob: "evaluated",
  estimateNetReward: "evaluated",
  explainEligibility: "evaluated",
  validateJobSubmission: "evaluated",
  fetchAuthNonce: "identified",
  verifySiwe: "authenticated",
  refreshAuthToken: "authenticated",
  claimJob: "claimed",
  submitWork: "submitted"
});

/**
 * Records what happens at the MCP front door.
 *
 * Built because we could not tell an aggregator crawler from a real agent:
 * Caddy logs only errors, and http_requests_total carries path and status but
 * no client. Roughly twenty /mcp requests were unattributable, and no
 * /auth/nonce had ever been observed at all.
 *
 * Three rules this must not break, in priority order:
 *
 *   1. It must never throw into the request path. Observability that can take
 *      the door down is worse than no observability. Every public method
 *      swallows its own errors.
 *   2. It must not add a round trip per call. State is aggregated in memory
 *      and flushed on a debounce, so a busy client costs no extra I/O.
 *   3. It must not retain personal data. `clientInfo` is self-declared by the
 *      caller and kept verbatim; IP addresses are salted-hashed to a short
 *      prefix used only to tell one anonymous caller from another. The
 *      snapshot is served from a public monitor route, so there is nothing
 *      here that could not already be published.
 */
export class ArrivalObservatory {
  constructor({
    stateStore,
    metrics,
    now = () => Date.now(),
    hashSalt = "averray-arrivals",
    selfClients = resolveSelfClients(),
    maxClients = DEFAULT_MAX_CLIENTS,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    loadRetryIntervalMs = DEFAULT_LOAD_RETRY_INTERVAL_MS
  } = {}) {
    this.stateStore = stateStore;
    this.metrics = metrics;
    this.now = now;
    this.hashSalt = String(hashSalt);
    this.selfClients = selfClients instanceof Set ? selfClients : new Set(selfClients ?? []);
    this.maxClients = Number(maxClients) > 0 ? Number(maxClients) : DEFAULT_MAX_CLIENTS;
    this.flushIntervalMs = Number(flushIntervalMs) >= 0 ? Number(flushIntervalMs) : DEFAULT_FLUSH_INTERVAL_MS;
    this.loadRetryIntervalMs =
      Number(loadRetryIntervalMs) >= 0 ? Number(loadRetryIntervalMs) : DEFAULT_LOAD_RETRY_INTERVAL_MS;
    this.clients = new Map();
    // Three counters rather than one. `totals` is every call that ever landed;
    // the other two say which of those were outsiders and which were ours.
    // Kept apart at write time because the actor of a past call cannot be
    // recovered later — the client table is capped and evicts.
    this.totals = emptyTotals();
    this.totalsExternal = emptyTotals();
    this.totalsSelf = emptyTotals();
    this.loaded = false;
    // Load OUTCOME, tracked apart from `loaded` so a failed read can never
    // masquerade as a completed one. See ensureLoaded.
    this.loadFailed = null;
    this.loadPromise = null;
    this.nextLoadAttemptMs = 0;
    this.dirty = false;
    this.lastFlushMs = 0;
    this.startedAtMs = this.now();
  }

  /** First contact: a handshake, or any request that reaches the door. */
  async recordReach({ era, clientInfo, ip } = {}) {
    await this.record({ stage: "reached", era, clientInfo, ip });
  }

  /** A tool call. Unknown tool names are counted as reach and nothing more. */
  async recordTool({ tool, era, clientInfo, ip } = {}) {
    await this.record({ stage: TOOL_STAGE[tool] ?? "reached", era, clientInfo, ip, tool });
  }

  async record({ stage, era, clientInfo, ip, tool } = {}) {
    try {
      if (!ARRIVAL_STAGES.includes(stage)) return;
      // Counting onto a baseline we failed to read would invent a total that
      // was never measured. Drop the observation instead; the snapshot says so.
      if (!(await this.ensureLoaded())) return;

      const identity = normalizeClientInfo(clientInfo);
      const actor = this.classifyActor(identity);
      const key = identity
        ? `client:${identity.name}@${identity.version}`
        : `anon:${this.hashIp(ip)}`;
      const nowMs = this.now();

      let entry = this.clients.get(key);
      if (!entry) {
        entry = {
          key,
          name: identity?.name ?? null,
          version: identity?.version ?? null,
          era: era ?? null,
          self: actor === "self",
          firstSeenMs: nowMs,
          lastSeenMs: nowMs,
          furthestStage: stage,
          calls: 0,
          tools: {}
        };
        this.clients.set(key, entry);
      }

      entry.lastSeenMs = nowMs;
      entry.calls += 1;
      if (era) entry.era = era;
      if (tool) entry.tools[tool] = (entry.tools[tool] ?? 0) + 1;
      if (stageRank(stage) > stageRank(entry.furthestStage)) {
        entry.furthestStage = stage;
      }

      this.totals[stage] += 1;
      // Same fail-safe direction as the client marking above: "anonymous" is
      // not "ours", so it lands in the external bucket. Only an explicit
      // self-declaration keeps a call out of the number we read as demand.
      (actor === "self" ? this.totalsSelf : this.totalsExternal)[stage] += 1;
      // Label set is deliberately tiny: a self-declared client name is
      // attacker-controlled and unbounded, so it never becomes a label. The
      // names live in the snapshot instead, where cardinality costs nothing.
      this.metrics?.counter?.(
        "mcp_arrival_stage_total",
        "MCP front-door funnel stages by declared-client presence",
        ["stage", "actor"]
      )?.inc({ stage, actor });

      this.evictOverflow();
      this.dirty = true;
      await this.maybeFlush();
    } catch {
      // Never surface an observability fault to the caller.
    }
  }

  async getSnapshot() {
    try {
      // A funnel of zeros reads as "nobody arrived". When the state behind it
      // is unreadable that is a claim we have not earned, so the snapshot names
      // the instrument failure instead of quietly serving in-memory counts.
      if (!(await this.ensureLoaded())) return this.unavailableSnapshot();
      const clients = [...this.clients.values()]
        .sort((left, right) => right.lastSeenMs - left.lastSeenMs)
        .map((entry) => ({ ...entry, tools: { ...entry.tools } }));
      return {
        schemaVersion: ARRIVALS_SCHEMA_VERSION,
        generatedAtMs: this.now(),
        observingSinceMs: this.startedAtMs,
        // `funnel` is EVERY call, ours included. It keeps that meaning so
        // averray.arrivals.v1 readers parse the same number they always did,
        // which is also why this stays v1 — the split is added, not swapped.
        // `funnelExternal` is the only one that answers "did an OUTSIDER do
        // this?", so it is the number a headline may render. `funnelSelf` is
        // kept because confirming our own probes actually ran is worth
        // something; it just is not evidence of demand.
        funnel: { ...this.totals },
        funnelExternal: { ...this.totalsExternal },
        funnelSelf: { ...this.totalsSelf },
        distinct: {
          declared: clients.filter((entry) => entry.name).length,
          anonymous: clients.filter((entry) => !entry.name).length,
          self: clients.filter((entry) => entry.self).length,
          furthest: furthestStageAcross(clients),
          // The number that answers "has an OUTSIDER looked?" — our own probes
          // must never be able to move it.
          furthestExternal: furthestStageAcross(clients.filter((entry) => !entry.self))
        },
        clients
      };
    } catch {
      return this.unavailableSnapshot();
    }
  }

  /**
   * Every number nulled and the failure named. The ops board renders this as a
   * broken instrument; a seven-zero funnel it would render as measured silence.
   *
   * All THREE funnels are nulled. The external one especially: a zero there
   * reads as "no outsider arrived", which is the single most misleading thing
   * this service could say about itself.
   */
  unavailableSnapshot() {
    return {
      schemaVersion: ARRIVALS_SCHEMA_VERSION,
      generatedAtMs: this.now(),
      observingSinceMs: this.startedAtMs,
      funnel: nullTotals(),
      funnelExternal: nullTotals(),
      funnelSelf: nullTotals(),
      distinct: { declared: null, anonymous: null, self: null, furthest: null, furthestExternal: null },
      clients: [],
      unavailable: this.loadFailed ?? UNREADABLE
    };
  }

  /**
   * Reads persisted state once, and — the part that matters — remembers when
   * that read FAILED rather than recording it as done.
   *
   * `loaded` used to be set before the await purely to stop a concurrent second
   * read, so a store that was down at startup left the observatory looking
   * loaded with nothing in it: the first caller absorbed the throw and every
   * snapshot afterwards served in-memory counts as though they were measured.
   * The in-flight promise now does the de-duplication, which it can do without
   * lying about the outcome.
   *
   * @returns {Promise<boolean>} whether state is loaded and the counts are real.
   */
  async ensureLoaded() {
    if (this.loaded) return true;
    // Retry a failed load later, but no more than once an interval: an outage
    // must not turn every front-door request into a round trip to the store.
    if (this.loadFailed && this.now() < this.nextLoadAttemptMs) return false;
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
      restoreTotals(this.totals, stored?.totals);
      // State written before the split carries `totals` alone. The actor of
      // those calls is genuinely unknown, and unknown must not be spent as
      // external — that is the one direction this module may not fail in. So
      // the total is restored in full and both halves of the split start at
      // zero, leaving `funnel` larger than external + self until the pre-split
      // history ages out of the picture. An outsider who arrived before the
      // upgrade is still visible in distinct.furthestExternal, which is derived
      // from the client table rather than from these counters.
      restoreTotals(this.totalsExternal, stored?.totalsExternal);
      restoreTotals(this.totalsSelf, stored?.totalsSelf);
      for (const entry of Array.isArray(stored?.clients) ? stored.clients : []) {
        if (typeof entry?.key === "string") this.clients.set(entry.key, entry);
      }
      if (Number.isFinite(stored?.observingSinceMs)) this.startedAtMs = stored.observingSinceMs;
      this.loaded = true;
      this.loadFailed = null;
    } catch (error) {
      this.loadFailed = UNREADABLE;
      this.nextLoadAttemptMs = this.now() + this.loadRetryIntervalMs;
      throw error;
    }
  }

  async maybeFlush(force = false) {
    if (!this.dirty) return;
    const nowMs = this.now();
    if (!force && nowMs - this.lastFlushMs < this.flushIntervalMs) return;
    this.lastFlushMs = nowMs;
    this.dirty = false;
    await this.stateStore?.upsertServiceState?.(STATE_SCOPE, {
      observingSinceMs: this.startedAtMs,
      totals: { ...this.totals },
      totalsExternal: { ...this.totalsExternal },
      totalsSelf: { ...this.totalsSelf },
      clients: [...this.clients.values()]
    });
  }

  evictOverflow() {
    if (this.clients.size <= this.maxClients) return;
    const ordered = [...this.clients.values()].sort((left, right) => left.lastSeenMs - right.lastSeenMs);
    for (const entry of ordered.slice(0, this.clients.size - this.maxClients)) {
      this.clients.delete(entry.key);
    }
  }

  classifyActor(identity) {
    if (!identity) return "anonymous";
    const name = identity.name.toLowerCase();
    return name.startsWith(SELF_CLIENT_PREFIX) || this.selfClients.has(name) ? "self" : "client";
  }

  hashIp(ip) {
    const value = typeof ip === "string" && ip.trim() ? ip.trim() : "unknown";
    return createHash("sha256").update(`${this.hashSalt}:${value}`).digest("hex").slice(0, 12);
  }
}

export function resolveSelfClients(env = process.env) {
  return new Set(
    String(env?.ARRIVAL_SELF_CLIENTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function emptyTotals() {
  return Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0]));
}

function nullTotals() {
  return Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, null]));
}

function restoreTotals(target, stored) {
  for (const [stage, value] of Object.entries(stored ?? {})) {
    if (stage in target && Number.isFinite(Number(value))) {
      target[stage] = Number(value);
    }
  }
}

function furthestStageAcross(clients) {
  return clients.reduce(
    (best, entry) => (stageRank(entry.furthestStage) > stageRank(best) ? entry.furthestStage : best),
    ARRIVAL_STAGES[0]
  );
}

export function stageRank(stage) {
  const index = ARRIVAL_STAGES.indexOf(stage);
  return index === -1 ? -1 : index;
}

export function normalizeClientInfo(clientInfo) {
  const name = typeof clientInfo?.name === "string" ? clientInfo.name.trim().slice(0, 64) : "";
  if (!name) return null;
  const version = typeof clientInfo?.version === "string" ? clientInfo.version.trim().slice(0, 32) : "";
  return { name, version: version || "unknown" };
}
