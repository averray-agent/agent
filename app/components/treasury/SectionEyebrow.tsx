import type { ReactNode } from "react";

export interface SectionEyebrowProps {
  label: string;
  scope: ReactNode;
}

/**
 * Sage eyebrow + muted scope note shown above the balance-sheet strip and
 * the account-positions grid. Different from the overview SectionHead —
 * this one is wider (no bullet dot) and the label is sage not muted.
 */
export function SectionEyebrow({ label, scope }: SectionEyebrowProps) {
  return (
    <div
      className="mb-0.5 flex items-center justify-between px-0.5 pt-1 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
      style={{ letterSpacing: "0.12em" }}
    >
      <span>{label}</span>
      <span className="font-[family-name:var(--font-mono)] text-[11px] font-medium normal-case tracking-normal text-[var(--avy-muted)]">
        {scope}
      </span>
    </div>
  );
}
