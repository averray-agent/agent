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
import { JobLifecycleStrip } from "@/components/overview/JobLifecycleStrip";
import {
  useAccount,
  useAdminSessions,
  useAlerts,
  useHealth,
  useJobs,
  useProviderOperations,
  usePublicProviderOperations,
  useStrategyPositions,
} from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";
import { extractRunJobs } from "@/lib/api/run-adapters";
import { buildProviderOperations } from "@/lib/api/provider-operations";
import {
  buildJobLifecycleSummary,
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
  const providerOps = useProviderOperations();
  const publicProviderOps = usePublicProviderOperations();

  const liveVitals = useMemo(
    () => buildRoomVitals(jobs.data, sessions.data, account.data, strategyPositions.data),
    [account.data, jobs.data, sessions.data, strategyPositions.data]
  );
  const liveAlerts = useMemo(
    () => buildOverviewAlerts(sessions.data, account.data),
    [account.data, sessions.data]
  );
  const endpointAlerts = useMemo(() => extractAlerts(apiAlerts.data), [apiAlerts.data]);
  const liveLanes = useMemo(
    () => buildLaneCards(jobs.data, sessions.data, strategyPositions.data),
    [jobs.data, sessions.data, strategyPositions.data]
  );
  const liveJobs = extractRunJobs(jobs.data);
  const lifecycleSummary = useMemo(
    () => buildJobLifecycleSummary(providerOps.data),
    [providerOps.data]
  );
  const hasLifecycleData = lifecycleSummary.total > 0;
  const liveProviderOps = useMemo(
    () => buildProviderOperations(providerOps.data ?? publicProviderOps.data),
    [providerOps.data, publicProviderOps.data]
  );
  const providerRows = liveProviderOps;
  const hasLiveOverview = Boolean(jobs.data || sessions.data || account.data || strategyPositions.data);
  const vitals = liveVitals;
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
        lastReceiptTime={health.data ? "live" : "unavailable"}
        treasuryPosture={liveVitals[3]?.value === "Amber" ? "Amber" : "Green"}
        policiesAppliedToday={hasLiveOverview ? liveLanes.length : 0}
      />
      <RoomVitals vitals={vitals} comparedTo={hasLiveOverview ? "live API" : "waiting for live API"} />
      <JobLifecycleStrip
        summary={hasLifecycleData ? lifecycleSummary : EMPTY_JOB_LIFECYCLE_SUMMARY}
        meta={hasLifecycleData ? "live API · /admin/status" : "no jobs yet"}
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

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
