"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  OverviewTopbar,
  type CapabilityWarning,
} from "@/components/overview/OverviewTopbar";
import { MissionHero } from "@/components/overview/MissionHero";
import { OrientationCard } from "@/components/overview/OrientationCard";
import { RoomVitals } from "@/components/overview/RoomVitals";
import {
  NeedsActionList,
  type AlertItem,
} from "@/components/overview/NeedsActionList";
import {
  LaneStatusGrid,
} from "@/components/overview/LaneStatusGrid";
import { PlatformPulse } from "@/components/overview/PlatformPulse";
import { ProviderOperationsCard } from "@/components/overview/ProviderOperationsCard";
import { RecurringRuntimeCard } from "@/components/overview/RecurringRuntimeCard";
import { JobLifecycleStrip } from "@/components/overview/JobLifecycleStrip";
import {
  useAccount,
  useAdminSessions,
  useAlerts,
  useAudit,
  useBadges,
  useDisputes,
  useHealth,
  useJobs,
  usePolicies,
  useProviderOperations,
  usePublicProviderOperations,
  useStrategyPositions,
} from "@/lib/api/hooks";
import { extractDisputeList } from "@/lib/api/dispute-adapters";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";
import { extractRunJobs } from "@/lib/api/run-adapters";
import { buildProviderOperations } from "@/lib/api/provider-operations";
import { buildRecurringRuntimeSummary } from "@/lib/api/recurring-jobs";
import {
  buildJobLifecycleSummary,
  buildPublicJobLifecycleSummary,
  EMPTY_JOB_LIFECYCLE_SUMMARY,
} from "@/lib/api/job-lifecycle";
import {
  buildLaneCards,
  buildOverviewAlerts,
  buildRoomVitals,
} from "@/lib/api/treasury-adapters";
import { feedPresence, FEED_STATE_LABEL } from "@/lib/api/feed-presence";
import {
  getStreamServerSnapshot,
  getStreamSnapshot,
  subscribeStream,
} from "@/lib/events/stream-status";
import { buildPulseEvents } from "@/lib/events/pulse-adapter";

export default function OverviewPage() {
  const jobs = useJobs();
  const sessions = useAdminSessions();
  const account = useAccount();
  const strategyPositions = useStrategyPositions();
  const health = useHealth();
  const apiAlerts = useAlerts();
  const badges = useBadges();
  const policies = usePolicies();
  const audit = useAudit();
  const disputes = useDisputes();
  const providerOps = useProviderOperations();
  const publicProviderOps = usePublicProviderOperations();

  const sessionsPresence = feedPresence(sessions);
  const sessionsBlocked = sessionsPresence === "locked" || sessionsPresence === "down";
  const policiesPresence = feedPresence(policies);
  const policiesBlocked = policiesPresence === "locked" || policiesPresence === "down";
  const strategyPresence = feedPresence(strategyPositions);
  const liveVitals = useMemo(
    () =>
      buildRoomVitals(
        jobs.data,
        sessions.data,
        account.data,
        strategyPositions.data,
        sessionsPresence,
        strategyPresence
      ),
    [
      account.data,
      jobs.data,
      sessions.data,
      sessionsPresence,
      strategyPresence,
      strategyPositions.data,
    ]
  );
  // The Runs-in-motion + Agents-active cards both pull from
  // /admin/sessions. While that request is still in flight on first
  // paint, we don't want the cards to claim "0" or "no claims
  // observed yet" — we just don't know yet. Replace the deltas with
  // a loading hint until the request resolves; once it's resolved
  // (data or error), buildRoomVitals' real copy takes over.
  const sessionsLoading = sessions.isLoading && !sessions.data && !sessions.error;
  const vitalsWithLoadingHints = useMemo(() => {
    if (!sessionsLoading) return liveVitals;
    return liveVitals.map((v) =>
      v.label === "Runs in motion" || v.label === "Agents active"
        ? { ...v, delta: "waiting for /admin/sessions…" }
        : v
    );
  }, [liveVitals, sessionsLoading]);
  const liveAlerts = useMemo(
    () => buildOverviewAlerts(sessions.data, account.data),
    [account.data, sessions.data]
  );
  const endpointAlerts = useMemo(() => extractAlerts(apiAlerts.data), [apiAlerts.data]);
  const openDisputeCount = useMemo(
    () =>
      extractDisputeList(disputes.data).filter(
        (dispute) => dispute.state !== "resolved"
      ).length,
    [disputes.data]
  );
  const activePolicyCount = useMemo(
    () => countActivePolicies(policies.data),
    [policies.data]
  );
  const liveLanes = useMemo(
    () =>
      buildLaneCards(
        jobs.data,
        sessions.data,
        strategyPositions.data,
        {
          policies: { presence: policiesPresence, activeCount: activePolicyCount },
          audit: { presence: feedPresence(audit) },
          disputes: { presence: feedPresence(disputes), openCount: openDisputeCount },
        },
        sessionsPresence,
        strategyPresence
      ),
    [
      activePolicyCount,
      audit,
      disputes,
      jobs.data,
      openDisputeCount,
      policiesPresence,
      sessions.data,
      sessionsPresence,
      strategyPresence,
      strategyPositions.data,
    ]
  );
  const policiesAppliedToday = useMemo(
    () => countPoliciesAppliedToday(policies.data),
    [policies.data]
  );
  const lastReceiptTime = useMemo(
    () => latestReceiptLabel(badges.data, badges.isLoading),
    [badges.data, badges.isLoading]
  );
  const liveJobs = extractRunJobs(jobs.data);
  // First-load orientation (A4): the card shows only when the room is
  // genuinely empty (no open runs, sessions, or receipts) AND those
  // requests have resolved — so it never flashes while data loads.
  const sessionsCount = Array.isArray(sessions.data) ? sessions.data.length : 0;
  const receiptsCount = extractRows(badges.data, [
    "badges",
    "receipts",
    "items",
    "data",
  ]).length;
  const roomActivityCount = liveJobs.length + sessionsCount + receiptsCount;
  const activityResolved =
    !jobs.isLoading && !sessions.isLoading && !badges.isLoading;
  const adminLifecycleSummary = useMemo(
    () => buildJobLifecycleSummary(providerOps.data),
    [providerOps.data]
  );
  const publicLifecycleSummary = useMemo(
    () => buildPublicJobLifecycleSummary(jobs.data),
    [jobs.data]
  );
  const hasAdminLifecycleData = adminLifecycleSummary.total > 0;
  const hasPublicLifecycleData = publicLifecycleSummary.total > 0;
  const lifecycleSummary = hasAdminLifecycleData
    ? adminLifecycleSummary
    : hasPublicLifecycleData
      ? publicLifecycleSummary
      : EMPTY_JOB_LIFECYCLE_SUMMARY;
  const hasLifecycleData = lifecycleSummary.total > 0;
  const lifecycleMeta = hasAdminLifecycleData
    ? "live API · /admin/status"
    : hasPublicLifecycleData
      ? "live API · /jobs"
      : jobs.isLoading
        ? "waiting for live API"
        : "no jobs yet";
  const liveProviderOps = useMemo(
    () => buildProviderOperations(providerOps.data ?? publicProviderOps.data),
    [providerOps.data, publicProviderOps.data]
  );
  const recurringRuntime = useMemo(
    () => buildRecurringRuntimeSummary(providerOps.data, feedPresence(providerOps)),
    [providerOps]
  );
  const providerRows = liveProviderOps;
  const hasLiveOverview = Boolean(jobs.data || sessions.data || account.data || strategyPositions.data);
  const vitals = vitalsWithLoadingHints;
  const alerts = endpointAlerts.length ? endpointAlerts : liveAlerts;
  const lanes = liveLanes;
  // Needs-action truth boundary: when the alert feed is locked (this
  // session lacks an operator role) or down, an empty list means "can't
  // see", not "nothing to do" — never render it as `0 open`.
  const alertsPresence = feedPresence(apiAlerts);
  const alertFeedBlocked = alertsPresence === "locked" || alertsPresence === "down";
  const alertsMeta = alertFeedBlocked
    ? `${alerts.length} visible · alert feed ${FEED_STATE_LABEL[alertsPresence]}`
    : alertsPresence === "loading"
      ? "loading"
      : `${alerts.length} open`;
  const alertsNotice = alertFeedBlocked
    ? alertsPresence === "locked"
      ? "The operator alert feed is locked for this session (no operator role on this wallet), so open alerts can't be listed here. What is shown comes from the feeds this session can read."
      : "The operator alert feed is unavailable right now, so open alerts can't be listed here. What is shown comes from the feeds this session can read."
    : undefined;
  const disputedSessions = Array.isArray(sessions.data)
    ? sessions.data.filter((session) => session?.status === "disputed").length
    : 0;

  const freshness = freshnessFromRequests(
    jobs,
    sessions,
    account,
    strategyPositions,
    health,
    apiAlerts,
    badges,
    policies,
    providerOps,
    publicProviderOps
  );
  const capabilityWarning = useMemo(
    () => buildCapabilityWarning(health.data),
    [health.data]
  );
  // Live SSE snapshot written by LiveDataBridge — the pulse card renders
  // the connection's real state instead of a hardcoded empty feed.
  const stream = useSyncExternalStore(
    subscribeStream,
    getStreamSnapshot,
    getStreamServerSnapshot
  );
  const pulseEvents = useMemo(() => buildPulseEvents(stream.events), [stream.events]);
  const pulseMeta =
    stream.state === "off"
      ? "event stream requires wallet sign-in"
      : `stream ${stream.state} · ${stream.events.length} recent events`;

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-7">
      <OverviewTopbar capabilityWarning={capabilityWarning} freshness={freshness} />
      <OrientationCard
        roomActivityCount={roomActivityCount}
        activityResolved={activityResolved}
      />
      <MissionHero
        // Use the explicit `hasLiveOverview` gate rather than `||`
        // fallbacks — the previous form (`liveJobs.length || 14`) silently
        // showed the fixture's `14` whenever live data legitimately
        // returned zero rows, masking real "queue is empty" signals.
        // Locked/down feeds render "—", never a fabricated zero.
        openRuns={hasLiveOverview ? liveJobs.length : 0}
        awaitingSignature={sessionsBlocked ? "—" : hasLiveOverview ? disputedSessions : 0}
        lastReceiptTime={lastReceiptTime}
        treasuryPosture={
          liveVitals[3]?.value === "Amber"
            ? "Amber"
            : liveVitals[3]?.value === "Green"
              ? "Green"
              : "Unknown"
        }
        policiesAppliedToday={policiesBlocked ? "—" : policiesAppliedToday}
      />
      <RoomVitals vitals={vitals} comparedTo={hasLiveOverview ? "live API" : "waiting for live API"} />
      <JobLifecycleStrip
        summary={hasLifecycleData ? lifecycleSummary : EMPTY_JOB_LIFECYCLE_SUMMARY}
        meta={lifecycleMeta}
      />
      <NeedsActionList alerts={alerts} meta={alertsMeta} notice={alertsNotice} />
      <LaneStatusGrid lanes={lanes} meta={hasLiveOverview ? "live API snapshot" : undefined} />
      <ProviderOperationsCard
        providers={providerRows}
        meta={
          liveProviderOps.length
            ? `${liveProviderOps.length} sources · live API`
            : "no provider operations reported"
        }
      />
      <RecurringRuntimeCard runtime={recurringRuntime} />
      <PlatformPulse
        events={pulseEvents}
        streamState={stream.state}
        endpoint="/events"
        meta={pulseMeta}
      />
    </div>
  );
}

function extractAlerts(data: unknown): AlertItem[] {
  if (!Array.isArray(data)) return [];
  return data.reduce<AlertItem[]>((alerts, item) => {
      if (!item || typeof item !== "object") return alerts;
      const record = item as Record<string, unknown>;
      const alert: AlertItem = {
        id: text(record.id, `alert-${String(record.title ?? "item")}`),
        tone: record.tone === "accent" ? "accent" : "warn",
        title: text(record.title, "Operator action needed"),
        body: text(record.body, ""),
        ctaLabel: text(record.ctaLabel, "Open ->"),
        ctaHref: text(record.ctaHref, "/runs"),
      };
      if (typeof record.ref === "string") {
        alert.ref = record.ref;
      }
      alerts.push(alert);
      return alerts;
    }, []);
}

function buildCapabilityWarning(data: unknown): CapabilityWarning | undefined {
  // Reads the operator-facing `/health` payload (post-#416 / Package B
  // truth split) and surfaces a single topbar chip when the treasury
  // capability is unavailable or degraded. Other capability warnings
  // are intentionally not surfaced in the overview topbar — the topbar
  // is the cross-cutting truth signal for "can this room actually move
  // money?". The full warnings[] array remains available to other UI.
  const root = asRecord(data);
  if (!root) return undefined;
  const capabilities = asRecord(root.capabilityHealth);
  const treasuryState = text(capabilities?.treasuryMutations, "");
  if (treasuryState !== "unavailable" && treasuryState !== "degraded") {
    return undefined;
  }

  const warnings = Array.isArray(root.warnings)
    ? root.warnings.filter(isRecord)
    : [];
  const treasuryWarning = warnings.find((warning) =>
    text(warning.code, "").startsWith("treasury_mutations_")
  );
  const fallback =
    treasuryState === "unavailable"
      ? "Treasury mutations are unavailable."
      : "Treasury mutations are degraded.";

  return {
    label: treasuryState === "unavailable" ? "Treasury unavailable" : "Treasury degraded",
    title: text(treasuryWarning?.message, fallback),
  };
}

function countActivePolicies(data: unknown): number {
  if (!Array.isArray(data)) return 0;
  return data.reduce((count, item) => {
    if (!item || typeof item !== "object") return count;
    const record = item as Record<string, unknown>;
    return text(record.state, "").toLowerCase() === "active" ? count + 1 : count;
  }, 0);
}

function countPoliciesAppliedToday(data: unknown): number {
  if (!Array.isArray(data)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  return data.reduce((count, item) => {
    if (!item || typeof item !== "object") return count;
    const record = item as Record<string, unknown>;
    if (text(record.state, "").toLowerCase() !== "active") return count;
    const lastChange = record.lastChange;
    const lastChangeRecord =
      lastChange && typeof lastChange === "object"
        ? (lastChange as Record<string, unknown>)
        : undefined;
    const dates = [record.activeSince, lastChangeRecord?.at];
    return dates.some((date) => isSameUtcDate(date, today)) ? count + 1 : count;
  }, 0);
}

function isSameUtcDate(value: unknown, today: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0] === today;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === today;
}

function latestReceiptLabel(data: unknown, isLoading: boolean): string {
  const rows = extractRows(data, ["badges", "receipts", "items", "data"]);
  const latest = rows
    .map((row) => {
      const averray = asRecord(asRecord(row.badge)?.averray) ?? asRecord(row.averray);
      return text(row.issuedAt, "") || text(averray?.completedAt, "");
    })
    .map((date) => Date.parse(date))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  if (latest) {
    return new Date(latest).toISOString().slice(11, 16) + " UTC";
  }
  return isLoading ? "loading" : "none";
}

function extractRows(data: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  const root = asRecord(data);
  if (!root) return [];
  for (const key of keys) {
    const value = root[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(asRecord(value));
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
