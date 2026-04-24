import { TreasuryPanel } from "./TreasuryPanel";

export interface XcmPhase {
  step: string;
  title: string;
  pending: number;
  lastEventMsg: string;
  lastEventMeta: string;
  nextLabel: string;
  nextValue: string;
}

export interface XcmObserverLaneProps {
  phases: XcmPhase[];
  sub: string;
}

export function XcmObserverLane({ phases, sub }: XcmObserverLaneProps) {
  return (
    <TreasuryPanel eyebrow="XCM observer" title="Request → observe → settle" sub={sub}>
      <div className="grid grid-cols-1 md:grid-cols-3">
        {phases.map((phase, i) => (
          <PhaseColumn
            key={phase.step}
            phase={phase}
            isLast={i === phases.length - 1}
          />
        ))}
      </div>
    </TreasuryPanel>
  );
}

function PhaseColumn({ phase, isLast }: { phase: XcmPhase; isLast: boolean }) {
  return (
    <div className="relative grid gap-2.5 p-4 md:border-r border-[var(--avy-line-soft)] last:border-r-0">
      <span
        className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {phase.step}
      </span>
      <div className="flex items-baseline gap-2">
        <span className="font-[family-name:var(--font-display)] text-[14px] font-bold text-[var(--avy-ink)]">
          {phase.title}
        </span>
        <span
          className="rounded-full bg-[var(--avy-accent-soft)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[var(--avy-accent)]"
          style={{ letterSpacing: 0 }}
        >
          {phase.pending} pending
        </span>
      </div>

      <div className="grid gap-0.5 rounded-r-[6px] border-l-2 border-[var(--avy-accent)] bg-[color:rgba(30,102,66,0.05)] px-2.5 py-2">
        <span
          className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Last event
        </span>
        <span className="font-[family-name:var(--font-body)] text-[12.5px] leading-[1.4] text-[var(--avy-ink)]">
          {phase.lastEventMsg}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {phase.lastEventMeta}
        </span>
      </div>

      <div
        className="flex justify-between border-t border-dashed border-[var(--avy-line-soft)] pt-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        <span>{phase.nextLabel}</span>
        <span className="text-[var(--avy-ink)]">{phase.nextValue}</span>
      </div>

      {/* Arrow connector — only between phases, hidden on last and on mobile */}
      {!isLast ? (
        <span
          aria-hidden="true"
          className="absolute -right-[9px] top-[22px] z-[1] hidden h-[18px] w-[18px] place-items-center rounded-full border border-[var(--avy-line)] bg-[var(--avy-bg)] font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)] md:grid"
        >
          →
        </span>
      ) : null}
    </div>
  );
}
