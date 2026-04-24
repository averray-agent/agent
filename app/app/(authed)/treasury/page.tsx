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

export const metadata = { title: "Treasury · Averray" };

// TODO(data): wire each block to its hook in lib/api/hooks.ts
//   - Balance sheet: useAccount() + useBorrowCapacity()
//   - Strategy routing: useStrategyPositions() + useStrategies()
//   - Credit line: useBorrowCapacity(asset)
//   - XCM observer: dedicated hook (not in SDK yet — backend exposes
//     staged /account/xcm/* endpoints once async observer lands)
//   - Account positions: derived from useAccount()
//   - Policy gate: useStrategies() + onboarding manifest
// Until the hook response shapes are stable, the page renders the same
// fixture data Claude Design used so the layout reads correctly.

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
  {
    tag: "treasury/alloc-dual-sign",
    name: "Allocations > 50k DOT require co-signer",
    meta: "Blocks any Allocate/Deallocate action on lanes 01, 02, 04, 05 without a second signer.",
    signerNote: (
      <>
        Signer <b className="font-semibold text-[var(--avy-ink)]">0xFd2E…6519</b> ·
        co-signer{" "}
        <b className="font-semibold text-[var(--avy-ink)]">0x9A13…0cb2</b>
      </>
    ),
  },
  {
    tag: "treasury/debt-cap-85",
    name: "Debt may not exceed 85% of collateral",
    meta: "Currently at 82%. New borrows auto-blocked at 85%. Debt card tints warn when ≥ 80%.",
    signerNote: <>Governance review · quarterly · next 2026-07-01</>,
  },
  {
    tag: "xcm/observe-before-settle",
    name: "No settle without an observe-receipt",
    meta: "Phase 03 cannot run until phase 02 has recorded a relay receipt. Enforced per-lane.",
    signerNote: (
      <>
        Enforced by{" "}
        <b className="font-semibold text-[var(--avy-ink)]">AgentAccountCore</b> ·
        non-overridable
      </>
    ),
  },
];

export default function TreasuryPage() {
  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <TreasuryTopbar />
      <BalanceSheetStrip
        cards={BALANCE_CARDS}
        scope="AgentAccountCore · asset hub"
      />
      <StrategyRoutingTable
        lanes={LANES}
        sub="7 lanes · 1,064,908 DOT routed · policy gov/alloc-dual-sign"
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CreditLinePanel
          capacityUsed="502,220"
          capacityTotal="612,500 DOT"
          usedPct={82}
          headerPct={3}
          headroom="110,280 DOT"
          nextMark="14:15 UTC"
          policyCap="85%"
          loans={[
            {
              id: "loan-0a14",
              name: "USDC · bridge float",
              sub: "loan-0a14 · opened 2026-04-19 · maturity 2026-05-19",
              amount: "312,000",
              amountUnit: "DOT equiv.",
            },
            {
              id: "loan-0a18",
              name: "aUSD · working capital",
              sub: "loan-0a18 · opened 2026-04-22 · maturity rolling",
              amount: "190,220",
              amountUnit: "DOT equiv.",
            },
          ]}
        />
        <XcmObserverLane phases={XCM_PHASES} sub="lane xcm-v3 · 4 in flight" />
      </div>

      <AccountPositionsGrid
        cards={POSITIONS}
        scope="0xFd2EAE2043…Fd6519 · AgentAccountCore"
      />

      <PolicyGateFooter
        items={POLICIES}
        sub="3 active · last change 2026-04-22 by 0x9A13…0cb2"
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
