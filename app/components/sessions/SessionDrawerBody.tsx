"use client";

import { DrawerSection } from "@/components/shell/DetailDrawer";
import { SessionStatePill, VerifierModeChip } from "./pills";
import { WorkerChip } from "./WorkerChip";
import { VerticalLifecycleRail } from "./VerticalLifecycleRail";
import { EscrowLedger } from "./EscrowLedger";
import { PayoutTrail } from "./PayoutTrail";
import type { SessionDetail } from "./types";

export function SessionDrawerBody({ session }: { session: SessionDetail }) {
  return (
    <>
      <DrawerSection title="Session">
        <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <SessionStatePill state={session.state} />
            <VerifierModeChip mode={session.verifierMode} />
            <span
              className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              policy · <span className="text-[var(--avy-ink)]">{session.policy}</span>
            </span>
          </div>
          <div>
            <div className="font-[family-name:var(--font-display)] text-[15px] font-bold text-[var(--avy-ink)]">
              {session.job.title}
            </div>
            <div
              className="mt-0.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {session.job.meta}
            </div>
          </div>
          <WorkerChip
            tone={session.worker.tone}
            initials={session.worker.initials}
            handle={session.worker.handle}
            address={session.worker.address}
          />
          <div
            className="flex flex-wrap gap-4 border-t border-[var(--avy-line-soft)] pt-2.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            <span>
              Run · <span className="text-[var(--avy-ink)]">{session.runRef}</span>
            </span>
            <span>
              Escrow ·{" "}
              <span className="text-[var(--avy-ink)]">
                {session.escrow.amount} {session.escrow.asset}
              </span>
            </span>
            <span>
              Opened · <span className="text-[var(--avy-ink)]">{session.openedAt}</span>
            </span>
            {session.receipt ? (
              <span>
                Receipt ·{" "}
                <span className="text-[var(--avy-accent)]">{session.receipt}</span>
              </span>
            ) : null}
            {session.disputeHref ? (
              <a
                href={session.disputeHref}
                className="border-b border-dashed border-[color:rgba(140,42,23,0.4)] text-[#8c2a17] hover:text-[#6a2010]"
              >
                Open dispute →
              </a>
            ) : null}
          </div>
        </div>
      </DrawerSection>

      <DrawerSection title="Lifecycle">
        <VerticalLifecycleRail stages={session.lifecycle} />
      </DrawerSection>

      <DrawerSection title={`Escrow ledger · ${session.movements.length} movements`}>
        <EscrowLedger movements={session.movements} />
      </DrawerSection>

      <DrawerSection title="Payout trail">
        <PayoutTrail payouts={session.payouts} />
      </DrawerSection>

      <DrawerSection title="Evidence & verifier">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <LinkCard
            role="Evidence"
            ref={`/badges/${session.runRef}`}
            href={session.evidenceHref}
          />
          <LinkCard
            role="Verifier output"
            ref={`${session.verifierMode} · handler-v0.14`}
            href={session.verifierHref}
          />
        </div>
      </DrawerSection>
    </>
  );
}

function LinkCard({
  role,
  ref,
  href,
}: {
  role: string;
  ref: string;
  href: string;
}) {
  return (
    <a
      href={href}
      className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-2 transition-colors hover:border-[color:rgba(30,102,66,0.28)] hover:bg-white"
    >
      <span className="flex flex-col gap-0.5">
        <span
          className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.12em" }}
        >
          {role}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
          style={{ letterSpacing: 0 }}
        >
          {ref}
        </span>
      </span>
      <span className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--avy-accent)]">
        →
      </span>
    </a>
  );
}
