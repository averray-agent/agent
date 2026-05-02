"use client";

import { useMemo } from "react";
import { TreasuryTopbar } from "@/components/treasury/TreasuryTopbar";
import {
  BalanceSheetStrip,
  type BalanceCard,
} from "@/components/treasury/BalanceSheetStrip";
import {
  StrategyRoutingTable,
  type StrategyLane,
} from "@/components/treasury/StrategyRoutingTable";
import { CreditLinePanel } from "@/components/treasury/CreditLinePanel";
import {
  XcmObserverLane,
  type XcmPhase,
} from "@/components/treasury/XcmObserverLane";
import {
  AccountPositionsGrid,
  type PositionCard,
} from "@/components/treasury/AccountPositionsGrid";
import {
  PolicyGateFooter,
  type PolicyItem,
} from "@/components/treasury/PolicyGateFooter";
import {
  useAccount,
  useBorrowCapacity,
  useStrategyPositions,
} from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";
import {
  buildBalanceCards,
  buildCreditLine,
  buildPositionCards,
  buildStrategyLanes,
} from "@/lib/api/treasury-adapters";

const BALANCE_CARDS: BalanceCard[] = [
  {
    label: "Spendable",
    value: "482,140",
    unit: "DOT",
    spark: [22, 21, 23, 19, 20, 17, 18, 15, 16, 13, 15, 11, 13, 10, 12, 9].map(
      (v) => 34 - v
    ),
    delta: { value: "+8,120 ↑ 24h", tone: "up", pct: "+1.71%" },
  },
  {
    label: "Capital at work",
    value: "1,064,908",
    unit: "DOT",
    spark: [18, 17, 19, 16, 18, 15, 16, 13, 14, 11, 13, 10, 11, 9, 10, 8].map(
      (v) => 34 - v
    ),
    delta: { value: "+2,400 ↑ 24h", tone: "up", pct: "+0.23%" },
  },
  {
    label: "Collateral",
    value: "612,500",
    unit: "DOT",
    spark: [14, 14, 13, 14, 13, 13, 12, 13, 12, 12, 12, 11, 12, 11, 11, 11].map(
      (v) => 34 - v
    ),
    delta: { value: "+500 ↑ 24h", tone: "up", pct: "steady" },
  },
  {
    label: "Debt · 82% of cap",
    value: "502,220",
    unit: "DOT",
    spark: [25, 24, 22, 23, 21, 20, 19, 17, 18, 15, 14, 13, 11, 10, 9, 8].map(
      (v) => 34 - v
    ),
    delta: { value: "+14,700 ↑ 24h", tone: "up", pct: "+3.02%" },
    warn: true,
    cap: { label: "Cap 612,500 · headroom 110,280", fill: 82 },
  },
];

const LANES: StrategyLane[] = [
  {
    id: "lane-01",
    laneTitle: "Hydration passive LP",
    laneMeta: "lane-01 · hydra-dx",
    strategyKind: "dex/provide-liq",
    allocated: "312,000 DOT",
    coverage: 96,
    status: "ok",
    statusLabel: "Covered",
  },
  {
    id: "lane-02",
    laneTitle: "Bifrost vDOT bond",
    laneMeta: "lane-02 · bifrost",
    strategyKind: "stake/liquid",
    allocated: "248,500 DOT",
    coverage: 91,
    status: "ok",
    statusLabel: "Covered",
  },
  {
    id: "lane-03",
    laneTitle: "Asset hub reserve",
    laneMeta: "lane-03 · asset-hub",
    strategyKind: "reserve/hold",
    allocated: "180,000 DOT",
    coverage: 100,
    status: "ok",
    statusLabel: "Covered",
  },
  {
    id: "lane-04",
    laneTitle: "Acala aUSD float",
    laneMeta: "lane-04 · acala",
    strategyKind: "cdp/stable-mint",
    allocated: "142,308 DOT",
    coverage: 68,
    status: "warn",
    statusLabel: "Attention",
    allocatePrimary: true,
  },
  {
    id: "lane-05",
    laneTitle: "Moonbeam xcGLMR bridge",
    laneMeta: "lane-05 · moonbeam",
    strategyKind: "bridge/xcm-v3",
    allocated: "98,400 DOT",
    coverage: 54,
    status: "warn",
    statusLabel: "Attention",
  },
  {
    id: "lane-06",
    laneTitle: "Interlay iBTC vault",
    laneMeta: "lane-06 · interlay",
    strategyKind: "vault/collateral",
    allocated: "62,700 DOT",
    coverage: 41,
    status: "blocked",
    statusLabel: "Blocked",
    allocateDisabled: true,
  },
  {
    id: "lane-07",
    laneTitle: "Phala worker bond",
    laneMeta: "lane-07 · phala",
    strategyKind: "compute/bond",
    allocated: "21,000 DOT",
    coverage: 88,
    status: "ok",
    statusLabel: "Covered",
  },
];

const XCM_PHASES: XcmPhase[] = [
  {
    step: "Phase 01 · request",
    title: "Request",
    pending: 2,
    lastEventMsg: "xcm.send → acala · 62,000 DOT dispatched",
    lastEventMeta: "14:07:41 · block #24,918,425",
    nextLabel: "Next poll",
    nextValue: "+06s",
  },
  {
    step: "Phase 02 · observe",
    title: "Observe",
    pending: 1,
    lastEventMsg: "xcm.received · 80,000 DOT · from hydra-dx",
    lastEventMeta: "14:06:18 · relay receipt r_8c0a",
    nextLabel: "Next relay check",
    nextValue: "+12s",
  },
  {
    step: "Phase 03 · settle",
    title: "Settle",
    pending: 1,
    lastEventMsg: "Settled · 48,300 DOT credited to spendable",
    lastEventMeta: "14:04:09 · receipt r_8bfe",
    nextLabel: "Next finality tick",
    nextValue: "+02s",
  },
];

const POSITIONS: PositionCard[] = [
  {
    label: "Liquid",
    value: "482,140",
    unit: "DOT",
    meta: "Spendable now",
  },
  {
    label: "Reserved",
    value: "64,000",
    unit: "DOT",
    meta: "XCM in-flight · 4 msgs",
  },
  {
    label: "Allocated",
    value: "1,064,908",
    unit: "DOT",
    meta: "Across 7 lanes",
  },
  {
    label: "Staked",
    value: "248,500",
    unit: "DOT",
    meta: "Bifrost · 21d unbond",
  },
  {
    label: "Debt",
    value: "502,220",
    unit: "DOT",
    meta: "2 loans · 82% of cap",
    debt: true,
  },
];

const POLICIES: PolicyItem[] = [
  // Each row carries a consistent `Role · who/what` prefix so the
  // enforcement mode reads at a glance (manual co-sign / governance
  // review / contract-enforced). The right-side detail varies by
  // enforcement type but the left-side label is uniform across rows.
  {
    tag: "treasury/alloc-dual-sign",
    name: "Allocations > 50k DOT require co-signer",
    meta: "Blocks any Allocate/Deallocate action on lanes 01, 02, 04, 05 without a second signer.",
    signerNote: (
      <>
        <b className="font-semibold text-[var(--avy-ink)]">Signers</b> ·{" "}
        <span>0xFd2E…6519</span> + <span>0x9A13…0cb2</span>
      </>
    ),
  },
  {
    tag: "treasury/debt-cap-85",
    name: "Debt may not exceed 85% of collateral",
    meta: "Currently at 82%. New borrows auto-blocked at 85%. Debt card tints warn when ≥ 80%.",
    signerNote: (
      <>
        <b className="font-semibold text-[var(--avy-ink)]">Owner</b> ·
        governance council · quarterly review · next 2026-07-01
      </>
    ),
  },
  {
    tag: "xcm/observe-before-settle",
    name: "No settle without an observe-receipt",
    meta: "Phase 03 cannot run until phase 02 has recorded a relay receipt. Enforced per-lane.",
    signerNote: (
      <>
        <b className="font-semibold text-[var(--avy-ink)]">Enforcement</b> ·
        AgentAccountCore contract · non-overridable
      </>
    ),
  },
];

export default function TreasuryPage() {
  const account = useAccount();
  const strategyPositions = useStrategyPositions();
  const borrowCapacity = useBorrowCapacity("DOT");

  const liveBalanceCards = useMemo(
    () => buildBalanceCards(account.data, strategyPositions.data),
    [account.data, strategyPositions.data]
  );
  const liveLanes = useMemo(
    () => buildStrategyLanes(strategyPositions.data),
    [strategyPositions.data]
  );
  const livePositions = useMemo(
    () => buildPositionCards(account.data, strategyPositions.data),
    [account.data, strategyPositions.data]
  );
  const liveCredit = useMemo(
    () => buildCreditLine(account.data, borrowCapacity.data),
    [account.data, borrowCapacity.data]
  );
  const balanceCards = liveBalanceCards;
  const lanes = liveLanes;
  const positions = livePositions;
  const loans = liveCredit.loans;

  const freshness = freshnessFromRequests(account, strategyPositions);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <TreasuryTopbar freshness={freshness} />
      <BalanceSheetStrip
        cards={balanceCards}
        scope="AgentAccountCore · asset hub"
      />
      <StrategyRoutingTable
        lanes={lanes}
        sub={`${lanes.length} lanes · ${strategyPositions.error ? "unavailable" : "live API"} · strategy positions`}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CreditLinePanel
          capacityUsed={liveCredit.capacityUsed}
          capacityTotal={liveCredit.capacityTotal}
          usedPct={liveCredit.usedPct}
          headerPct={liveCredit.headerPct}
          headroom={liveCredit.headroom}
          nextMark={liveCredit.nextMark}
          policyCap={liveCredit.policyCap}
          loans={loans}
        />
        <XcmObserverLane phases={[]} sub="XCM observer not emitted by API yet" />
      </div>

      <AccountPositionsGrid
        cards={positions}
        scope="0xFd2EAE2043…Fd6519 · AgentAccountCore"
      />

      <PolicyGateFooter
        items={[]}
        sub="policy gate feed not emitted by API yet"
      />

      <p className="flex flex-wrap gap-x-5 gap-y-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]">
        <span>
          Scope ·{" "}
          <b className="font-semibold text-[var(--avy-ink)]">
            treasury · operator surface
          </b>
        </span>
        <span>
          Network ·{" "}
          <b className="font-semibold text-[var(--avy-ink)]">Polkadot asset hub</b>
        </span>
        <span>
          Signer ·{" "}
          <b className="font-semibold text-[var(--avy-ink)]">0xFd2E…6519</b>
        </span>
        <span>All actions are operator-initiated · every action emits a signed receipt</span>
      </p>
    </div>
  );
}
