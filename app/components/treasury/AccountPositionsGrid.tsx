import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { SectionEyebrow } from "./SectionEyebrow";

export interface PositionCard {
  label: string;
  value: string;
  unit?: string;
  meta: string;
  debt?: boolean;
}

export interface AccountPositionsGridProps {
  cards: PositionCard[];
  scope: ReactNode;
}

export function AccountPositionsGrid({ cards, scope }: AccountPositionsGridProps) {
  return (
    <div>
      <SectionEyebrow label="Account positions" scope={scope} />
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-5">
        {cards.map((card) => (
          <PositionCardTile key={card.label} card={card} />
        ))}
      </div>
    </div>
  );
}

function PositionCardTile({ card }: { card: PositionCard }) {
  return (
    <div
      className={cn(
        "grid gap-1 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-3 backdrop-blur-[8px]",
        card.debt &&
          "border-[color:rgba(167,97,34,0.18)] bg-[var(--avy-paper-solid)]"
      )}
    >
      <span
        className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {card.label}
      </span>
      <span
        className={cn(
          "font-[family-name:var(--font-mono)] text-[18px] tabular-nums",
          card.debt ? "text-[var(--avy-warn)]" : "text-[var(--avy-ink)]"
        )}
        style={{ letterSpacing: "-0.01em" }}
      >
        {card.value}
        {card.unit ? (
          <span className="ml-0.5 text-[11px] text-[var(--avy-muted)]">{card.unit}</span>
        ) : null}
      </span>
      <span
        className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {card.meta}
      </span>
    </div>
  );
}
