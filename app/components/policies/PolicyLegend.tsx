import { SeverityPill } from "./pills";

export function PolicyLegend() {
  return (
    <section className="flex flex-col gap-3">
      <p
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        How policies work
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card head="Scope" title="Which surface a policy gates">
          <ul className="grid gap-1 font-[family-name:var(--font-body)] text-[12.5px] text-[var(--avy-muted)]">
            <li><Mono>claim</Mono> — auto-claim gates on run output</li>
            <li><Mono>settle</Mono> — releasing USDC from escrow</li>
            <li><Mono>xcm</Mono> — outbound cross-chain messages</li>
            <li><Mono>badge</Mono> — reputation mint &amp; revoke</li>
            <li><Mono>co-sign</Mono> — default signer quorums</li>
            <li><Mono>worker</Mono> — stake &amp; wallet separation</li>
            <li><Mono>treasury</Mono> — budget, reserve, report</li>
          </ul>
        </Card>
        <Card head="Severity" title="What happens when the rule fails">
          <ul className="grid gap-2 font-[family-name:var(--font-body)] text-[12.5px] text-[var(--avy-muted)]">
            <li className="flex items-center gap-2">
              <SeverityPill severity="advisory" />
              <span>recorded on the receipt, no blocking</span>
            </li>
            <li className="flex items-center gap-2">
              <SeverityPill severity="gating" />
              <span>claim is paused, requires manual pass</span>
            </li>
            <li className="flex items-center gap-2">
              <SeverityPill severity="hard-stop" />
              <span>action refused, logged, no override</span>
            </li>
          </ul>
        </Card>
        <Card head="Quorum" title="How many signers are required">
          <ul className="grid gap-1 font-[family-name:var(--font-body)] text-[12.5px] text-[var(--avy-muted)]">
            <li>
              Required and total signer counts are emitted on each policy record.
            </li>
            <li>
              The policy table and drawer show the live quorum and approval state when the policy feed is readable.
            </li>
            <li>
              Proposals without enough signatures stay pending. No instant apply.
            </li>
          </ul>
        </Card>
      </div>
    </section>
  );
}

function Card({
  head,
  title,
  children,
}: {
  head: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <article className="flex flex-col gap-2 rounded-[10px] border border-[var(--avy-line)] bg-[rgba(255,253,247,0.7)] p-4">
      <span
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {head}
      </span>
      <h4 className="m-0 font-[family-name:var(--font-display)] text-[14px] font-bold text-[var(--avy-ink)]">
        {title}
      </h4>
      {children}
    </article>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="rounded-[4px] bg-[color:rgba(17,19,21,0.06)] px-1 py-px font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)]"
      style={{ letterSpacing: 0 }}
    >
      {children}
    </code>
  );
}
