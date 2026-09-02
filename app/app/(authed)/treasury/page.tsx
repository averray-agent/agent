"use client";

import { useMemo } from "react";
import { TreasuryTopbar } from "@/components/treasury/TreasuryTopbar";
import { BalanceSheetStrip } from "@/components/treasury/BalanceSheetStrip";
import { StrategyRoutingTable } from "@/components/treasury/StrategyRoutingTable";
import { CreditLinePanel } from "@/components/treasury/CreditLinePanel";
import { XcmObserverLane } from "@/components/treasury/XcmObserverLane";
import { AccountPositionsGrid } from "@/components/treasury/AccountPositionsGrid";
import { PolicyGateFooter } from "@/components/treasury/PolicyGateFooter";
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
  const accountScope = useMemo(() => accountScopeLabel(account.data), [account.data]);
  const signerLabel = useMemo(() => accountSignerLabel(account.data), [account.data]);
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
        scope={accountScope}
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
          <b className="font-semibold text-[var(--avy-ink)]">{signerLabel}</b>
        </span>
        <span>All actions are operator-initiated · every action emits a signed receipt</span>
      </p>
    </div>
  );
}

function accountScopeLabel(payload: unknown): string {
  const wallet = accountWallet(payload);
  return wallet ? `${shortAddress(wallet)} · AgentAccountCore` : "AgentAccountCore";
}

function accountSignerLabel(payload: unknown): string {
  const wallet = accountWallet(payload);
  return wallet ? shortAddress(wallet) : "wallet unavailable";
}

function accountWallet(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  return text(record.wallet) || text(record.account) || text(record.address);
}

function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
