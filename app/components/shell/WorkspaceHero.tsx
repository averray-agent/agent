import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface WorkspaceHeroProps {
  eyebrow: string;
  title: string;
  blurb: string;
  actions?: ReactNode;
  className?: string;
}

export function WorkspaceHero({ eyebrow, title, blurb, actions, className }: WorkspaceHeroProps) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] px-7 py-6 shadow-[var(--shadow-sm)]",
        className
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight md:text-[28px]">
            {title}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{blurb}</p>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </section>
  );
}
