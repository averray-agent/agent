import { BalanceSheetStrip, type BalanceCard } from "@/components/treasury/BalanceSheetStrip";
import { PolicyGateFooter, type PolicyItem } from "@/components/treasury/PolicyGateFooter";
import { DataFreshnessPill, type FreshnessState } from "@/components/shell/DataFreshnessPill";

export function MobileTreasury({
  cards,
  policyItems,
  policySub,
  scope,
  freshness,
}: {
  cards: BalanceCard[];
  policyItems: PolicyItem[];
  policySub: string;
  scope: string;
  freshness: FreshnessState;
}) {
  return (
    <section className="flex flex-col gap-5 min-[1080px]:hidden" data-mobile-layout="treasury">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--avy-accent)]">Capital</p>
          <h1 className="mt-1 text-[1.75rem] font-bold text-[var(--avy-ink)]">Treasury</h1>
        </div>
        <DataFreshnessPill state={freshness} />
      </header>
      <BalanceSheetStrip cards={cards} scope={scope} layout="mobile" />
      <PolicyGateFooter items={policyItems} sub={policySub} />
    </section>
  );
}
