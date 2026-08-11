import { createHash } from "node:crypto";

export const ARRIVALS_SCHEMA_VERSION = "averray.arrivals.v1";
export const HTTP_ARRIVALS_CUTOVER_AT = "2026-08-11T00:00:00.000Z";
const STATE_SCOPE = "arrival-observatory";
const DEFAULT_MAX_CLIENTS = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_LOAD_RETRY_INTERVAL_MS = 10_000;
const UNREADABLE = "arrival state could not be read";
const WALLET_RE = /^0x[a-fA-F0-9]{40}$/u;

export const ATTRIBUTION_SOURCES = Object.freeze([
  "siwe_wallet",
  "client_name",
  "ip_only"
]);

const HTTP_ROUTE_STAGE = Object.freeze({
  "GET /jobs": "browsed",
  "GET /jobs/definition": "evaluated",
  "GET /jobs/preflight": "evaluated",
  "GET /jobs/estimate-reward": "evaluated",
  "GET /jobs/explain-eligibility": "evaluated",
  "POST /jobs/validate-submission": "evaluated",
  "POST /auth/nonce": "identified",
  "POST /auth/verify": "authenticated",
  "POST /auth/refresh": "authenticated",
  "POST /jobs/claim": "claimed",
  "POST /jobs/submit": "submitted"
});

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
 * Names we present ourselves AND an outsider could present too, so the funnel
 * stops pretending it can tell which one it saw.
 *
 * The declared client name identifies the MCP client SOFTWARE, not the
 * operator. Our own Claude session and a stranger's Claude session both
 * announce themselves as `Anthropic/ClaudeAI`, so no rule over that name can
 * separate them. Observed live on 2026-08-10: `funnelExternal.browsed` read 5
 * while some of the advancing traffic was the operator inspecting the front
 * door through Claude minutes earlier. We inspect our own platform this way
 * often, so every inspection inflated the one number built to read demand.
 *
 * Neither existing bucket is honest about this. Left external, our own
 * inspections manufacture demand evidence. Marked self, we erase the genuine
 * users who reach us through Claude — exactly the arrivals we most want to
 * see. So the traffic goes in a third bucket that claims neither, and it is
 * reported rather than folded into either headline.
 *
 * `Anthropic/ClaudeAI` ships as a default rather than living only in config:
 * the failure mode is a silently inflated number, and a fix that waits on an
 * environment edit in every deployment is a fix that quietly does not happen.
 * `ARRIVAL_AMBIGUOUS_CLIENTS` extends this list; it does not replace it.
 *
 * The bar for adding a name is that WE routinely present it. A shared client
 * name we never use is still just an outsider, and belongs in external.
 */
const AMBIGUOUS_CLIENT_DEFAULTS = Object.freeze(["anthropic/claudeai"]);

/**
 * Why this is a name list and not the IP hash the observatory already computes.
 *
 * A salted address could in principle tell a repeat operator session from a
 * stranger under the same client name. It cannot here, in either topology. A
 * hosted client reaches us from the vendor's own egress, so our session and a
 * stranger's session carry the SAME digest — the discriminator is constant
 * across the exact two populations it would need to separate. A locally run
 * client reaches us from the operator's own network address, which does
 * discriminate, but that is precisely the personally identifying value we are
 * not willing to retain, and it decays anyway across DHCP, VPN and travel, so
 * "ours" would silently drift back into external.
 *
 * The retention objection is decisive on its own. Today an address is hashed
 * ONLY to tell one anonymous caller from another, and is never joined to an
 * identity. Attaching a network fingerprint to a declared name would publish a
 * stable pseudonymous identifier on a world-readable route — and with the
 * default salt the digest is enumerable over the whole IPv4 space, so it is a
 * pseudonym only against someone unwilling to spend the CPU.
 *
 * A name list retains nothing new, is auditable and reversible, and states the
 * true epistemic position: this name is not attributable, so we will not
 * attribute it.
 */

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
    selfWallets = resolveSelfWallets(),
    ambiguousClients = resolveAmbiguousClients(),
    maxClients = DEFAULT_MAX_CLIENTS,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    loadRetryIntervalMs = DEFAULT_LOAD_RETRY_INTERVAL_MS
  } = {}) {
    this.stateStore = stateStore;
    this.metrics = metrics;
    this.now = now;
    this.hashSalt = String(hashSalt);
    this.selfClients = selfClients instanceof Set ? selfClients : new Set(selfClients ?? []);
    this.selfWallets = selfWallets instanceof Set ? selfWallets : new Set(selfWallets ?? []);
    this.ambiguousClients =
      ambiguousClients instanceof Set ? ambiguousClients : new Set(ambiguousClients ?? []);
    this.maxClients = Number(maxClients) > 0 ? Number(maxClients) : DEFAULT_MAX_CLIENTS;
    this.flushIntervalMs = Number(flushIntervalMs) >= 0 ? Number(flushIntervalMs) : DEFAULT_FLUSH_INTERVAL_MS;
    this.loadRetryIntervalMs =
      Number(loadRetryIntervalMs) >= 0 ? Number(loadRetryIntervalMs) : DEFAULT_LOAD_RETRY_INTERVAL_MS;
    this.clients = new Map();
    // Four counters rather than one. `totals` is every call that ever landed;
    // the other three say which of those were outsiders, which were ours, and
    // which arrived under a name that cannot be attributed either way. Kept
    // apart at write time because the actor of a past call cannot be recovered
    // later — the client table is capped and evicts.
    this.totals = emptyTotals();
    this.totalsExternal = emptyTotals();
    this.totalsSelf = emptyTotals();
    this.totalsAmbiguous = emptyTotals();
    // The v1 fields above remain MCP-only forever. This second ledger begins at
    // the HTTP cut-over and is always split by attribution strength; it never
    // publishes a combined headline that lets inferred traffic borrow the
    // credibility of a verified wallet.
    this.agentTotals = emptyAttributionTotals();
    this.agents = new Map();
    this.clientWalletAliases = new Map();
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
  async recordReach({ era, clientInfo, ip, includeAgent = true } = {}) {
    await this.record({ stage: "reached", era, clientInfo, ip, includeAgent });
  }

  /** A tool call. Unknown tool names are counted as reach and nothing more. */
  async recordTool({ tool, era, clientInfo, ip, includeAgent = true } = {}) {
    await this.record({
      stage: TOOL_STAGE[tool] ?? "reached",
      era,
      clientInfo,
      ip,
      tool,
      includeAgent
    });
  }

  /** Records the cross-door half of an MCP call after auth has resolved. */
  async recordAgentTool({ tool, era, clientInfo, ip, wallet } = {}) {
    try {
      if (!(await this.ensureLoaded())) return;
      this.recordAgent({
        stage: TOOL_STAGE[tool] ?? "reached",
        door: "mcp",
        era,
        clientInfo,
        ip,
        tool,
        wallet
      });
      this.dirty = true;
      await this.maybeFlush();
    } catch {
      // Never surface an observability fault to the caller.
    }
  }

  /** Records one HTTP route. Only route handlers call this; health never does. */
  async recordHttp({ method, pathname, wallet, clientInfo, ip } = {}) {
    try {
      if (!(await this.ensureLoaded())) return;
      const route = `${String(method ?? "").toUpperCase()} ${pathname ?? ""}`;
      this.recordAgent({
        stage: HTTP_ROUTE_STAGE[route] ?? "reached",
        door: "http",
        route,
        wallet,
        clientInfo,
        ip
      });
      this.dirty = true;
      await this.maybeFlush();
    } catch {
      // Never surface an observability fault to the caller.
    }
  }

  async record({ stage, era, clientInfo, ip, tool, includeAgent = true } = {}) {
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
          ambiguous: actor === "ambiguous",
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
      // Re-marked on every call, not just at creation. A name that becomes
      // ambiguous only becomes so after entries under it already exist — the
      // live `Anthropic/ClaudeAI` entry is the reason this exists — and an
      // entry that kept its first classification would carry the wrong mark
      // into persistence until it aged out of the table.
      entry.self = actor === "self";
      entry.ambiguous = actor === "ambiguous";
      if (era) entry.era = era;
      if (tool) entry.tools[tool] = (entry.tools[tool] ?? 0) + 1;
      if (stageRank(stage) > stageRank(entry.furthestStage)) {
        entry.furthestStage = stage;
      }

      this.totals[stage] += 1;
      // Same fail-safe direction as the client marking above: "anonymous" is
      // not "ours", so it lands in the external bucket. Only an explicit
      // self-declaration, or a name we have declared unattributable, keeps a
      // call out of the number we read as demand.
      this.totalsFor(actor)[stage] += 1;
      // Label set is deliberately tiny: a self-declared client name is
      // attacker-controlled and unbounded, so it never becomes a label. The
      // names live in the snapshot instead, where cardinality costs nothing.
      this.metrics?.counter?.(
        "mcp_arrival_stage_total",
        "MCP front-door funnel stages by declared-client presence",
        ["stage", "actor"]
      )?.inc({ stage, actor });

      if (includeAgent) {
        this.recordAgent({ stage, door: "mcp", era, clientInfo, ip, tool });
      }

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
        .map((entry) => this.markEntry(entry));
      const agents = [...this.agents.values()]
        .sort((left, right) => right.lastSeenMs - left.lastSeenMs)
        .map((entry) => this.markAgentEntry(entry));
      return {
        schemaVersion: ARRIVALS_SCHEMA_VERSION,
        generatedAtMs: this.now(),
        observingSinceMs: this.startedAtMs,
        // `funnel` is EVERY call, ours included. It keeps that meaning so
        // averray.arrivals.v1 readers parse the same number they always did,
        // which is also why this stays v1 — the buckets are added, not
        // swapped, and `funnelExternal` keeps the meaning it was given: the
        // calls we can say an OUTSIDER drove. It is the only number a headline
        // may render, and it is now narrower, because traffic under a name we
        // also use was never something we could say that about.
        // `funnelSelf` is kept because confirming our own probes actually ran
        // is worth something; it just is not evidence of demand.
        // `funnelAmbiguous` is reported rather than folded into either: it is
        // the traffic we genuinely cannot attribute, and hiding it inside
        // `self` would erase real users who reach us through a shared client.
        funnel: { ...this.totals },
        funnelExternal: { ...this.totalsExternal },
        funnelSelf: { ...this.totalsSelf },
        funnelAmbiguous: { ...this.totalsAmbiguous },
        distinct: {
          declared: clients.filter((entry) => entry.name).length,
          anonymous: clients.filter((entry) => !entry.name).length,
          self: clients.filter((entry) => entry.self).length,
          ambiguous: clients.filter((entry) => entry.ambiguous).length,
          furthest: furthestStageAcross(clients),
          // The number that answers "has an OUTSIDER looked?" — neither our own
          // probes nor a client name we also present may move it.
          furthestExternal: furthestStageAcross(
            clients.filter((entry) => !entry.self && !entry.ambiguous)
          ),
          // Reported alongside, so narrowing the claim does not discard the
          // signal: this may well have been an outsider, and we cannot say.
          furthestAmbiguous: furthestStageAcross(clients.filter((entry) => entry.ambiguous))
        },
        clients,
        crossDoor: {
          cutoverAt: HTTP_ARRIVALS_CUTOVER_AT,
          note: "HTTP arrivals are measured from this cut-over only; there is no backfill, so a post-cut-over increase is coverage rather than growth.",
          funnelByAttributionSource: cloneAttributionTotals(this.agentTotals),
          distinctByAttributionSource: Object.fromEntries(
            ATTRIBUTION_SOURCES.map((source) => [
              source,
              agents.filter((entry) => entry.attributionSource === source).length
            ])
          ),
          furthestByAttributionSource: Object.fromEntries(
            ATTRIBUTION_SOURCES.map((source) => [
              source,
              furthestStageOrNull(agents.filter((entry) => entry.attributionSource === source))
            ])
          ),
          agents
        }
      };
    } catch {
      return this.unavailableSnapshot();
    }
  }

  /**
   * Every number nulled and the failure named. The ops board renders this as a
   * broken instrument; a seven-zero funnel it would render as measured silence.
   *
   * All FOUR funnels are nulled. The external one especially: a zero there
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
      funnelAmbiguous: nullTotals(),
      distinct: {
        declared: null,
        anonymous: null,
        self: null,
        ambiguous: null,
        furthest: null,
        furthestExternal: null,
        furthestAmbiguous: null
      },
      clients: [],
      crossDoor: {
        cutoverAt: HTTP_ARRIVALS_CUTOVER_AT,
        note: "HTTP arrivals are measured from this cut-over only; there is no backfill, so a post-cut-over increase is coverage rather than growth.",
        funnelByAttributionSource: nullAttributionTotals(),
        distinctByAttributionSource: Object.fromEntries(
          ATTRIBUTION_SOURCES.map((source) => [source, null])
        ),
        furthestByAttributionSource: Object.fromEntries(
          ATTRIBUTION_SOURCES.map((source) => [source, null])
        ),
        agents: []
      },
      unavailable: this.loadFailed ?? UNREADABLE
    };
  }

  /**
   * A stored entry re-marked from its declared name at read time.
   *
   * The mark is not frozen at first sight, because the lists that produce it
   * change and the entries that motivated a change already exist. Re-deriving
   * also means a lost or mistyped environment variable self-heals the moment
   * it is corrected, instead of poisoning entries until they are evicted.
   *
   * It has to be the SAME classifier the write path uses, or the marks on the
   * client list would disagree with the `distinct` counts derived from them.
   */
  markEntry(entry) {
    const actor = this.classifyActor(entry.name ? { name: entry.name } : null);
    return {
      ...entry,
      tools: { ...entry.tools },
      self: actor === "self",
      ambiguous: actor === "ambiguous"
    };
  }

  markAgentEntry(entry) {
    const actor = this.classifyAgentActor(entry);
    return {
      ...entry,
      self: actor === "self",
      ambiguous: actor === "ambiguous",
      attributionSources: { ...entry.attributionSources },
      doors: { ...entry.doors },
      tools: { ...entry.tools },
      routes: { ...entry.routes }
    };
  }

  recordAgent({ stage, door, era, clientInfo, ip, tool, route, wallet } = {}) {
    const identity = normalizeClientInfo(clientInfo);
    const canonicalWallet = normalizeWallet(wallet);
    const clientKey = identity ? `client:${identity.name}@${identity.version}` : null;
    if (canonicalWallet && clientKey) this.bindClientToWallet(clientKey, canonicalWallet);

    const aliasedWallet = clientKey ? this.clientWalletAliases.get(clientKey) : null;
    const agentWallet = canonicalWallet ?? aliasedWallet;
    const attributionSource = agentWallet
      ? "siwe_wallet"
      : identity
        ? "client_name"
        : "ip_only";
    const key = agentWallet ? `wallet:${agentWallet}` : (clientKey ?? `anon:${this.hashIp(ip)}`);
    const actor = this.classifyAgentActor({ wallet: agentWallet, name: identity?.name });
    const nowMs = this.now();

    let entry = this.agents.get(key);
    if (!entry) {
      entry = {
        key,
        wallet: agentWallet ?? null,
        // A client key is only a join hint. Once a verified wallet exists we
        // deliberately stop publishing the name beside it; the observatory is
        // for honest counting, not identity enrichment.
        name: agentWallet ? null : (identity?.name ?? null),
        version: agentWallet ? null : (identity?.version ?? null),
        era: era ?? null,
        attributionSource,
        attributionSources: emptySourceCounts(),
        self: actor === "self",
        ambiguous: actor === "ambiguous",
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        furthestStage: stage,
        calls: 0,
        doors: {},
        tools: {},
        routes: {}
      };
      this.agents.set(key, entry);
    }

    entry.lastSeenMs = nowMs;
    entry.calls += 1;
    entry.attributionSource = entry.wallet ? "siwe_wallet" : attributionSource;
    entry.attributionSources[attributionSource] = (entry.attributionSources[attributionSource] ?? 0) + 1;
    entry.self = actor === "self";
    entry.ambiguous = actor === "ambiguous";
    if (era) entry.era = era;
    if (door) entry.doors[door] = (entry.doors[door] ?? 0) + 1;
    if (tool) entry.tools[tool] = (entry.tools[tool] ?? 0) + 1;
    if (route) entry.routes[route] = (entry.routes[route] ?? 0) + 1;
    if (stageRank(stage) > stageRank(entry.furthestStage)) entry.furthestStage = stage;

    this.agentTotals[attributionSource].all[stage] += 1;
    this.agentTotals[attributionSource][actorBucket(actor)][stage] += 1;
    this.metrics?.counter?.(
      "agent_arrival_stage_total",
      "Cross-door agent funnel stages by attribution source",
      ["stage", "actor", "source", "door"]
    )?.inc({ stage, actor, source: attributionSource, door });

    this.evictAgentOverflow();
  }

  bindClientToWallet(clientKey, wallet) {
    this.clientWalletAliases.set(clientKey, wallet);
    const clientEntry = this.agents.get(clientKey);
    if (!clientEntry) return;

    const walletKey = `wallet:${wallet}`;
    const walletEntry = this.agents.get(walletKey);
    if (!walletEntry) {
      clientEntry.key = walletKey;
      clientEntry.wallet = wallet;
      clientEntry.name = null;
      clientEntry.version = null;
      clientEntry.attributionSource = "siwe_wallet";
      this.agents.delete(clientKey);
      this.agents.set(walletKey, clientEntry);
      return;
    }

    walletEntry.firstSeenMs = Math.min(walletEntry.firstSeenMs, clientEntry.firstSeenMs);
    walletEntry.lastSeenMs = Math.max(walletEntry.lastSeenMs, clientEntry.lastSeenMs);
    walletEntry.calls += clientEntry.calls;
    if (stageRank(clientEntry.furthestStage) > stageRank(walletEntry.furthestStage)) {
      walletEntry.furthestStage = clientEntry.furthestStage;
    }
    mergeCounts(walletEntry.attributionSources, clientEntry.attributionSources);
    mergeCounts(walletEntry.doors, clientEntry.doors);
    mergeCounts(walletEntry.tools, clientEntry.tools);
    mergeCounts(walletEntry.routes, clientEntry.routes);
    this.agents.delete(clientKey);
  }

  classifyAgentActor({ wallet, name } = {}) {
    const canonicalWallet = normalizeWallet(wallet);
    if (canonicalWallet) return this.selfWallets.has(canonicalWallet) ? "self" : "client";
    return this.classifyActor(name ? { name } : null);
  }

  totalsFor(actor) {
    if (actor === "self") return this.totalsSelf;
    if (actor === "ambiguous") return this.totalsAmbiguous;
    return this.totalsExternal;
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
      // State written before the ambiguous bucket existed has no counter for
      // it, and those calls were already committed to external at write time.
      // They stay there: the actor of a past call cannot be recovered, and
      // moving counts on a guess would be inventing a measurement. Only new
      // traffic sorts into the third bucket, so `funnelExternal` converges
      // downward from here rather than dropping on deploy.
      restoreTotals(this.totalsAmbiguous, stored?.totalsAmbiguous);
      restoreAttributionTotals(this.agentTotals, stored?.agentTotals);
      for (const entry of Array.isArray(stored?.clients) ? stored.clients : []) {
        if (typeof entry?.key === "string") this.clients.set(entry.key, entry);
      }
      for (const entry of Array.isArray(stored?.agents) ? stored.agents : []) {
        if (typeof entry?.key === "string") this.agents.set(entry.key, normalizeStoredAgent(entry));
      }
      for (const [clientKey, wallet] of Object.entries(stored?.clientWalletAliases ?? {})) {
        const canonicalWallet = normalizeWallet(wallet);
        if (clientKey.startsWith("client:") && canonicalWallet) {
          this.clientWalletAliases.set(clientKey, canonicalWallet);
        }
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
      totalsAmbiguous: { ...this.totalsAmbiguous },
      clients: [...this.clients.values()],
      agentTotals: cloneAttributionTotals(this.agentTotals),
      agents: [...this.agents.values()],
      clientWalletAliases: Object.fromEntries(this.clientWalletAliases)
    });
  }

  evictOverflow() {
    if (this.clients.size <= this.maxClients) return;
    const ordered = [...this.clients.values()].sort((left, right) => left.lastSeenMs - right.lastSeenMs);
    for (const entry of ordered.slice(0, this.clients.size - this.maxClients)) {
      this.clients.delete(entry.key);
    }
  }

  evictAgentOverflow() {
    if (this.agents.size <= this.maxClients) return;
    const ordered = [...this.agents.values()].sort((left, right) => left.lastSeenMs - right.lastSeenMs);
    for (const entry of ordered.slice(0, this.agents.size - this.maxClients)) {
      this.agents.delete(entry.key);
      for (const [clientKey, wallet] of this.clientWalletAliases) {
        if (entry.key === clientKey || entry.key === `wallet:${wallet}`) {
          this.clientWalletAliases.delete(clientKey);
        }
      }
    }
  }

  /**
   * "self" and "ambiguous" both keep a call out of `funnelExternal`, so which
   * one wins when a name is in both lists changes no headline. Self is checked
   * first because it is the stronger claim: we are asserting the traffic is
   * ours, not merely that we cannot rule it out.
   */
  classifyActor(identity) {
    if (!identity) return "anonymous";
    const name = identity.name.toLowerCase();
    if (name.startsWith(SELF_CLIENT_PREFIX) || this.selfClients.has(name)) return "self";
    if (this.ambiguousClients.has(name)) return "ambiguous";
    return "client";
  }

  hashIp(ip) {
    const value = typeof ip === "string" && ip.trim() ? ip.trim() : "unknown";
    return createHash("sha256").update(`${this.hashSalt}:${value}`).digest("hex").slice(0, 12);
  }
}

export function resolveSelfClients(env = process.env) {
  return new Set(parseClientNames(env?.ARRIVAL_SELF_CLIENTS));
}

export function resolveSelfWallets(env = process.env) {
  return new Set(
    String(env?.ARRIVAL_SELF_WALLETS ?? "")
      .split(",")
      .map((value) => normalizeWallet(value))
      .filter(Boolean)
  );
}

/**
 * The configured names PLUS the built-in defaults — an operator can add names
 * that turn out to be shared, but cannot accidentally un-know the one we
 * already learned the hard way.
 */
export function resolveAmbiguousClients(env = process.env) {
  return new Set([...AMBIGUOUS_CLIENT_DEFAULTS, ...parseClientNames(env?.ARRIVAL_AMBIGUOUS_CLIENTS)]);
}

function parseClientNames(raw) {
  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function emptyTotals() {
  return Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, 0]));
}

function nullTotals() {
  return Object.fromEntries(ARRIVAL_STAGES.map((stage) => [stage, null]));
}

function emptySourceCounts() {
  return Object.fromEntries(ATTRIBUTION_SOURCES.map((source) => [source, 0]));
}

function emptyAttributionTotals() {
  return Object.fromEntries(ATTRIBUTION_SOURCES.map((source) => [source, {
    all: emptyTotals(),
    external: emptyTotals(),
    self: emptyTotals(),
    ambiguous: emptyTotals()
  }]));
}

function nullAttributionTotals() {
  return Object.fromEntries(ATTRIBUTION_SOURCES.map((source) => [source, {
    all: nullTotals(),
    external: nullTotals(),
    self: nullTotals(),
    ambiguous: nullTotals()
  }]));
}

function cloneAttributionTotals(totals) {
  return Object.fromEntries(ATTRIBUTION_SOURCES.map((source) => [source, {
    all: { ...totals[source].all },
    external: { ...totals[source].external },
    self: { ...totals[source].self },
    ambiguous: { ...totals[source].ambiguous }
  }]));
}

function restoreAttributionTotals(target, stored) {
  for (const source of ATTRIBUTION_SOURCES) {
    for (const bucket of ["all", "external", "self", "ambiguous"]) {
      restoreTotals(target[source][bucket], stored?.[source]?.[bucket]);
    }
  }
}

function normalizeStoredAgent(entry) {
  return {
    ...entry,
    attributionSources: { ...emptySourceCounts(), ...(entry.attributionSources ?? {}) },
    doors: { ...(entry.doors ?? {}) },
    tools: { ...(entry.tools ?? {}) },
    routes: { ...(entry.routes ?? {}) }
  };
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + Number(value ?? 0);
  }
}

function actorBucket(actor) {
  if (actor === "self") return "self";
  if (actor === "ambiguous") return "ambiguous";
  return "external";
}

function normalizeWallet(wallet) {
  const value = typeof wallet === "string" ? wallet.trim() : "";
  return WALLET_RE.test(value) ? value.toLowerCase() : null;
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

function furthestStageOrNull(agents) {
  return agents.length > 0 ? furthestStageAcross(agents) : null;
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
