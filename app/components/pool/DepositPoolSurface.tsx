"use client";

import Link from "next/link";
import { AlertTriangle, ArrowLeft, Landmark, RefreshCw } from "lucide-react";
import { useDepositPool } from "@/lib/api/hooks";
import { buildDepositPoolSurface } from "@/lib/ui/deposit-pool-surface.js";

type SurfaceFact = { label: string; value: string | null };

export function DepositPoolSurface() {
  const request = useDepositPool();
  const surface = buildDepositPoolSurface(request.data);

  return (
    <main className="min-h-screen bg-[var(--bg)] px-5 py-8 text-[var(--ink)] sm:px-8 sm:py-12">
      <div className="mx-auto grid w-full max-w-[1060px] gap-5">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--accent)]" href="/">
            <ArrowLeft className="h-4 w-4" /> Averray
          </Link>
          <span className="rounded-full border border-[var(--line)] bg-[var(--paper-solid)] px-3 py-1 text-xs font-semibold text-[var(--muted)]">
            Public pool read
          </span>
        </header>

        <section className="panel-raised overflow-hidden">
          <div className="grid gap-5 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-end">
            <div>
              <p className="eyebrow">Depositor view</p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Deposit pool</h1>
            </div>
            {surface.transition ? (
              <p className="m-0 text-sm leading-6 text-[var(--muted)]">{surface.transition}</p>
            ) : null}
          </div>

          <div className="border-t border-[var(--line)] bg-[#fff3e7] p-6 sm:p-8" data-testid="pool-risk-disclosure">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#9a4d11]" aria-hidden="true" />
              <div>
                <p className="eyebrow text-[#7d3d0d]">Risk disclosure</p>
                {request.isLoading ? (
                  <p className="mt-2 text-sm text-[#7d3d0d]">Loading disclosure…</p>
                ) : surface.disclosure ? (
                  <p className="mt-2 text-base font-semibold leading-6 text-[#512707]">{surface.disclosure}</p>
                ) : (
                  <p className="mt-2 text-sm font-semibold text-[#7d3d0d]">Unavailable</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {request.isLoading ? (
          <StatePanel title="Loading the live pool read" />
        ) : request.error || !surface.available || !surface.disclosure ? (
          <StatePanel
            title="Pool read unavailable"
            detail={surface.reason ?? "Unavailable"}
            retry={() => void request.mutate()}
          />
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Pool snapshot">
              {surface.facts.map((fact: SurfaceFact) => <Fact key={fact.label} {...fact} />)}
            </section>

            <section className="grid gap-5 lg:grid-cols-2">
              <StatementPanel eyebrow="Yield status" status={surface.yield?.status} statement={surface.yield?.statement} />
              <StatementPanel
                eyebrow="Venue mark"
                status={surface.venue?.status}
                statement={surface.venue?.statement}
                rows={surface.venue ? [
                  ["Cost basis", surface.venue.costBasis],
                  ["Venue marked", surface.venue.marked],
                  ["Shortfall", surface.venue.shortfall],
                  ["Surplus", surface.venue.surplus]
                ] : undefined}
              />
            </section>

            <StatementPanel
              eyebrow="Yield attribution"
              status={surface.attribution?.status}
              statement={surface.attribution?.statement}
              rows={surface.attribution ? [
                ["Cumulative NAV gain", surface.attribution.cumulativeNav],
                ["Venue earned", surface.attribution.venueEarned],
                ["Operator added", surface.attribution.operatorAdded],
                ["Attested entries", surface.attribution.entryCount === null ? null : String(surface.attribution.entryCount)]
              ] : undefined}
              footnote={surface.attribution?.attestation}
            />
          </>
        )}
      </div>
    </main>
  );
}

function Fact({ label, value }: SurfaceFact) {
  return (
    <div className="panel p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-3 break-words font-mono text-lg font-semibold tracking-tight">{value ?? "Unavailable"}</p>
    </div>
  );
}

function StatementPanel({
  eyebrow,
  status,
  statement,
  rows,
  footnote
}: {
  eyebrow: string;
  status?: string | null;
  statement?: string | null;
  rows?: Array<[string, string | null]>;
  footnote?: string | null;
}) {
  return (
    <section className="panel-raised p-6 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow">{eyebrow}</p>
        <span className="rounded-full border border-[var(--line)] px-2.5 py-1 font-mono text-[11px] text-[var(--muted)]">
          {status ?? "unavailable"}
        </span>
      </div>
      <p className="mt-4 text-sm leading-6 text-[var(--ink)]">{statement ?? "Unavailable"}</p>
      {rows?.length ? (
        <dl className="mt-5 grid gap-2 border-t border-[var(--line)] pt-4 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="text-[var(--muted)]">{label}</dt>
              <dd className="m-0 text-right font-mono text-xs">{value ?? "Unavailable"}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {footnote ? <p className="mt-5 border-t border-[var(--line)] pt-4 text-xs leading-5 text-[var(--muted)]">{footnote}</p> : null}
    </section>
  );
}

function StatePanel({ title, detail, retry }: { title: string; detail?: string; retry?: () => void }) {
  return (
    <section className="panel-raised grid min-h-[220px] place-items-center p-8 text-center">
      <div>
        <Landmark className="mx-auto h-7 w-7 text-[var(--muted)]" aria-hidden="true" />
        <h2 className="mt-4 text-xl font-semibold">{title}</h2>
        {detail ? <p className="mx-auto mt-2 max-w-[58ch] text-sm leading-6 text-[var(--muted)]">{detail}</p> : null}
        {retry ? (
          <button className="mt-5 inline-flex items-center gap-2 rounded-[var(--radius)] border border-[var(--line)] px-4 py-2 text-sm font-semibold" type="button" onClick={retry}>
            <RefreshCw className="h-4 w-4" /> Retry live read
          </button>
        ) : null}
      </div>
    </section>
  );
}
