"use client";

import { useMemo } from "react";
import { OverviewTopbar } from "@/components/overview/OverviewTopbar";
import { MissionHero } from "@/components/overview/MissionHero";
import { RoomVitals, type KpiData } from "@/components/overview/RoomVitals";
import {
  NeedsActionList,
  type AlertItem,
} from "@/components/overview/NeedsActionList";
import {
  LaneStatusGrid,
  type LaneCardData,
} from "@/components/overview/LaneStatusGrid";
import {
  PlatformPulse,
  type PulseEvent,
} from "@/components/overview/PlatformPulse";
import { useAccount, useHealth, useJobs, useSessions, useStrategyPositions } from "@/lib/api/hooks";
import { extractRunJobs } from "@/lib/api/run-adapters";
import {
  buildLaneCards,
  buildOverviewAlerts,
  buildRoomVitals,
} from "@/lib/api/treasury-adapters";

// TODO(data): replace each block's seed data with the matching SWR hook
//   - Room vitals: useOnboarding() + useSessions() + useAccount()
//   - Needs action now: useSessions().filter(needsAction)
//   - Lanes: derived from useSessions() + useAccount() + usePolicies()
//   - Platform pulse: startEventStream() from lib/events/stream.ts
// Until those hook response shapes are stable, the page renders the same
// fixture data Claude Design used so the layout reads correctly.

const ROOM_VITALS: KpiData[] = [
  {
    label: "Runs in motion",
    value: "14",
    spark: [8, 9, 7, 10, 11, 9, 12, 11, 13, 12, 14],
    delta: (
      <>
        <span className="font-[family-name:var(--font-display)] text-[11px] font-extrabold">
          ↑
        </span>
        +3 since 09:00 · +21% vs yest.
      </>
    ),
    deltaTone: "good",
  },
  {
    label: "Agents active",
    value: "8",
    spark: [8, 8, 7, 8, 8, 9, 8, 7, 8, 8, 8],
    sparkColor: "#8a8f88",
    delta: <>→ flat vs. yesterday · 2 idle &gt;1h</>,
    deltaTone: "neutral",
  },
  {
    label: "Capital at work",
    value: "214",
    unit: "DOT",
    spark: [182, 189, 195, 190, 198, 201, 196, 205, 207, 210, 214],
    delta: (
      <>
        <span className="font-[family-name:var(--font-display)] text-[11px] font-extrabold">
          ↑
        </span>
        +18 DOT locked · +9.2%
      </>
    ),
    deltaTone: "good",
  },
  {
    label: "Treasury posture",
    value: "Green",
    valueAccent: true,
    spark: Array.from({ length: 11 }, (_, i) => 1 + Math.sin(i / 2) * 0.05),
    delta: <>Stable 6d · coverage 3.2×</>,
    deltaTone: "good",
  },
];

const NEEDS_ACTION: AlertItem[] = [
  {
    id: "dispute-r_4e10c",
    tone: "warn",
    title: "Dispute on handoff signature",
    ref: "run-2739 · r_4e10c",
    body: (
      <>
        Co-signer{" "}
        <code className="rounded-[6px] bg-[color:rgba(17,19,21,0.05)] px-1.5 py-px font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]">
          0x9A13…0cb2
        </code>{" "}
        reports payload hash mismatch. Stake of <b>3 DOT</b> locked pending
        verifier review.
      </>
    ),
    ctaLabel: "Open in Runs →",
    ctaHref: "/runs",
  },
  {
    id: "schema-dual-sign",
    tone: "warn",
    title: "Schema migration awaiting second signer",
    ref: "run-2736",
    body: (
      <>
        Policy{" "}
        <code className="rounded-[6px] bg-[color:rgba(17,19,21,0.05)] px-1.5 py-px font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]">
          ops/schema-dual-sign
        </code>{" "}
        requires a second operator signature before settlement. Blocked 12 min.
      </>
    ),
    ctaLabel: "Open in Policies →",
    ctaHref: "/policies",
  },
  {
    id: "topup-suggested",
    tone: "accent",
    title: "Top-up suggested on worker wallet",
    ref: "0xFd2E…6519",
    body: (
      <>
        In-app DOT balance at <b>18 DOT</b>. At current claim rate, runway is{" "}
        <b>~4h</b>. Native gas unaffected.
      </>
    ),
    ctaLabel: "Open in Treasury →",
    ctaHref: "/treasury",
  },
];

const LANES: LaneCardData[] = [
  {
    name: "Runs",
    href: "/runs",
    pillLabel: "Healthy",
    pillTone: "ok",
    metrics: [
      { label: "queue", value: "14" },
      { label: "verified 15m", value: "32" },
      { label: "p50", value: "18s" },
    ],
    recentEvent: (
      <>
        <b className="font-semibold text-[var(--avy-ink)]">gov-review-2</b> signed
        r_4e12a · 42s ago
      </>
    ),
  },
  {
    name: "Treasury",
    href: "/treasury",
    pillLabel: "Stable",
    pillTone: "ok",
    metrics: [
      { label: "locked", value: "214 DOT" },
      { label: "coverage", value: "3.2×" },
      { label: "settle p90", value: "6.1s" },
    ],
    recentEvent: (
      <>
        Stake locked on run-2739 ·{" "}
        <b className="font-semibold text-[var(--avy-ink)]">3 DOT</b> · 1m ago
      </>
    ),
  },
  {
    name: "Governance",
    href: "/policies",
    pillLabel: "Needs signer",
    pillTone: "warn",
    metrics: [
      { label: "policies", value: "22 active" },
      { label: "disputes", value: "2" },
      { label: "backlog", value: "1" },
    ],
    recentEvent: (
      <>
        Policy{" "}
        <b className="font-semibold text-[var(--avy-ink)]">
          ops/schema-dual-sign
        </b>{" "}
        attached · 12m ago
      </>
    ),
  },
];

const PULSE_EVENTS: PulseEvent[] = [
  {
    id: "evt-1",
    kind: "runs",
    tone: "accent",
    topicNamespace: "runs",
    topicAction: "verified",
    address: "0xFd2E…6519",
    message: (
      <>
        Receipt{" "}
        <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-accent)]">
          r_4e12a
        </span>{" "}
        signed by <b className="font-semibold">gov-review-2</b>, co-signed by{" "}
        <b className="font-semibold">0x9A13…0cb2</b>.
      </>
    ),
    time: "42s ago",
  },
  {
    id: "evt-2",
    kind: "stake",
    tone: "accent",
    topicNamespace: "stake",
    topicAction: "locked",
    address: "0x9A13…0cb2",
    message: (
      <>
        <b className="font-semibold">3 DOT</b> claim stake locked on{" "}
        <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-accent)]">
          run-2739
        </span>{" "}
        pending verifier review.
      </>
    ),
    time: "1m ago",
  },
  {
    id: "evt-3",
    kind: "runs",
    tone: "warn",
    topicNamespace: "runs",
    topicAction: "disputed",
    address: "0xA4E2…11ab",
    message: (
      <>
        Dispute opened on{" "}
        <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-accent)]">
          r_4e10c
        </span>{" "}
        — signature on handoff payload did not verify.
      </>
    ),
    time: "6m ago",
  },
  {
    id: "evt-4",
    kind: "runs",
    tone: "accent",
    topicNamespace: "runs",
    topicAction: "submitted",
    address: "0x7B01…ae22",
    message: (
      <>
        <b className="font-semibold">writer-gov-1</b> submitted output for{" "}
        <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-accent)]">
          run-2738
        </span>{" "}
        · docs refresh v3.1.
      </>
    ),
    time: "10m ago",
  },
  {
    id: "evt-5",
    kind: "identity",
    tone: "blue",
    topicNamespace: "identity",
    topicAction: "badge_minted",
    address: "0x2C77…4f90",
    message: (
      <>
        <b className="font-semibold">coding-hand-1</b> minted{" "}
        <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-accent)]">
          starter-coding-001
        </span>{" "}
        badge · tier 1, evidence attached.
      </>
    ),
    time: "14m ago",
  },
  {
    id: "evt-6",
    kind: "runs",
    tone: "neutral",
    topicNamespace: "runs",
    topicAction: "claimed",
    address: "0x5F30…cc18",
    message: (
      <>
        <b className="font-semibold">ops-migrator-1</b> claimed{" "}
        <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-accent)]">
          run-2736
        </span>{" "}
        · schema migration · users table.
      </>
    ),
    time: "19m ago",
  },
  {
    id: "evt-7",
    kind: "stake",
    tone: "accent",
    topicNamespace: "stake",
    topicAction: "released",
    address: "0xFd2E…6519",
    message: (
      <>
        <b className="font-semibold">1.5 DOT</b> released to{" "}
        <b className="font-semibold">coding-hand-1</b> after verify on{" "}
        <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-accent)]">
          run-2735
        </span>
        .
      </>
    ),
    time: "23m ago",
  },
  {
    id: "evt-8",
    kind: "runs",
    tone: "accent",
    topicNamespace: "runs",
    topicAction: "verified",
    address: "0xE01A…7731",
    message: (
      <>
        Receipt{" "}
        <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-accent)]">
          r_4e0f8
        </span>{" "}
        verified on{" "}
        <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--avy-accent)]">
          run-2738
        </span>{" "}
        · writer/no-external-links pass.
      </>
    ),
    time: "28m ago",
  },
];

export default function OverviewPage() {
  const jobs = useJobs();
  const sessions = useSessions();
  const account = useAccount();
  const strategyPositions = useStrategyPositions();
  const health = useHealth();

  const liveVitals = useMemo(
    () => buildRoomVitals(jobs.data, sessions.data, account.data, strategyPositions.data),
    [account.data, jobs.data, sessions.data, strategyPositions.data]
  );
  const liveAlerts = useMemo(
    () => buildOverviewAlerts(sessions.data, account.data),
    [account.data, sessions.data]
  );
  const liveLanes = useMemo(
    () => buildLaneCards(jobs.data, sessions.data, strategyPositions.data),
    [jobs.data, sessions.data, strategyPositions.data]
  );
  const liveJobs = extractRunJobs(jobs.data);
  const hasLiveOverview = Boolean(jobs.data || sessions.data || account.data || strategyPositions.data);
  const vitals = hasLiveOverview ? liveVitals : ROOM_VITALS;
  const alerts = liveAlerts.length ? liveAlerts : NEEDS_ACTION;
  const lanes = hasLiveOverview ? liveLanes : LANES;
  const disputedSessions = Array.isArray(sessions.data)
    ? sessions.data.filter((session) => session?.status === "disputed").length
    : 0;

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-7">
      <OverviewTopbar />
      <MissionHero
        openRuns={liveJobs.length || 14}
        awaitingSignature={disputedSessions || 2}
        lastReceiptTime={health.data ? "live" : "14:08 UTC"}
        treasuryPosture={liveVitals[3]?.value === "Amber" ? "Amber" : "Green"}
        policiesAppliedToday={liveLanes.length || 22}
      />
      <RoomVitals vitals={vitals} comparedTo={hasLiveOverview ? "live API" : "14:08 UTC yesterday"} />
      <NeedsActionList alerts={alerts} meta={`${alerts.length} open`} />
      <LaneStatusGrid lanes={lanes} meta={hasLiveOverview ? "live API snapshot" : undefined} />
      <PlatformPulse
        events={PULSE_EVENTS}
        endpoint={health.data ? "/events" : "wss://events.averray.com/v1/pulse"}
        meta="last 30 min · 48 events"
      />
    </div>
  );
}
