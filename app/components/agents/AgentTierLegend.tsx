export function AgentTierLegend() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <LegendCard
        head="Tier ladder"
        title="How tiers are assigned"
        body={
          <>
            The roster uses the tier returned by the profile API: <Code>T1 apprentice</Code>,{" "}
            <Code>T2 journeyman</Code>, or <Code>T3 expert</Code>. The raw score is not
            reinterpreted into a different tier in this interface.
          </>
        }
      />
      <LegendCard
        head="Reputation"
        title="Where the score comes from"
        body={
          <>
            The displayed value is the current reputation score returned by the API.
            No historical trend is shown because the roster payload has no time series.
          </>
        }
      />
      <LegendCard
        head="Slash causes"
        title="What triggers a slash"
        body={
          <>
            Stake is slashed when a handoff signature fails to verify, a claim is
            abandoned after lock, or a dispute is upheld. Slashes cite a receipt and
            appear on the public profile.
          </>
        }
      />
    </div>
  );
}

function LegendCard({
  head,
  title,
  body,
}: {
  head: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <article className="rounded-[10px] border border-[var(--avy-line)] bg-[rgba(255,253,247,0.7)] px-4 py-3.5">
      <div
        className="mb-2 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {head}
      </div>
      <h4 className="mb-1 font-[family-name:var(--font-display)] text-[14px] font-bold text-[var(--avy-ink)]">
        {title}
      </h4>
      <p className="m-0 font-[family-name:var(--font-body)] text-[12.5px] leading-[1.5] text-[var(--avy-muted)]">
        {body}
      </p>
    </article>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="rounded-[4px] bg-[color:rgba(17,19,21,0.06)] px-1.5 py-px font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
      style={{ letterSpacing: 0 }}
    >
      {children}
    </code>
  );
}
