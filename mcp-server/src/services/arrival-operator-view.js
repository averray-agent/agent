import { SELF_IDENTITY_KINDS, normalizeSelfIdentityWallet } from "../core/self-identity-registry.js";
import { isExternalJob } from "../core/external-job-lifecycle.js";
import {
  ARRIVAL_IDENTITY_STAGES,
  ARRIVAL_STAGES,
  stageRank
} from "./arrival-stage-map.js";

export const ARRIVALS_OPERATOR_VIEW_VERSION = "averray.arrivals.operator.v1";
export const ARRIVAL_WINDOWS = Object.freeze({
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  payoutBurst: 12 * 60 * 60 * 1_000
});

const PAGE_SIZE = 250;
const MAX_SESSIONS = 10_000;
const PRE_IDENTITY_STAGES = new Set(["reached", "browsed", "evaluated"]);

/**
 * Build the verdict-oriented layer of /monitor/arrivals.
 *
 * Legacy call counters remain untouched beside this projection. This view uses
 * distinct wallet journeys from `identified` onward, enriches them with durable
 * claim/submit/payout sessions, and keeps traffic that cannot be attributed in
 * its own bucket. No date or historical count is embedded in code.
 */
export async function buildArrivalOperatorView({
  nowMs,
  identityRegistry,
  clients,
  httpClients,
  totals,
  actorTotals,
  httpTotals,
  httpActorTotals,
  observingSinceMs,
  httpObservingSinceMs,
  stateStore,
  platformService
} = {}) {
  const generatedAtMs = finiteMs(nowMs) ?? Date.now();
  const sessions = await collectSessions(stateStore);
  const sessionsByWallet = groupSessionsByWallet(sessions);
  const journeys = buildJourneys({
    entries: [
      ...(clients ?? []).map((entry) => ({ ...entry, door: "mcp" })),
      ...(httpClients ?? []).map((entry) => ({ ...entry, door: "http" }))
    ],
    sessionsByWallet,
    identityRegistry
  });
  const outsiders = journeys.filter((journey) => journey.identity.actor === "external" && journey.wallet);
  const ours = journeys.filter((journey) => journey.identity.actor === "self");
  const ambiguous = journeys.filter((journey) => journey.identity.actor === "ambiguous");

  const dayStart = generatedAtMs - ARRIVAL_WINDOWS.day;
  const weekStart = generatedAtMs - ARRIVAL_WINDOWS.week;
  const furthestEver = buildFurthestEver(outsiders);
  const lastActivity = lastMeaningfulActivity(outsiders);
  const postedWork = buildPostedWork(platformService);
  const preSplitCalls = countPreSplitCalls({
    totals,
    actorTotals,
    httpTotals,
    httpActorTotals
  });

  return {
    version: ARRIVALS_OPERATOR_VIEW_VERSION,
    generatedAtMs,
    outsiders: {
      furthestEver,
      lastActivity,
      week: {
        window: "7d",
        identified: countDistinctWithEvent(outsiders, "identified", weekStart),
        worked: countDistinctWithEvent(outsiders, "claimed", weekStart)
      },
      postedWork
    },
    ours: {
      day: {
        window: "24h",
        agents: countActiveJourneys(ours, dayStart),
        canaryRuns: countSessionsByKind(ours, SELF_IDENTITY_KINDS.CANARY, dayStart),
        acceptanceRuns: countSessionsByKind(ours, SELF_IDENTITY_KINDS.ACCEPTANCE, dayStart),
        adminConsoleAgents: countActiveJourneys(
          ours.filter((journey) => journey.identity.kind === SELF_IDENTITY_KINDS.ADMIN_CONSOLE),
          dayStart
        ),
        operatorAgents: countActiveJourneys(
          ours.filter((journey) => ![
            SELF_IDENTITY_KINDS.CANARY,
            SELF_IDENTITY_KINDS.ACCEPTANCE,
            SELF_IDENTITY_KINDS.ADMIN_CONSOLE
          ].includes(journey.identity.kind)),
          dayStart
        )
      }
    },
    unknown: {
      window: "all-time",
      sharedClientNames: new Set(ambiguous.map((journey) => journey.name).filter(Boolean)).size,
      preSplitCalls
    },
    doors: {
      mcp: buildDoorEvidence({
        door: "mcp",
        total: totals,
        actorTotals,
        journeys,
        sinceMs: observingSinceMs
      }),
      http: buildDoorEvidence({
        door: "http",
        total: httpTotals,
        actorTotals: httpActorTotals,
        journeys,
        sinceMs: httpObservingSinceMs
      })
    }
  };
}

function buildJourneys({ entries, sessionsByWallet, identityRegistry }) {
  const journeys = new Map();
  for (const entry of entries) {
    const wallet = normalizeSelfIdentityWallet(entry.wallet);
    const key = wallet ? `wallet:${wallet}` : String(entry.key ?? "");
    if (!key) continue;
    const relatedSessions = wallet ? sessionsByWallet.get(wallet) ?? [] : [];
    const identity = classifyJourney(identityRegistry, entry, relatedSessions);
    const current = journeys.get(key) ?? {
      key,
      wallet: wallet ?? null,
      name: entry.name ?? null,
      identity,
      doors: new Set(),
      doorFurthest: {},
      firstSeenMs: finiteMs(entry.firstSeenMs),
      lastSeenMs: finiteMs(entry.lastSeenMs),
      furthestStage: entry.furthestStage ?? "reached",
      events: new Map(),
      sessions: relatedSessions
    };
    current.doors.add(entry.door);
    current.name ??= entry.name ?? null;
    if (stageRank(entry.furthestStage) > stageRank(current.doorFurthest[entry.door])) {
      current.doorFurthest[entry.door] = entry.furthestStage;
    }
    current.firstSeenMs = minDefined(current.firstSeenMs, finiteMs(entry.firstSeenMs));
    current.lastSeenMs = maxDefined(current.lastSeenMs, finiteMs(entry.lastSeenMs));
    if (identity.actor === "self" || current.identity.actor !== "self") current.identity = identity;
    if (stageRank(entry.furthestStage) > stageRank(current.furthestStage)) {
      current.furthestStage = entry.furthestStage;
    }
    if (wallet) {
      const identifiedAt = finiteMs(entry.firstSeenMs) ?? finiteMs(entry.lastSeenMs);
      addEvent(current.events, "identified", identifiedAt, { door: entry.door });
      if (stageRank(entry.furthestStage) >= stageRank("authenticated")) {
        addEvent(current.events, "authenticated", finiteMs(entry.lastSeenMs), { door: entry.door });
      }
    }
    journeys.set(key, current);
  }

  // Arrival client tables are intentionally capped; payout/session history is
  // not. Seed any evicted wallet journey back from its durable session so an
  // all-time verdict cannot forget a settled outsider as new callers arrive.
  for (const [wallet, relatedSessions] of sessionsByWallet.entries()) {
    const key = `wallet:${wallet}`;
    const identity = classifySessions(identityRegistry, wallet, relatedSessions);
    const sessionTimes = relatedSessions.flatMap((session) => [
      sessionTime(session, ["claimedAt", "createdAt"]),
      sessionTime(session, ["resolvedAt", "submittedAt", "updatedAt"])
    ]).filter(Number.isFinite);
    const current = journeys.get(key) ?? {
      key,
      wallet,
      name: null,
      identity,
      doors: new Set(),
      doorFurthest: {},
      firstSeenMs: minAcross(sessionTimes),
      lastSeenMs: sessionTimes.length > 0 ? Math.max(...sessionTimes) : undefined,
      furthestStage: "identified",
      events: new Map(),
      sessions: relatedSessions
    };
    current.sessions = relatedSessions;
    if (identity.actor === "self" || current.identity.actor !== "self") current.identity = identity;
    for (const session of relatedSessions) {
      for (const door of sessionDoors(session)) {
        current.doors.add(door);
        const reached = hasReachedSessionStage(session, "submitted") ? "submitted" : "claimed";
        if (stageRank(reached) > stageRank(current.doorFurthest[door])) current.doorFurthest[door] = reached;
      }
    }
    journeys.set(key, current);
  }

  for (const journey of journeys.values()) {
    for (const session of journey.sessions) {
      const protocols = sessionDoors(session);
      const fallbackDoor = highestStageDoor(journey.doorFurthest);
      const claimContext = { door: protocols[0] ?? fallbackDoor };
      const workContext = { door: protocols.at(-1) ?? fallbackDoor };
      addEvent(journey.events, "identified", sessionTime(session, ["claimedAt", "createdAt"]), claimContext);
      addEvent(journey.events, "authenticated", sessionTime(session, ["claimedAt", "createdAt"]), claimContext);
      addEvent(journey.events, "claimed", sessionTime(session, ["claimedAt", "createdAt"]), claimContext);
      if (hasReachedSessionStage(session, "submitted")) {
        addEvent(journey.events, "submitted", sessionTime(session, ["submittedAt", "updatedAt", "claimedAt"]), workContext);
      }
      if (isConfirmedPayout(session)) {
        addEvent(journey.events, "settled", sessionTime(session, ["resolvedAt", "updatedAt"]), {
          sessionId: session.sessionId,
          payout: true,
          ...workContext
        });
      }
    }
    const eventFurthest = [...journey.events.keys()].sort((left, right) => stageRank(right) - stageRank(left))[0];
    if (eventFurthest && stageRank(eventFurthest) > stageRank(journey.furthestStage)) {
      journey.furthestStage = eventFurthest;
    }
    journey.doors = [...journey.doors].sort();
  }
  return [...journeys.values()];
}

function classifyJourney(identityRegistry, entry, sessions) {
  for (const session of sessions) {
    const classified = identityRegistry.classify({ wallet: entry.wallet, session });
    if (classified.actor === "self") return classified;
  }
  return identityRegistry.classify({
    wallet: entry.wallet,
    clientInfo: entry.name ? { name: entry.name } : undefined
  });
}

function classifySessions(identityRegistry, wallet, sessions) {
  let identity = identityRegistry.classify({ wallet });
  for (const session of sessions) {
    const classified = identityRegistry.classify({ wallet, session });
    if (classified.actor === "self") return classified;
    if (classified.actor === "ambiguous") identity = classified;
  }
  return identity;
}

function buildFurthestEver(outsiders) {
  const furthestRank = outsiders.reduce(
    (rank, journey) => Math.max(rank, stageRank(journey.furthestStage)),
    -1
  );
  if (furthestRank < stageRank("identified")) return null;
  const stage = furthestRank === stageRank("settled")
    ? "settled"
    : ARRIVAL_STAGES[furthestRank];
  const atStage = outsiders.filter((journey) => stageRank(journey.furthestStage) >= furthestRank);
  const events = atStage.flatMap((journey) => (
    (journey.events.get(stage) ?? []).map((event) => ({ ...event, journey }))
  )).filter((event) => Number.isFinite(event.atMs));
  const first = events.sort((left, right) => left.atMs - right.atMs)[0];
  const result = {
    window: "all-time",
    stage,
    atMs: first?.atMs ?? minAcross(atStage.map((journey) => journey.firstSeenMs)),
    door: doorLabel(events.map((event) => event.door).filter(Boolean)),
    agents: new Set(atStage.map((journey) => journey.key)).size
  };
  if (stage !== "settled") return result;
  const burst = densestBurst(events, ARRIVAL_WINDOWS.payoutBurst);
  return {
    ...result,
    atMs: burst?.startMs ?? result.atMs,
    payouts: burst?.count ?? events.length,
    payoutWindow: "12h",
    payoutSpanMs: burst?.spanMs ?? 0
  };
}

function lastMeaningfulActivity(outsiders) {
  let latest = null;
  for (const journey of outsiders) {
    for (const stage of ARRIVAL_IDENTITY_STAGES) {
      for (const event of journey.events.get(stage) ?? []) {
        if (!Number.isFinite(event.atMs)) continue;
        if (!latest || event.atMs > latest.atMs) {
          latest = { atMs: event.atMs, stage, door: event.door ?? doorLabel(journey.doors) };
        }
      }
    }
  }
  return latest ? { window: "all-time", ...latest } : null;
}

function buildPostedWork(platformService) {
  let jobs;
  try {
    jobs = platformService?.listJobs?.({ includePaused: true, includeArchived: true, includeStale: true }) ?? [];
  } catch {
    return { window: "all-time", status: "unknown", count: null, firstAtMs: null };
  }
  const external = jobs.filter(isExternalJob);
  const timestamps = external.map(jobPostedAt).filter(Number.isFinite);
  return {
    window: "all-time",
    status: external.length > 0 ? "observed" : "never",
    count: external.length,
    firstAtMs: timestamps.length > 0 ? Math.min(...timestamps) : null
  };
}

function buildDoorEvidence({
  door,
  total,
  actorTotals,
  journeys,
  sinceMs
}) {
  const rows = ARRIVAL_STAGES.map((stage) => {
    if (PRE_IDENTITY_STAGES.has(stage)) {
      const outsider = nonnegativeInteger(actorTotals?.outsider?.[stage]);
      const ours = nonnegativeInteger(actorTotals?.ours?.[stage]);
      const attributableUnknown = nonnegativeInteger(actorTotals?.unknown?.[stage]);
      const unattributed = Math.max(
        0,
        Number(total?.[stage] ?? 0) - outsider - ours - attributableUnknown
      );
      return {
        stage,
        unit: "calls",
        instrumentation: stage === "reached"
          ? "requests reaching the door"
          : `${stage} route/tool calls`,
        outsider,
        ours,
        unknown: attributableUnknown + unattributed
      };
    }
    const eligible = journeys.filter((journey) => (
      journey.wallet
      && journey.doors.includes(door)
      && stageRank(journey.doorFurthest[door]) >= stageRank(stage)
    ));
    return {
      stage,
      unit: "agents",
      instrumentation: "distinct SIWE wallets reaching at least this stage",
      outsider: new Set(eligible.filter((journey) => journey.identity.actor === "external").map((journey) => journey.key)).size,
      ours: new Set(eligible.filter((journey) => journey.identity.actor === "self").map((journey) => journey.key)).size,
      unknown: new Set(eligible.filter((journey) => journey.identity.actor === "ambiguous").map((journey) => journey.key)).size
    };
  });
  return {
    window: "all-time",
    sinceMs: finiteMs(sinceMs) ?? null,
    rows
  };
}

function countDistinctWithEvent(journeys, stage, cutoffMs) {
  return new Set(journeys.filter((journey) => hasEventSince(journey, stage, cutoffMs)).map((journey) => journey.key)).size;
}

function countActiveJourneys(journeys, cutoffMs) {
  return new Set(journeys.filter((journey) => (
    [...journey.events.values()].flat().some((event) => event.atMs >= cutoffMs)
    || Number(journey.lastSeenMs) >= cutoffMs
  )).map((journey) => journey.key)).size;
}

function countSessionsByKind(journeys, kind, cutoffMs) {
  return new Set(journeys
    .filter((journey) => journey.identity.kind === kind)
    .flatMap((journey) => journey.sessions)
    .filter((session) => Number(sessionTime(session, ["claimedAt", "createdAt"])) >= cutoffMs)
    .map((session) => String(session.sessionId ?? session.jobId ?? ""))
    .filter(Boolean)).size;
}

function countPreSplitCalls({ totals, actorTotals, httpTotals, httpActorTotals }) {
  return countDoorRemainder({ total: totals, actorTotals })
    + countDoorRemainder({ total: httpTotals, actorTotals: httpActorTotals });
}

function countDoorRemainder({ total, actorTotals }) {
  return ARRIVAL_STAGES.reduce(
    (sum, stage) => sum + Math.max(
      0,
      Number(total?.[stage] ?? 0)
        - nonnegativeInteger(actorTotals?.outsider?.[stage])
        - nonnegativeInteger(actorTotals?.ours?.[stage])
        - nonnegativeInteger(actorTotals?.unknown?.[stage])
    ),
    0
  );
}

async function collectSessions(stateStore) {
  if (typeof stateStore?.listRecentSessions !== "function") return [];
  const sessions = [];
  for (let offset = 0; offset < MAX_SESSIONS; offset += PAGE_SIZE) {
    const page = await stateStore.listRecentSessions(PAGE_SIZE, offset);
    if (!Array.isArray(page)) throw new Error("arrival operator view session source returned a non-array page");
    sessions.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return sessions;
}

function groupSessionsByWallet(sessions) {
  const grouped = new Map();
  for (const session of sessions) {
    const wallet = normalizeSelfIdentityWallet(session?.wallet);
    if (!wallet) continue;
    const current = grouped.get(wallet) ?? [];
    current.push(session);
    grouped.set(wallet, current);
  }
  return grouped;
}

function sessionDoors(session) {
  return [...new Set((Array.isArray(session?.protocolHistory) ? session.protocolHistory : [])
    .map((door) => String(door).trim().toLowerCase())
    .filter((door) => door === "mcp" || door === "http"))];
}

function hasReachedSessionStage(session, target) {
  const order = ["claimed", "submitted", "resolved", "rejected", "closed"];
  return order.indexOf(String(session?.status)) >= order.indexOf(target);
}

function isConfirmedPayout(session) {
  return session?.status === "resolved"
    && Number(session?.payoutTx?.status) === 1
    && typeof session?.payoutTx?.txHash === "string";
}

function sessionTime(session, fields) {
  for (const field of fields) {
    const parsed = Date.parse(String(session?.[field] ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function jobPostedAt(job) {
  for (const value of [
    job?.source?.poster?.fundedAt,
    job?.source?.createdAt,
    job?.lifecycle?.createdAt,
    job?.createdAt
  ]) {
    const parsed = Date.parse(String(value ?? ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function addEvent(events, stage, atMs, extra = {}) {
  if (!Number.isFinite(atMs)) return;
  const current = events.get(stage) ?? [];
  current.push({ atMs, ...extra });
  events.set(stage, current);
}

function hasEventSince(journey, stage, cutoffMs) {
  return [...journey.events.entries()].some(([candidate, events]) => (
    stageRank(candidate) >= stageRank(stage)
    && events.some((event) => event.atMs >= cutoffMs)
  ));
}

function densestBurst(events, windowMs) {
  const sorted = [...events].sort((left, right) => left.atMs - right.atMs);
  let best = null;
  let left = 0;
  for (let right = 0; right < sorted.length; right += 1) {
    while (sorted[right].atMs - sorted[left].atMs > windowMs) left += 1;
    const count = right - left + 1;
    if (!best || count > best.count) {
      best = {
        count,
        startMs: sorted[left].atMs,
        endMs: sorted[right].atMs,
        spanMs: sorted[right].atMs - sorted[left].atMs
      };
    }
  }
  return best;
}

function doorLabel(doors) {
  const distinct = [...new Set(doors)].filter(Boolean).sort();
  return distinct.length === 1 ? distinct[0] : distinct.join("+") || "unknown";
}

function highestStageDoor(doorFurthest = {}) {
  const ranked = Object.entries(doorFurthest)
    .sort(([leftDoor, leftStage], [rightDoor, rightStage]) => (
      stageRank(rightStage) - stageRank(leftStage) || leftDoor.localeCompare(rightDoor)
    ));
  return ranked[0]?.[0] ?? "unknown";
}

function finiteMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function minDefined(left, right) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function maxDefined(left, right) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function minAcross(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.min(...finite) : null;
}
