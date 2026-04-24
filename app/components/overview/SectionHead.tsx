import type { ReactNode } from "react";

export interface SectionHeadProps {
  title: string;
  meta?: ReactNode;
}

export function SectionHead({ title, meta }: SectionHeadProps) {
  return (
    <div className="mb-3.5 flex items-baseline justify-between">
      <span
        className="flex items-center gap-2.5 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)]" />
        {title}
      </span>
      {meta ? (
        <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
          {meta}
        </span>
      ) : null}
    </div>
  );
}
