import type { ReactNode } from "react";

export function MobileRunsSurface({
  filters,
  lifecycleToggle,
  queue,
  error,
}: {
  filters: ReactNode;
  lifecycleToggle?: ReactNode;
  queue: ReactNode;
  error?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3.5 min-[1080px]:hidden" data-mobile-layout="runs">
      <details className="group rounded-[12px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] md:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 font-[family-name:var(--font-display)] text-xs font-extrabold uppercase tracking-[0.08em] text-[var(--avy-ink)] [&::-webkit-details-marker]:hidden">
          Filter runs
          <span aria-hidden className="text-[var(--avy-accent)] transition-transform group-open:rotate-180">⌄</span>
        </summary>
        <div className="grid gap-2 border-t border-[var(--avy-line-soft)] p-3">{filters}</div>
      </details>
      <div className="hidden gap-2 md:grid">{filters}</div>
      {lifecycleToggle}
      {queue}
      {error}
    </section>
  );
}
