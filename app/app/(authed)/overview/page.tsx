"use client";

import { useMemo } from "react";
import { OverviewTopbar } from "@/components/overview/OverviewTopbar";
import { MissionHero } from "@/components/overview/MissionHero";
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
  useBadges,
  useHealth,
  useJobs,
  usePolicies,
  useProviderOperations,
  usePublicProviderOperations,
  useStrategyPositions,
} from "@/lib/api/hooks";
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

export default function OverviewPage() {
  const jobs = useJobs();
  const sessions = useAdminSessions();
  const account = useAccount();
  const strategyPositions = useStrategyPositions();
  const health = useHealth();
  const apiAlerts = useAlerts();
  const badges = useBadges();
  const policies = usePolicies();
  const providerOps = useProviderOperations();
  const publicProviderOps = usePublicProviderOperations();

  const liveVitals = useMemo(
    () => buildRoomVitals(jobs.data, sessions.data, account.data, strategyPositions.data),
    [account.data, jobs.data, sessions.data, strategyPositions.data]
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
  const liveLanes = useMemo(
    () => buildLaneCards(jobs.data, sessions.data, strategyPositions.data),
    [jobs.data, sessions.data, strategyPositions.data]
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
    () => buildRecurringRuntimeSummary(providerOps.data),
    [providerOps.data]
  );
  const providerRows = liveProviderOps;
  const hasLiveOverview = Boolean(jobs.data || sessions.data || account.data || strategyPositions.data);
  const vitals = vitalsWithLoadingHints;
  const alerts = endpointAlerts.length ? endpointAlerts : liveAlerts;
  const lanes = liveLanes;
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

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-7">
      <OverviewTopbar freshness={freshness} />
      <MissionHero
        // Use the explicit `hasLiveOverview` gate rather than `||`
        // fallbacks — the previous form (`liveJobs.length || 14`) silently
        // showed the fixture's `14` whenever live data legitimately
        // returned zero rows, masking real "queue is empty" signals.
        openRuns={hasLiveOverview ? liveJobs.length : 0}
        awaitingSignature={hasLiveOverview ? disputedSessions : 0}
        lastReceiptTime={lastReceiptTime}
        treasuryPosture={liveVitals[3]?.value === "Amber" ? "Amber" : "Green"}
        policiesAppliedToday={policiesAppliedToday}
      />
      <RoomVitals vitals={vitals} comparedTo={hasLiveOverview ? "live API" : "waiting for live API"} />
      <JobLifecycleStrip
        summary={hasLifecycleData ? lifecycleSummary : EMPTY_JOB_LIFECYCLE_SUMMARY}
        meta={lifecycleMeta}
      />
      <NeedsActionList alerts={alerts} meta={`${alerts.length} open`} />
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
        events={[]}
        endpoint="/events"
        meta="event stream requires wallet"
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
