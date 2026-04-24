export function DisputesLegend() {
  return (
    <section className="flex flex-col gap-3">
      <p
        className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.12em" }}
      >
        How disputes resolve
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card head="Origins" title="Why a dispute opens">
          <ul className="grid gap-1 font-[family-name:var(--font-body)] text-[12.5px] leading-snug text-[var(--avy-muted)]">
            <li><Mono>signature</Mono> — alg / fields / ttl mismatch</li>
            <li><Mono>schema</Mono> — output fails the bound JSON schema</li>
            <li><Mono>co-sign-missing</Mono> — quorum not met inside window</li>
            <li><Mono>policy-violation</Mono> — gating policy refused the payload</li>
            <li><Mono>timeout</Mono> — worker didn't submit before the run expired</li>
          </ul>
        </Card>
        <Card head="Window" title="How long operators have">
          <p className="m-0 font-[family-name:var(--font-body)] text-[12.5px] leading-snug text-[var(--avy-muted)]">
            Each origin carries its own window from the active policy. The
            default is <b className="font-semibold text-[var(--avy-ink)]">30
            minutes</b> — at 90% elapsed the countdown pulses amber, at 100% the
            dispute auto-escalates to <Mono>verifier-2</Mono>. Request-more
            pauses the window; ignored evidence requests eventually expire too.
          </p>
        </Card>
        <Card head="Slash mechanics" title="Where stake goes on uphold">
          <ul className="grid gap-1 font-[family-name:var(--font-body)] text-[12.5px] leading-snug text-[var(--avy-muted)]">
            <li>
              <b className="font-semibold text-[var(--avy-ink)]">Worker portion</b>{" "}
              (typ. 60%) slashed to treasury per <Mono>badge/revoke-on-dispute@v1</Mono>
            </li>
            <li>
              <b className="font-semibold text-[var(--avy-ink)]">Verifier portion</b>{" "}
              (typ. 25%) paid to the signer who caught it
            </li>
            <li>
              <b className="font-semibold text-[var(--avy-ink)]">Treasury portion</b>{" "}
              (typ. 15%) retained as dispute-reserve contribution
            </li>
            <li>Badges earned through the disputed run are auto-suspended.</li>
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
