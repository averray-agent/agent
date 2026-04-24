import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface TreasuryPanelProps {
  eyebrow: string;
  title: string;
  sub?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Shared panel chrome for strategy-routing, credit-line, xcm, policy
 * sections. Translucent paper, sage eyebrow, display title, mono sub.
 */
export function TreasuryPanel({
  eyebrow,
  title,
  sub,
  children,
  className,
}: TreasuryPanelProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] shadow-[var(--shadow-card)] backdrop-blur-[10px]",
        className
      )}
    >
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--avy-line-soft)] px-4 py-3.5">
        <div className="flex flex-col gap-0.5">
          <span
            className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
            style={{ letterSpacing: "0.12em" }}
          >
            {eyebrow}
          </span>
          <h3 className="m-0 font-[family-name:var(--font-display)] text-[15px] font-bold text-[var(--avy-ink)]">
            {title}
          </h3>
        </div>
        {sub ? (
          <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
            {sub}
          </span>
        ) : null}
      </header>
      {children}
    </div>
  );
}
