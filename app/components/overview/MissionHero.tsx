export interface MissionHeroProps {
  openRuns: number;
  awaitingSignature: number;
  lastReceiptTime: string;
  treasuryPosture: "Green" | "Amber" | "Red";
  policiesAppliedToday: number;
}

export function MissionHero({
  openRuns,
  awaitingSignature,
  lastReceiptTime,
  treasuryPosture,
  policiesAppliedToday,
}: MissionHeroProps) {
  return (
    <section className="pb-2 pt-1">
      <p
        className="mb-[0.9rem] font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.14em" }}
      >
        <span className="mr-2.5 inline-block h-px w-[22px] bg-[var(--avy-accent)] align-middle" />
        Mission board
      </p>
      <h1
        className="mb-3 max-w-[20ch] font-[family-name:var(--font-display)] font-bold text-[var(--avy-ink)]"
        style={{ fontSize: "clamp(2.2rem, 3.4vw, 3.1rem)", lineHeight: 1.02 }}
      >
        See the room at a glance.
      </h1>
      <p className="m-0 max-w-[62ch] font-[family-name:var(--font-body)] text-[1.025rem] leading-[1.55] text-[var(--avy-muted)]">
        Runs, capital, and governance in one pane — evidence first, vibes never.
        Every number on this page links to the receipt that produced it.
      </p>
      <div className="mt-[1.1rem] flex flex-wrap gap-x-5 gap-y-2 border-t border-[var(--avy-line-soft)] pt-4 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
        <span>
          <b className="font-semibold text-[var(--avy-ink)]">{openRuns}</b> open runs ·{" "}
          <b className="font-semibold text-[var(--avy-ink)]">{awaitingSignature}</b> awaiting signature
        </span>
        <span>
          Last receipt ·{" "}
          <b className="font-semibold text-[var(--avy-ink)]">{lastReceiptTime}</b>
        </span>
        <span>
          Treasury posture ·{" "}
          <b className="font-semibold" style={{ color: "var(--avy-accent)" }}>
            {treasuryPosture}
          </b>
        </span>
        <span>
          Policies applied today ·{" "}
          <b className="font-semibold text-[var(--avy-ink)]">{policiesAppliedToday}</b>
        </span>
      </div>
    </section>
  );
}
