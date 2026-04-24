import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Sparkline } from "@/components/overview/Sparkline";
import { SectionEyebrow } from "./SectionEyebrow";

export interface BalanceCard {
  label: string;
  value: string;
  unit?: string;
  spark: number[];
  sparkColor?: string;
  delta: { value: string; tone: "up" | "down" | "flat"; pct: string };
  warn?: boolean;
  /** Debt card: cap bar + "Cap X · headroom Y" */
  cap?: { label: string; fill: number };
}

export interface BalanceSheetStripProps {
  cards: BalanceCard[];
  scope: ReactNode;
}

export function BalanceSheetStrip({ cards, scope }: BalanceSheetStripProps) {
  return (
    <div>
      <SectionEyebrow label="Balance sheet · rolling 24h" scope={scope} />
      <div className="grid grid-cols-1 overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] shadow-[var(--shadow-card)] backdrop-blur-[10px] md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card, i) => (
          <BalanceCell key={card.label} card={card} isLast={i === cards.length - 1} />
        ))}
      </div>
    </div>
  );
}

function BalanceCell({ card, isLast }: { card: BalanceCard; isLast: boolean }) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-2.5 p-[18px_20px]",
        !isLast && "xl:border-r border-[var(--avy-line-soft)]",
        card.warn &&
          "bg-gradient-to-b from-[rgba(244,227,207,0.55)] to-transparent to-[60%]"
      )}
      style={{ gridTemplateRows: "auto 1fr auto" }}
    >
      <span
        className={cn(
          "flex items-center gap-2 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase",
          card.warn ? "text-[var(--avy-warn)]" : "text-[var(--avy-muted)]"
        )}
        style={{ letterSpacing: "0.12em" }}
      >
        {card.label}
      </span>

      <span
        className={cn(
          "font-[family-name:var(--font-mono)] text-[30px] font-semibold leading-none tabular-nums",
          card.warn ? "text-[var(--avy-warn)]" : "text-[var(--avy-ink)]"
        )}
        style={{ letterSpacing: "-0.01em" }}
      >
        {card.value}
        {card.unit ? (
          <span className="ml-1 text-[15px] font-medium text-[var(--avy-muted)]">
            {card.unit}
          </span>
        ) : null}
      </span>

      <Sparkline
        points={card.spark}
        color={card.sparkColor ?? (card.warn ? "var(--avy-warn)" : "var(--avy-accent)")}
        width={120}
        height={34}
        className="block w-full"
      />

      <div className="flex justify-between gap-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
        <span
          className={cn(
            card.delta.tone === "up" && !card.warn && "text-[var(--avy-accent)]",
            card.delta.tone === "down" && "text-[var(--avy-warn)]",
            card.delta.tone === "up" && card.warn && "text-[var(--avy-warn)]"
          )}
        >
          {card.delta.value}
        </span>
        <span>{card.delta.pct}</span>
      </div>

      {card.cap ? (
        <div className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-warn)]">
          <div className="mt-0.5 h-1 overflow-hidden rounded-[2px] bg-[color:rgba(167,97,34,0.14)]">
            <span
              className="block h-full bg-[var(--avy-warn)]"
              style={{ width: `${card.cap.fill}%` }}
            />
          </div>
          <span className="mt-1 block">{card.cap.label}</span>
        </div>
      ) : null}
    </div>
  );
}
