import { ValidationError } from "../core/errors.js";
import { JOURNEY_EVENT_PER_WALLET_RETENTION } from "../core/state-store.js";
import {
  describeSelfIdentity,
  normalizeSelfIdentityWallet
} from "../core/self-identity-registry.js";
import {
  ARRIVAL_SOFTWARE_CLASSES,
  PROSPECTIVE_ARRIVAL_SURFACES
} from "./arrival-observatory.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const EVENT_LOG_READ_LIMIT = 500;
const SESSION_READ_LIMIT = 10_000;
const RECENT_SESSION_READ_MIN = 100;
const RECENT_SESSION_READ_MAX = 1_000;
const WALLET_RE = /^0x[a-f0-9]{40}$/u;
const GAS_GRANT_TOPIC = "operator_gas.first_withdrawal_granted";

const TIMELINE_WINDOWS = Object.freeze({
  "48h": { bucket: "hour", bucketMs: HOUR_MS, bucketCount: 48 },
  "30d": { bucket: "day", bucketMs: DAY_MS, bucketCount: 30 }
});

const JOURNEY_TOPICS = new Map([
  ["journey.auth_nonce_issued", "auth_nonce"],
  ["journey.auth_verified", "signed_in"],
  ["journey.preflight_completed", "preflighted"],
  ["journey.withdrawal_intent_created", "withdrawal_intent"],
  [GAS_GRANT_TOPIC, "gas_grant"]
]);
const JOURNEY_EVENT_ORDER = Object.freeze({
  first_seen: 0,
  auth_nonce: 1,
  signed_in: 2,
  preflighted: 3,
  claimed: 4,
  submitted: 5,
  verified: 6,
  settled: 7,
  withdrawal_intent: 8,
  gas_grant: 9
});

export class AdminJourneyReadService {
  constructor({ arrivalObservatory, identityRegistry, platformService, stateStore, now = () => Date.now() } = {}) {
    this.arrivalObservatory = arrivalObservatory;
    this.identityRegistry = identityRegistry;
    this.platformService = platformService;
    this.stateStore = stateStore;
    this.now = now;
  }

  async getArrivalTimeline(windowId = "48h") {
    const definition = TIMELINE_WINDOWS[windowId];
    if (!definition) {
      throw new ValidationError("window must be 48h or 30d.", { field: "window" });
    }
    const source = await this.arrivalObservatory.getPreAuthTimelineState();
    const generatedAtMs = this.now();
    const currentStartMs = Math.floor(generatedAtMs / definition.bucketMs) * definition.bucketMs;
    const startMs = currentStartMs - ((definition.bucketCount - 1) * definition.bucketMs);
    const endMs = currentStartMs + definition.bucketMs;
    const buckets = Array.from({ length: definition.bucketCount }, (_unused, index) => ({
      startMs: startMs + (index * definition.bucketMs),
      counts: new Map()
    }));

    for (const hourly of source.buckets ?? []) {
      if (hourly.startMs < startMs || hourly.startMs >= endMs) continue;
      const index = Math.floor((hourly.startMs - startMs) / definition.bucketMs);
      const target = buckets[index];
      for (const row of hourly.counts ?? []) {
        const key = `${row.surface}|${row.clientClass}`;
        target.counts.set(key, (target.counts.get(key) ?? 0) + Number(row.count ?? 0));
      }
    }

    return {
      schemaVersion: "averray.admin.arrivals.timeline.v1",
      generatedAt: iso(generatedAtMs),
      collectionSince: iso(source.collectionSinceMs),
      window: {
        id: windowId,
        bucket: definition.bucket,
        start: iso(startMs),
        end: iso(endMs),
        bucketCount: definition.bucketCount,
        retentionDays: Number(source.retentionDays ?? 30),
        backfilled: false
      },
      dimensions: {
        surfaces: [...PROSPECTIVE_ARRIVAL_SURFACES],
        clientSoftwareClasses: [...ARRIVAL_SOFTWARE_CLASSES]
      },
      privacy: {
        aggregateOnly: true,
        containsWallets: false,
        containsNetworkIdentifiers: false,
        containsRawUserAgents: false
      },
      buckets: buckets.map((bucket) => {
        const counts = [...bucket.counts.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, count]) => {
            const [surface, clientClass] = key.split("|");
            return { surface, clientClass, count };
          });
        return {
          start: iso(bucket.startMs),
          end: iso(bucket.startMs + definition.bucketMs),
          total: counts.reduce((sum, row) => sum + row.count, 0),
          counts
        };
      }),
      ...(source.unavailable ? { unavailable: source.unavailable } : {})
    };
  }

  async getWorkerJourneys({ wallet, limit = 25 } = {}) {
    const normalizedWallet = wallet === undefined ? undefined : requireWallet(wallet);
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const sessionReadCap = normalizedWallet
      ? SESSION_READ_LIMIT
      : Math.min(Math.max(safeLimit * 10, RECENT_SESSION_READ_MIN), RECENT_SESSION_READ_MAX);
    const [arrivalState, sessions, eventPage] = await Promise.all([
      this.arrivalObservatory.getPreAuthTimelineState(),
      normalizedWallet
        ? this.platformService.collectSessionHistory(normalizedWallet, {
            pageSize: 100,
            maxSessions: sessionReadCap
          })
        : this.platformService.listRecentSessions(sessionReadCap),
      normalizedWallet && typeof this.stateStore.listJourneyEvents === "function"
        ? this.stateStore.listJourneyEvents({
            wallet: normalizedWallet,
            limit: JOURNEY_EVENT_PER_WALLET_RETENTION
          })
        // Recent-list discovery intentionally reads a bounded global tail. A
        // wallet-specific read uses the durable per-wallet index above, so
        // unrelated traffic cannot hide retained events for the requested
        // worker.
        : this.stateStore.listEventLog({ limit: EVENT_LOG_READ_LIMIT })
    ]);

    const relevantEvents = (eventPage?.events ?? []).filter((event) => JOURNEY_TOPICS.has(event.topic));
    const wallets = normalizedWallet
      ? [normalizedWallet]
      : collectWallets(sessions, relevantEvents);
    const sessionsByWallet = groupByWallet(sessions);
    const eventsByWallet = groupEventsByWallet(relevantEvents);
    const journeys = wallets.map((candidate) => buildJourney({
      wallet: candidate,
      sessions: sessionsByWallet.get(candidate) ?? [],
      storedEvents: eventsByWallet.get(candidate) ?? [],
      collectionSinceMs: arrivalState.collectionSinceMs,
      identityRegistry: this.identityRegistry
    }))
      .filter((journey) => journey.events.length > 0)
      .sort((left, right) => String(right.lastActiveAt).localeCompare(String(left.lastActiveAt)))
      .slice(0, safeLimit);

    return {
      schemaVersion: "averray.admin.worker-journeys.v1",
      generatedAt: iso(this.now()),
      collectionSince: iso(arrivalState.collectionSinceMs),
      window: {
        id: normalizedWallet ? "wallet_retained_history" : "recent_active",
        backfilled: false,
        sessionReadCap,
        eventReadCap: normalizedWallet
          ? JOURNEY_EVENT_PER_WALLET_RETENTION
          : EVENT_LOG_READ_LIMIT,
        journeyEventPerWalletCap: JOURNEY_EVENT_PER_WALLET_RETENTION
      },
      scope: "operator",
      identityBoundary: "Wallet identity begins at successful SIWE; pre-auth telemetry is never joined to a wallet.",
      count: journeys.length,
      limit: safeLimit,
      ...(normalizedWallet ? { wallet: normalizedWallet } : {}),
      journeys
    };
  }
}

function buildJourney({ wallet, sessions, storedEvents, collectionSinceMs, identityRegistry }) {
  const orderedSessions = [...sessions].sort(compareSession);
  const identity = describeSelfIdentity(identityRegistry.classifySessions({
    wallet,
    sessions: orderedSessions
  }));
  const events = [
    ...storedEvents.map(buildStoredJourneyEvent).filter(Boolean),
    ...orderedSessions.flatMap(buildSessionEvents)
  ].sort(compareJourneyEvent);
  const deduplicated = deduplicateEvents(events);
  if (deduplicated.length > 0
    && deduplicated[0].sourceStore === "event-log"
    && Date.parse(deduplicated[0].timestamp) >= Number(collectionSinceMs)) {
    const first = deduplicated[0];
    deduplicated.unshift({
      id: `first-seen:${wallet}:${first.timestamp}`,
      type: "first_seen",
      timestamp: first.timestamp,
      sourceStore: first.sourceStore,
      details: { basis: first.type }
    });
  }
  const timed = deduplicated.map((event, index) => ({
    ...event,
    durationFromPreviousMs: index === 0
      ? null
      : Math.max(0, Date.parse(event.timestamp) - Date.parse(deduplicated[index - 1].timestamp))
  }));
  return {
    wallet,
    classification: identity.classification,
    classificationKind: identity.kind,
    classificationAuthority: identity.authority,
    classificationEvidence: identity.evidence,
    firstSeenAt: timed[0]?.timestamp ?? null,
    lastActiveAt: timed.at(-1)?.timestamp ?? null,
    events: timed
  };
}

function buildStoredJourneyEvent(event) {
  const type = JOURNEY_TOPICS.get(event.topic);
  const timestamp = validIso(event.timestamp);
  if (!type || !timestamp) return undefined;
  const base = {
    id: String(event.id ?? `${event.topic}:${timestamp}`),
    type,
    timestamp,
    sourceStore: "event-log"
  };
  if (type === "preflighted") {
    return {
      ...base,
      jobId: event.jobId ?? event.data?.jobId ?? null,
      details: {
        eligible: typeof event.data?.eligible === "boolean" ? event.data.eligible : null,
        reason: event.data?.reason ?? null,
        claimable: typeof event.data?.claimable === "boolean" ? event.data.claimable : null,
        claimFundingSufficient: typeof event.data?.claimFundingSufficient === "boolean"
          ? event.data.claimFundingSufficient
          : null
      }
    };
  }
  if (type === "withdrawal_intent") {
    return {
      ...base,
      details: {
        status: event.data?.status ?? "created",
        gasGrantRequested: event.data?.gasGrantRequested === true,
        gasGrantStatus: event.data?.gasGrantStatus ?? "unknown",
        gasGrantReason: event.data?.gasGrantReason ?? null
      }
    };
  }
  if (type === "gas_grant") {
    return {
      ...base,
      txHash: event.txHash ?? null,
      details: { status: "granted" }
    };
  }
  return { ...base, details: { outcome: event.data?.outcome ?? null } };
}

function buildSessionEvents(session) {
  const events = [];
  for (const [index, transition] of (session.statusHistory ?? []).entries()) {
    const timestamp = validIso(transition?.at);
    if (!timestamp || !["claimed", "submitted"].includes(transition?.to)) continue;
    events.push({
      id: `session:${session.sessionId}:${transition.to}:${index}`,
      type: transition.to,
      timestamp,
      sourceStore: "session-store",
      sessionId: session.sessionId,
      jobId: session.jobId
    });
  }
  const verification = session.verification ?? session.verificationSummary;
  const outcome = verification?.outcome;
  const terminalAt = session.resolvedAt
    ?? session.rejectedAt
    ?? session.disputedAt
    ?? terminalTransitionAt(session)
    ?? session.updatedAt;
  const verificationAt = validIso(verification?.session?.updatedAt ?? terminalAt);
  if (outcome && verificationAt) {
    events.push({
      id: `verification:${session.sessionId}:${outcome}`,
      type: "verified",
      timestamp: verificationAt,
      sourceStore: "verification-results",
      sessionId: session.sessionId,
      jobId: session.jobId,
      details: {
        outcome,
        reasonCode: verification?.reasonCode ?? null,
        workerConsequence: verification?.workerConsequence ?? verification?.details?.workerConsequence ?? null
      }
    });
  }
  const payoutTx = session.payoutTx ?? verification?.payoutTx;
  if (Number(payoutTx?.status) === 1 && typeof payoutTx?.txHash === "string" && verificationAt) {
    events.push({
      id: `settlement:${session.sessionId}:${payoutTx.txHash}`,
      type: "settled",
      timestamp: verificationAt,
      sourceStore: "session-store",
      sessionId: session.sessionId,
      jobId: session.jobId,
      txHash: payoutTx.txHash,
      details: { outcome: outcome ?? session.status }
    });
  }
  return events;
}

function collectWallets(sessions, events) {
  const lastActive = new Map();
  for (const session of sessions ?? []) {
    const wallet = normalizeWallet(session?.wallet);
    const at = sessionLastActive(session);
    if (wallet && at) lastActive.set(wallet, maxIso(lastActive.get(wallet), at));
  }
  for (const event of events ?? []) {
    const wallet = normalizeWallet(event?.wallet);
    const at = validIso(event?.timestamp);
    if (wallet && at) lastActive.set(wallet, maxIso(lastActive.get(wallet), at));
  }
  return [...lastActive.entries()]
    .sort((left, right) => String(right[1]).localeCompare(String(left[1])))
    .map(([wallet]) => wallet);
}

function groupByWallet(sessions) {
  const grouped = new Map();
  for (const session of sessions ?? []) {
    const wallet = normalizeWallet(session?.wallet);
    if (!wallet) continue;
    grouped.set(wallet, [...(grouped.get(wallet) ?? []), session]);
  }
  return grouped;
}

function groupEventsByWallet(events) {
  const grouped = new Map();
  for (const event of events ?? []) {
    const wallet = normalizeWallet(event?.wallet);
    if (!wallet) continue;
    grouped.set(wallet, [...(grouped.get(wallet) ?? []), event]);
  }
  return grouped;
}

function deduplicateEvents(events) {
  const byId = new Map();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()].sort(compareJourneyEvent);
}

function terminalTransitionAt(session) {
  return [...(session.statusHistory ?? [])]
    .reverse()
    .find((entry) => ["resolved", "rejected", "disputed"].includes(entry?.to))?.at;
}

function compareJourneyEvent(left, right) {
  return String(left.timestamp).localeCompare(String(right.timestamp))
    || (JOURNEY_EVENT_ORDER[left.type] ?? 99) - (JOURNEY_EVENT_ORDER[right.type] ?? 99)
    || left.id.localeCompare(right.id);
}

function compareSession(left, right) {
  return String(sessionLastActive(left) ?? "").localeCompare(String(sessionLastActive(right) ?? ""));
}

function sessionLastActive(session) {
  return validIso(session?.updatedAt
    ?? session?.resolvedAt
    ?? session?.rejectedAt
    ?? session?.submittedAt
    ?? session?.claimedAt);
}

function maxIso(left, right) {
  if (!left) return right;
  return String(left).localeCompare(String(right)) >= 0 ? left : right;
}

function requireWallet(value) {
  const wallet = normalizeSelfIdentityWallet(value);
  if (!wallet || !WALLET_RE.test(wallet)) {
    throw new ValidationError("wallet must be a 0x-prefixed 20-byte EVM address.", { field: "wallet" });
  }
  return wallet;
}

function normalizeWallet(value) {
  const wallet = String(value ?? "").trim().toLowerCase();
  return WALLET_RE.test(wallet) ? wallet : undefined;
}

function validIso(value) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

function iso(value) {
  return new Date(value).toISOString();
}
