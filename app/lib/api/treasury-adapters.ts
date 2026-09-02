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

function assetEntries(value: unknown): Array<[string, number]> {
  return Object.entries(asRecord(value))
    .map(([asset, amount]) => [asset, numberValue(amount)] as [string, number])
    .filter(([asset, amount]) => Boolean(asset.trim()) && amount > 0);
}

function firstAssetUnit(...values: unknown[]): string | undefined {
  for (const value of values) {
    const asset = Object.keys(asRecord(value)).find((key) => key.trim());
    if (asset) return asset;
  }
  return undefined;
}

function combinedAssetBucket(...values: unknown[]): RawRecord {
  return values.reduce<RawRecord>((combined, value) => {
    for (const [asset, amount] of Object.entries(asRecord(value))) {
      combined[asset] = numberValue(combined[asset]) + numberValue(amount);
    }
    return combined;
  }, {});
}

function assetAmount(bucket: unknown, fallbackValue: unknown, fallbackUnit: string) {
  const entries = assetEntries(bucket);
  if (entries.length === 1) {
    return { value: entries[0][1], unit: entries[0][0], mixed: false };
  }
  if (entries.length > 1) {
    return {
      value: entries.reduce((sum, [, amount]) => sum + amount, 0),
      unit: "mixed",
      mixed: true,
    };
  }
  return { value: numberValue(fallbackValue), unit: fallbackUnit, mixed: false };
}

function strategyAssetUnit(strategyPayload: unknown, fallbackUnit: string): string {
  const units = new Set(
    asArray(asRecord(strategyPayload).positions)
      .filter((position) => numberValue(position.routedAmount ?? position.shares) > 0)
      .map((position) => text(position.assetSymbol, text(position.asset)))
      .filter(Boolean)
  );
  if (units.size === 1) return [...units][0];
  if (units.size > 1) return "mixed";
  return fallbackUnit;
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
  const accountUnit =
    firstAssetUnit(
      account.liquid,
      account.reserved,
      account.strategyAllocated,
      account.collateralLocked,
      account.debtOutstanding
    ) ?? "USDC";
  const liquid = assetAmount(account.liquid, summary.liquid, accountUnit);
  const allocated = assetAmount(
    account.strategyAllocated,
    summary.allocated,
    strategyAssetUnit(strategyPayload, accountUnit)
  );
  const collateral = assetAmount(account.collateralLocked, undefined, accountUnit);
  const debt = assetAmount(account.debtOutstanding, summary.debt, accountUnit);
  const capacity = numberValue(
    summary.borrowCapacity,
    collateral.unit === "DOT" && collateral.value ? collateral.value / 1.5 : 0
  );
  const debtFill = debt.unit === "DOT" ? pct(debt.value, debt.value + capacity) : 0;
  const debtCap = debt.unit === "DOT"
    ? { label: `Capacity ${fmt(debt.value + capacity)} DOT · headroom ${fmt(capacity)}`, fill: debtFill }
    : { label: `DOT borrow capacity ${fmt(capacity)} · debt shown in ${debt.unit}`, fill: 0 };

  return [
    {
      label: "Spendable",
      value: fmt(liquid.value),
      unit: liquid.unit,
      spark: spark(18),
      delta: { value: "live balance", tone: "flat", pct: "now" },
    },
    {
      label: "Capital at work",
      value: fmt(allocated.value),
      unit: allocated.unit,
      spark: spark(24),
      delta: { value: `${numberValue(summary.deployedLanes)} lanes`, tone: "flat", pct: "routed" },
    },
    {
      label: "Collateral",
      value: fmt(collateral.value),
      unit: collateral.unit,
      spark: spark(14),
      delta: { value: "live account", tone: "flat", pct: "locked" },
    },
    {
      label: debt.unit === "DOT" ? `Debt · ${debtFill}% of cap` : "Debt",
      value: fmt(debt.value),
      unit: debt.unit,
      spark: spark(28),
      delta: {
        value: debt.unit === "DOT" ? "live debt" : "asset-aware debt",
        tone: debtFill >= 80 ? "up" : "flat",
        pct: debt.unit === "DOT" ? `${debtFill}%` : debt.unit,
      },
      warn: debtFill >= 80,
      cap: debtCap,
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
  const accountUnit =
    firstAssetUnit(
      account.liquid,
      account.reserved,
      account.strategyAllocated,
      account.collateralLocked,
      account.jobStakeLocked,
      account.debtOutstanding
    ) ?? "USDC";
  const liquid = assetAmount(account.liquid, summary.liquid, accountUnit);
  const allocated = assetAmount(
    account.strategyAllocated,
    summary.allocated,
    strategyAssetUnit(strategyPayload, accountUnit)
  );
  const collateral = assetAmount(account.collateralLocked, undefined, accountUnit);
  const reserved = assetAmount(account.reserved, undefined, accountUnit);
  const staked = assetAmount(account.jobStakeLocked, undefined, accountUnit);
  const debt = assetAmount(account.debtOutstanding, summary.debt, accountUnit);
  const locked = staked.value > 0 ? staked : collateral;

  return [
    { label: "Liquid", value: fmt(liquid.value), unit: liquid.unit, meta: "Spendable now" },
    { label: "Reserved", value: fmt(reserved.value), unit: reserved.unit, meta: "Escrow reserved" },
    { label: "Allocated", value: fmt(allocated.value), unit: allocated.unit, meta: "Strategy lanes" },
    {
      label: "Staked",
      value: fmt(locked.value),
      unit: locked.unit,
      meta: staked.value > 0 ? "Claim stake locked" : "Collateral locked",
    },
    { label: "Debt", value: fmt(debt.value), unit: debt.unit, meta: "Outstanding", debt: debt.value > 0 },
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
  const borrow = asRecord(borrowPayload);
  const asset = text(borrow.asset, "DOT");
  const debt = numberValue(asRecord(account.debtOutstanding)[asset]);
  const borrowCapacity = numberValue(asRecord(borrowPayload).borrowCapacity);
  const total = debt + borrowCapacity;
  const usedPct = pct(debt, total);
  return {
    capacityUsed: fmt(debt),
    capacityTotal: `${fmt(total)} ${asset}`,
    usedPct,
    headerPct: Math.max(0, 100 - usedPct),
    headroom: `${fmt(borrowCapacity)} ${asset}`,
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
  const accountUnit =
    firstAssetUnit(account.strategyAllocated, account.jobStakeLocked, account.liquid) ?? "USDC";
  const capital = assetAmount(
    combinedAssetBucket(account.strategyAllocated, account.jobStakeLocked),
    summary.allocated,
    strategyAssetUnit(strategyPayload, accountUnit)
  );
  const attentionCount = numberValue(summary.attentionCount);
  const activeAgents = new Set(sessions.map((s) => text(s.wallet)).filter(Boolean)).size;

  return [
    {
      label: "Runs in motion",
      value: jobs.length || sessions.length,
      spark: spark(12),
      // Both surfaces feed this card: every open job in the catalog
      // plus every active session pulled from /admin/sessions
      // (operator-wide, includes external-agent claims). The hint
      // makes that obvious so a reader doesn't think the number is
      // wallet-scoped.
      delta: "open jobs + operator-wide sessions",
      deltaTone: "good",
    },
    {
      label: "Agents active",
      value: activeAgents || "-",
      spark: spark(8),
      sparkColor: "#8a8f88",
      delta: activeAgents
        ? "distinct wallets · operator-wide"
        : "no claims observed yet · operator-wide",
      deltaTone: "neutral",
    },
    { label: "Capital at work", value: fmt(capital.value), unit: capital.unit, spark: spark(20), delta: "strategy + stake", deltaTone: "good" },
    { label: "Treasury posture", value: attentionCount ? "Amber" : "Green", valueAccent: !attentionCount, spark: spark(1), delta: attentionCount ? `${attentionCount} lane attention` : "No lane attention", deltaTone: attentionCount ? "warn" : "good" },
  ];
}

export function buildOverviewAlerts(sessionsPayload: unknown, accountPayload: unknown): AlertItem[] {
  const sessions = asArray(sessionsPayload);
  const disputed = sessions.filter((session) => text(session.status) === "disputed").slice(0, 2);
  const account = asRecord(accountPayload);
  const liquid = assetAmount(account.liquid, 0, firstAssetUnit(account.liquid) ?? "USDC");
  const alerts: AlertItem[] = disputed.map((session) => ({
    id: `session-${text(session.sessionId)}`,
    tone: "warn",
    title: "Disputed session needs review",
    ref: text(session.jobId),
    body: `Session ${text(session.sessionId)} is disputed and waiting for operator attention.`,
    ctaLabel: "Open in Sessions ->",
    ctaHref: "/sessions",
  }));
  if (liquid.value > 0 && liquid.value < 20) {
    alerts.push({
      id: "low-liquid",
      tone: "accent",
      title: "Top-up suggested on worker wallet",
      ref: `${fmt(liquid.value)} ${liquid.unit}`,
      body: "Spendable balance is below the suggested operating buffer.",
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
