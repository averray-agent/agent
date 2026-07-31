"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";

import { useAuth } from "@/lib/auth/use-auth";
import {
  fetchTreasuryPosition,
  formatUsdc,
  PROTOCOL_TREASURY,
  type RevenueView,
} from "@/lib/protocol-revenue";

// Protocol revenue — ADMIN-ONLY view of the protocol treasury's position.
//
// This is the platform's earnings surface: where the 5% poster-side protocol
// fee accrues. It is deliberately NOT the signed-in wallet's Treasury page —
// that page is an account holder's own balance sheet; this one belongs to the
// 2-of-3 owner multisig. Position-shaped on purpose (roadmap, Bank pillar):
// when treasury yield lands, the same view shows strategyAllocated with zero
// rework. Data is read straight from chain and every non-ready state is shown
// honestly (unreadable ≠ zero).

const POLL_MS = 60_000;

export default function RevenuePage() {
  const auth = useAuth();
  const [view, setView] = useState<RevenueView>({ kind: "loading" });

  const load = useCallback(() => {
    fetchTreasuryPosition()
      .then(setView)
      .catch((error) =>
        setView({ kind: "unreadable", detail: error instanceof Error ? error.message : String(error) })
      );
  }, []);

  const isAdmin = auth.authenticated && auth.roles.includes("admin");

  useEffect(() => {
    if (!isAdmin) return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-6">
        <div className="flex items-center gap-2 text-[var(--muted)]">
          <ShieldCheck className="h-4 w-4" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]">Restricted</p>
        </div>
        <p className="text-sm text-[var(--ink)]">
          Protocol revenue is an admin surface. Sign in with a wallet that holds the
          admin role to view it.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-baseline justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
            Capital / Protocol revenue
          </p>
          <h1 className="font-[family-name:var(--font-display)] text-xl font-bold text-[var(--ink)]">
            Platform earnings
          </h1>
        </div>
        <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--muted)]">
          treasury {PROTOCOL_TREASURY.slice(0, 10)}…{PROTOCOL_TREASURY.slice(-4)}
        </p>
      </header>

      {view.kind === "loading" ? (
        <StateCard title="Reading chain…" body="Fetching the treasury position from Polkadot Hub." />
      ) : view.kind === "wrong-chain" ? (
        <StateCard
          tone="warn"
          title="Wrong chain"
          body={`The RPC answered for chain ${view.got}, not Polkadot Hub (420420419). Refusing to display balances from another network.`}
        />
      ) : view.kind === "unreadable" ? (
        <StateCard
          tone="warn"
          title="Chain unreadable"
          body={`Neither public RPC returned a valid position (${view.detail}). Showing nothing rather than a fake zero — retrying every minute.`}
        />
      ) : (
        <>
          <section className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-6">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
              Fees accrued · protocol fee 5% (poster-side)
            </p>
            <p className="mt-2 font-[family-name:var(--font-display)] text-4xl font-bold text-[var(--ink)]">
              {formatUsdc(view.position.liquid)}{" "}
              <span className="text-base font-semibold text-[var(--muted)]">USDC</span>
            </p>
            <p className="mt-2 text-[11px] text-[var(--muted)]">
              Workers always receive the full advertised reward — the fee is charged to
              posters on top. Starter (earn-from-zero) jobs are fee-exempt.
            </p>
          </section>

          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <PositionCard label="Reserved" value={formatUsdc(view.position.reserved)} hint="in escrow" />
            <PositionCard
              label="In strategies"
              value={formatUsdc(view.position.strategyAllocated)}
              hint="yield-eligible when the Bank pillar lands"
            />
            <PositionCard
              label="Collateral"
              value={formatUsdc(view.position.collateralLocked)}
              hint="locked"
            />
            <PositionCard label="Debt" value={formatUsdc(view.position.debtOutstanding)} hint="outstanding" />
          </section>

          <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[var(--muted)]">
            <span>
              held under the 2-of-3 owner multisig · withdrawal via ceremony when it justifies
              itself
            </span>
            <span>read on-chain from {new URL(view.endpoint).host}</span>
            <span>as of {new Date(view.asOfMs).toUTCString().slice(17, 25)} UTC · refreshes 60s</span>
          </footer>
        </>
      )}
    </div>
  );
}

function StateCard({
  title,
  body,
  tone = "muted",
}: {
  title: string;
  body: string;
  tone?: "muted" | "warn";
}) {
  return (
    <section
      className={`rounded-[var(--radius-lg)] border p-6 ${
        tone === "warn"
          ? "border-[var(--warn)] bg-[var(--warn-soft)]"
          : "border-[var(--line)] bg-[var(--paper-solid)]"
      }`}
    >
      <p className="text-sm font-semibold text-[var(--ink)]">{title}</p>
      <p className="mt-1 text-[12px] text-[var(--muted)]">{body}</p>
    </section>
  );
}

function PositionCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-solid)] p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-mono)] text-lg font-semibold text-[var(--ink)]">
        {value} <span className="text-[11px] text-[var(--muted)]">USDC</span>
      </p>
      <p className="mt-0.5 text-[10px] text-[var(--muted)]">{hint}</p>
    </div>
  );
}
