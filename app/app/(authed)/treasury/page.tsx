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
  useTreasurySummary,
} from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";
import { feedPresence } from "@/lib/api/feed-presence";
import {
  buildBalanceCards,
  buildCreditLine,
  buildPolicyGateItems,
  buildPositionCards,
  buildStrategyLanes,
  buildXcmObserverPhases,
  treasuryFeedAvailable,
  treasuryHasWarnings,
} from "@/lib/api/treasury-adapters";

export default function TreasuryPage() {
  const account = useAccount();
  const treasurySummary = useTreasurySummary();
  const treasuryPresence = feedPresence(treasurySummary);
  const creditAvailable = treasuryFeedAvailable(treasurySummary.data, "creditLine");
  const creditPresence = treasuryPresence === "live" && !creditAvailable ? "down" : treasuryPresence;

  const liveBalanceCards = useMemo(
    () => buildBalanceCards(account.data, treasurySummary.data),
    [account.data, treasurySummary.data]
  );
  const liveLanes = useMemo(
    () => treasuryFeedAvailable(treasurySummary.data, "strategyLanes")
      ? buildStrategyLanes(treasurySummary.data)
      : [],
    [treasurySummary.data]
  );
  const livePositions = useMemo(
    () => buildPositionCards(account.data, treasurySummary.data),
    [account.data, treasurySummary.data]
  );
  const liveCredit = useMemo(
    () => buildCreditLine(account.data, asFeed(treasurySummary.data, "creditLine")),
    [account.data, treasurySummary.data]
  );
  const xcmPhases = useMemo(() => buildXcmObserverPhases(treasurySummary.data), [treasurySummary.data]);
  const policyItems = useMemo(() => buildPolicyGateItems(treasurySummary.data), [treasurySummary.data]);
  const accountScope = useMemo(() => accountScopeLabel(account.data), [account.data]);
  const signerLabel = useMemo(() => accountSignerLabel(account.data), [account.data]);
  const balanceCards = liveBalanceCards;
  const lanes = liveLanes;
  const positions = livePositions;
  const loans = liveCredit.loans;

  const requestFreshness = freshnessFromRequests(account, treasurySummary);
  const freshness = requestFreshness === "live" && treasuryHasWarnings(treasurySummary.data)
    ? "fallback"
    : requestFreshness;

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <TreasuryTopbar freshness={freshness} />
      <BalanceSheetStrip
        cards={balanceCards}
        scope="AgentAccountCore · asset hub"
      />
      <StrategyRoutingTable
        lanes={lanes}
        sub={treasuryFeedAvailable(treasurySummary.data, "strategyLanes")
          ? `${lanes.length} lanes · live wrapper registry`
          : "strategy lanes not emitted by API yet"}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CreditLinePanel
          presence={creditPresence}
          sub={creditAvailable ? "CreditPool + AgentAccountCore · live reads" : "cap not emitted by API yet"}
          capacityAvailable={liveCredit.capacityAvailable}
          capacityUsed={liveCredit.capacityUsed}
          capacityTotal={liveCredit.capacityTotal}
          usedPct={liveCredit.usedPct}
          headerPct={liveCredit.headerPct}
          headroom={liveCredit.headroom}
          loans={loans}
        />
        <XcmObserverLane
          phases={xcmPhases}
          sub={xcmPhases.length ? "dispatcher + observer · indexed evidence" : "XCM observer not emitted by API yet"}
        />
      </div>

      <AccountPositionsGrid
        cards={positions}
        scope={accountScope}
      />

      <PolicyGateFooter
        items={policyItems}
        sub={policyItems.length ? "TreasuryPolicy · live reads" : "policy gate feed not emitted by API yet"}
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

function asFeed(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as Record<string, unknown>)[key];
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
