import type { KpiData } from "@/components/overview/RoomVitals";
import type { LaneCardData } from "@/components/overview/LaneStatusGrid";
import type { AlertItem } from "@/components/overview/NeedsActionList";
import type { BalanceCard } from "@/components/treasury/BalanceSheetStrip";
import type { PositionCard } from "@/components/treasury/AccountPositionsGrid";
import type { ActiveLoan } from "@/components/treasury/CreditLinePanel";
import type { StrategyLane } from "@/components/treasury/StrategyRoutingTable";

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" ? (value as RawRecord) : {};
}

function asArray(value: unknown): RawRecord[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  for (const key of ["items", "positions", "strategies", "sessions", "jobs"]) {
    if (Array.isArray(record[key])) return record[key].map(asRecord);
  }
  return [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapTotal(value: unknown): number {
  const record = asRecord(value);
  return Object.values(record).reduce<number>((sum, entry) => sum + numberValue(entry), 0);
}

function fmt(value: unknown): string {
  const parsed = numberValue(value);
  return parsed.toLocaleString("en-US", { maximumFractionDigits: parsed >= 100 ? 0 : 2 });
}

function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

function spark(seed: number): number[] {
  return Array.from({ length: 16 }, (_, i) => Math.max(3, seed + Math.sin(i / 2) * 5 + i / 4));
}

function isActiveClaim(job: RawRecord): boolean {
  const state = text(job.effectiveState, text(job.claimState, text(job.state))).toLowerCase();
  if (state !== "claimed") return false;
  const expiresAt = text(job.claimExpiresAt);
  return !expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) > Date.now();
}

function activeClaimJobs(jobsPayload: unknown): RawRecord[] {
  return asArray(jobsPayload).filter((job) => isActiveClaim(job) && text(job.claimedBy));
}

function sessionKey(session: RawRecord): string {
  return text(session.sessionId, `${text(session.jobId)}:${text(session.wallet)}`);
}

function activeWorkSessions(jobsPayload: unknown, sessionsPayload: unknown): RawRecord[] {
  const sessions = asArray(sessionsPayload);
  const seen = new Set(sessions.map(sessionKey).filter(Boolean));
  const claimSessions = activeClaimJobs(jobsPayload)
    .map((job) => ({
      sessionId: text(job.sessionId, `${text(job.id)}:${text(job.claimedBy)}`),
      jobId: text(job.id),
      wallet: text(job.claimedBy),
      status: "claimed",
      claimedAt: text(job.claimedAt),
    }))
    .filter((session) => {
      const key = sessionKey(session);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return [...sessions, ...claimSessions];
}

export function buildBalanceCards(accountPayload: unknown, strategyPayload: unknown): BalanceCard[] {
  const account = asRecord(accountPayload);
  const summary = asRecord(asRecord(strategyPayload).summary);
  const liquid = numberValue(summary.liquid, mapTotal(account.liquid));
  const allocated = numberValue(summary.allocated, mapTotal(account.strategyAllocated));
  const collateral = mapTotal(account.collateralLocked);
  const debt = numberValue(summary.debt, mapTotal(account.debtOutstanding));
  const capacity = numberValue(summary.borrowCapacity, collateral ? collateral / 1.5 : 0);
  const debtFill = pct(debt, debt + capacity);

  return [
    {
      label: "Spendable",
      value: fmt(liquid),
      unit: "DOT",
      spark: spark(18),
      delta: { value: "live balance", tone: "flat", pct: "now" },
    },
    {
      label: "Capital at work",
      value: fmt(allocated),
      unit: "DOT",
      spark: spark(24),
      delta: { value: `${numberValue(summary.deployedLanes)} lanes`, tone: "flat", pct: "routed" },
    },
    {
      label: "Collateral",
      value: fmt(collateral),
      unit: "DOT",
      spark: spark(14),
      delta: { value: "live account", tone: "flat", pct: "locked" },
    },
    {
      label: `Debt · ${debtFill}% of cap`,
      value: fmt(debt),
      unit: "DOT",
      spark: spark(28),
      delta: { value: "live debt", tone: debtFill >= 80 ? "up" : "flat", pct: `${debtFill}%` },
      warn: debtFill >= 80,
      cap: { label: `Capacity ${fmt(debt + capacity)} · headroom ${fmt(capacity)}`, fill: debtFill },
    },
  ];
}

export function buildStrategyLanes(strategyPayload: unknown): StrategyLane[] {
  return asArray(asRecord(strategyPayload).positions).map((position, index) => {
    const routed = numberValue(position.routedAmount ?? position.shares);
    const attention = Boolean(position.attention);
    const status = attention ? "warn" : routed > 0 ? "ok" : "blocked";
    return {
      id: text(position.strategyId, `lane-${index + 1}`),
      laneTitle: text(position.strategyId, `Strategy ${index + 1}`),
      laneMeta: `${text(position.assetSymbol, text(position.asset, "DOT"))} · ${text(position.executionMode, "sync")}`,
      strategyKind: text(position.riskLabel, text(position.yieldLabel, "strategy")),
      allocated: `${fmt(routed)} ${text(position.assetSymbol, "DOT")}`,
      coverage: numberValue(position.deploymentShareBps) ? Math.round(numberValue(position.deploymentShareBps) / 100) : routed > 0 ? 100 : 0,
      status,
      statusLabel: text(position.statusLabel, status === "ok" ? "Routed" : "Idle"),
      allocatePrimary: !routed && !attention,
      allocateDisabled: status === "blocked",
    };
  });
}

export function buildPositionCards(accountPayload: unknown, strategyPayload: unknown): PositionCard[] {
  const account = asRecord(accountPayload);
  const summary = asRecord(asRecord(strategyPayload).summary);
  const liquid = numberValue(summary.liquid, mapTotal(account.liquid));
  const allocated = numberValue(summary.allocated, mapTotal(account.strategyAllocated));
  const collateral = mapTotal(account.collateralLocked);
  const reserved = mapTotal(account.reserved);
  const staked = mapTotal(account.jobStakeLocked);
  const debt = numberValue(summary.debt, mapTotal(account.debtOutstanding));

  return [
    { label: "Liquid", value: fmt(liquid), unit: "DOT", meta: "Spendable now" },
    { label: "Reserved", value: fmt(reserved), unit: "DOT", meta: "Escrow reserved" },
    { label: "Allocated", value: fmt(allocated), unit: "DOT", meta: "Strategy lanes" },
    { label: "Staked", value: fmt(staked || collateral), unit: "DOT", meta: staked ? "Claim stake locked" : "Collateral locked" },
    { label: "Debt", value: fmt(debt), unit: "DOT", meta: "Outstanding", debt: debt > 0 },
  ];
}

export function buildLoans(accountPayload: unknown): ActiveLoan[] {
  const debt = asRecord(asRecord(accountPayload).debtOutstanding);
  return Object.entries(debt)
    .filter(([, amount]) => numberValue(amount) > 0)
    .map(([asset, amount]) => ({
      id: `debt-${asset.toLowerCase()}`,
      name: `${asset} debt`,
      sub: "live account liability",
      amount: fmt(amount),
      amountUnit: asset,
    }));
}

export function buildCreditLine(accountPayload: unknown, borrowPayload: unknown) {
  const account = asRecord(accountPayload);
  const debt = mapTotal(account.debtOutstanding);
  const borrowCapacity = numberValue(asRecord(borrowPayload).borrowCapacity);
  const total = debt + borrowCapacity;
  const usedPct = pct(debt, total);
  return {
    capacityUsed: fmt(debt),
    capacityTotal: `${fmt(total)} DOT`,
    usedPct,
    headerPct: Math.max(0, 100 - usedPct),
    headroom: `${fmt(borrowCapacity)} DOT`,
    nextMark: "live",
    policyCap: "85%",
    loans: buildLoans(accountPayload),
  };
}

export function buildRoomVitals(jobsPayload: unknown, sessionsPayload: unknown, accountPayload: unknown, strategyPayload: unknown): KpiData[] {
  const jobs = asArray(jobsPayload);
  const sessions = activeWorkSessions(jobsPayload, sessionsPayload);
  const account = asRecord(accountPayload);
  const summary = asRecord(asRecord(strategyPayload).summary);
  const capital = numberValue(summary.allocated, mapTotal(account.strategyAllocated) + mapTotal(account.jobStakeLocked));
  const attentionCount = numberValue(summary.attentionCount);
  const activeAgents = new Set(sessions.map((s) => text(s.wallet)).filter(Boolean)).size;

  return [
    { label: "Runs in motion", value: jobs.length || sessions.length, spark: spark(12), delta: "live jobs + sessions", deltaTone: "good" },
    { label: "Agents active", value: activeAgents || "-", spark: spark(8), sparkColor: "#8a8f88", delta: activeAgents ? "from active claims" : "from session history", deltaTone: "neutral" },
    { label: "Capital at work", value: fmt(capital), unit: "DOT", spark: spark(20), delta: "strategy + stake", deltaTone: "good" },
    { label: "Treasury posture", value: attentionCount ? "Amber" : "Green", valueAccent: !attentionCount, spark: spark(1), delta: attentionCount ? `${attentionCount} lane attention` : "No lane attention", deltaTone: attentionCount ? "warn" : "good" },
  ];
}

export function buildOverviewAlerts(sessionsPayload: unknown, accountPayload: unknown): AlertItem[] {
  const sessions = asArray(sessionsPayload);
  const disputed = sessions.filter((session) => text(session.status) === "disputed").slice(0, 2);
  const liquid = mapTotal(asRecord(accountPayload).liquid);
  const alerts: AlertItem[] = disputed.map((session) => ({
    id: `session-${text(session.sessionId)}`,
    tone: "warn",
    title: "Disputed session needs review",
    ref: text(session.jobId),
    body: `Session ${text(session.sessionId)} is disputed and waiting for operator attention.`,
    ctaLabel: "Open in Sessions ->",
    ctaHref: "/sessions",
  }));
  if (liquid > 0 && liquid < 20) {
    alerts.push({
      id: "low-liquid",
      tone: "accent",
      title: "Top-up suggested on worker wallet",
      ref: `${fmt(liquid)} DOT`,
      body: "Spendable DOT is below the suggested operating buffer.",
      ctaLabel: "Open in Treasury ->",
      ctaHref: "/treasury",
    });
  }
  return alerts;
}

export function buildLaneCards(jobsPayload: unknown, sessionsPayload: unknown, strategyPayload: unknown): LaneCardData[] {
  const jobs = asArray(jobsPayload);
  const sessions = activeWorkSessions(jobsPayload, sessionsPayload);
  const summary = asRecord(asRecord(strategyPayload).summary);
  const disputed = sessions.filter((session) => text(session.status) === "disputed").length;
  const attention = numberValue(summary.attentionCount);
  const latestSessionStatus = text(sessions[0]?.status, "claimed");

  return [
    {
      name: "Runs",
      href: "/runs",
      pillLabel: jobs.length ? "Live" : "Ready",
      pillTone: "ok",
      metrics: [
        { label: "queue", value: `${jobs.length}` },
        { label: "sessions", value: `${sessions.length}` },
        { label: "disputed", value: `${disputed}` },
      ],
      recentEvent: sessions[0] ? `Latest session ${latestSessionStatus}` : "No live sessions yet",
    },
    {
      name: "Treasury",
      href: "/treasury",
      pillLabel: attention ? "Attention" : "Stable",
      pillTone: attention ? "warn" : "ok",
      metrics: [
        { label: "locked", value: `${fmt(numberValue(summary.allocated))} DOT` },
        { label: "lanes", value: `${numberValue(summary.deployedLanes)}` },
        { label: "debt", value: `${fmt(numberValue(summary.debt))}` },
      ],
      recentEvent: attention ? `${attention} lane needs attention` : "Strategy lanes reporting normally",
    },
    {
      name: "Governance",
      href: "/policies",
      pillLabel: disputed ? "Needs review" : "Quiet",
      pillTone: disputed ? "warn" : "neutral",
      metrics: [
        { label: "policies", value: "pending" },
        { label: "disputes", value: `${disputed}` },
        { label: "audit", value: "live" },
      ],
      recentEvent: disputed ? "Dispute queue has open work" : "No live governance alerts",
    },
  ];
}
