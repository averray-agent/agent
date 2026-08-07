"use client";

import Link from "next/link";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ExplorerLink } from "@/components/common/ExplorerLink";
import {
  DataFreshnessPill,
  type FreshnessState,
} from "@/components/shell/DataFreshnessPill";
import { SectionHead } from "@/components/overview/SectionHead";
import { TreasuryPanel } from "@/components/treasury/TreasuryPanel";
import { Button, buttonVariants } from "@/components/ui/button";
import type {
  TransparencyField,
  TransparencyPayload,
} from "@/lib/api/transparency-types";
import {
  transparencyAuthorizationNotice,
  type TransparencyUnauthorizedState,
} from "@/lib/api/transparency-access";
import {
  aggregateDisclosure,
  extractProofAnchors,
  formatReadAt,
  formatWindowMs,
  presentTransparencyField,
  transparencyPageFreshness,
} from "@/lib/api/transparency-view-model";
import { cn } from "@/lib/utils/cn";

type AnyField = TransparencyField<unknown>;

const WINDOW_KEY = {
  flow: "flow",
  chain: "chain",
  bank: "bank",
  subject: "subject",
} as const;

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api").replace(/\/+$/u, "");
const ProofVisibilityContext = createContext({ verifyAll: false, resetId: 0 });

export function TransparencyPanel({ data }: { data: TransparencyPayload }) {
  const pageFreshness = transparencyPageFreshness(data);
  const total = presentTransparencyField(data.treasury.totalUsdcEquivalent);
  const generation = data.treasury.generation;

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5" data-transparency-schema={data.schemaVersion}>
      <TransparencyTopbar freshness={pageFreshness} />

      <section className="grid gap-2.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.14em" }}
        >
          Capital
        </span>
        <h1 className="m-0 max-w-none font-[family-name:var(--font-display)] text-[clamp(2.1rem,4vw,2.5rem)] font-bold leading-[1.06] text-[var(--avy-ink)]">
          What the treasury holds, and how you check it.
        </h1>
        <p className="m-0 max-w-[68ch] text-base leading-relaxed text-[var(--avy-muted)]">
          Flow, escrow obligations, and treasury position on one read-only page. Every number keeps the backend&apos;s read status, source, and proof.
        </p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1 font-[family-name:var(--font-mono)] text-xs text-[var(--avy-muted)]">
          <span className="inline-flex items-center gap-2">
            <b className="font-semibold text-[var(--avy-ink)]">
              {total.missing ? "Treasury total has no read" : `${total.display} USDC`}
            </b>
            <FieldStatusPill field={data.treasury.totalUsdcEquivalent} />
          </span>
          <span>
            Configured generation · <b className="font-semibold text-[var(--avy-ink)]">{fieldText(generation.version)}</b>
          </span>
          <span>
            Lane · <b className="font-semibold text-[var(--avy-ink)]">{generationStateLabel(generation)}</b>
          </span>
        </div>
      </section>

      <FlowSection data={data} />
      <EscrowSection data={data} />
      <TreasurySection data={data} />
      <ReadPolicy data={data} />

      <p className="flex flex-wrap gap-x-5 gap-y-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]">
        <span><b className="font-semibold text-[var(--avy-ink)]">Read-only</b> · this page cannot move capital</span>
        <span>Schema · <b className="font-semibold text-[var(--avy-ink)]">{data.schemaVersion}</b></span>
        <span>Generated · <b className="font-semibold text-[var(--avy-ink)]">{formatReadAt(data.generatedAtMs)}</b></span>
      </p>
    </div>
  );
}

/**
 * Authorization state — the API answered 401/403 for this session.
 *
 * Deliberately does NOT reuse the `no read` tiles below: those mean "we
 * tried to read this and could not", which is false when the refusal
 * happens at the auth boundary and no read is attempted at all. The
 * sections are named as gated instead, so the reader learns what the
 * capability would unlock without being told a read failed.
 */
export function TransparencyAuthorizationState({
  access,
}: {
  access: TransparencyUnauthorizedState;
}) {
  const notice = transparencyAuthorizationNotice(access);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5" data-transparency-state="unauthorized">
      <TransparencyTopbar freshness="locked" />

      <section className="grid gap-2.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.14em" }}
        >
          Capital
        </span>
        <h1 className="m-0 max-w-none font-[family-name:var(--font-display)] text-[clamp(2.1rem,4vw,2.5rem)] font-bold leading-[1.06] text-[var(--avy-ink)]">
          What the treasury holds, and how you check it.
        </h1>
        <p className="m-0 max-w-[68ch] text-base leading-relaxed text-[var(--avy-muted)]">
          {notice.headline}
        </p>
      </section>

      <TreasuryPanel
        eyebrow="Not authorized"
        title="This view is gated on a capability"
        sub="the API answered; it refused this session"
      >
        <div className="grid gap-3 p-[18px]">
          <p className="m-0 font-[family-name:var(--font-mono)] text-sm leading-relaxed text-[var(--avy-ink)]">
            {notice.capabilitySentence}
          </p>
          <p className="m-0 font-[family-name:var(--font-mono)] text-sm leading-relaxed text-[var(--avy-ink)]">
            {notice.identitySentence}
          </p>
          <p className="m-0 border-l-2 border-[var(--avy-line)] pl-2.5 font-[family-name:var(--font-mono)] text-[11.5px] leading-relaxed text-[var(--avy-muted)]">
            {notice.boundarySentence}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-0.5">
            <Link
              href="/sign-in"
              className="inline-flex h-[34px] items-center rounded-[var(--radius)] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-white transition hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
            >
              Sign in with an operator account
            </Link>
            <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
              {notice.nextStep}
            </span>
          </div>
        </div>

        <div className="border-t border-[var(--avy-line)] bg-[var(--avy-paper-solid)]">
          <div className="border-b border-[var(--avy-line-soft)] px-4 py-2.5">
            <span
              className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.12em" }}
            >
              Gated by this capability
            </span>
          </div>
          {notice.gatedSections.map((section) => (
            <div
              key={section.title}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--avy-line-soft)] px-4 py-3 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-[family-name:var(--font-display)] text-[13px] font-bold text-[var(--avy-ink)]">
                  {section.title}
                </span>
                <span className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]">
                  {section.meta}
                </span>
              </span>
              <DataFreshnessPill state="locked" />
            </div>
          ))}
        </div>
      </TreasuryPanel>

      <p className="flex flex-wrap gap-x-5 gap-y-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]">
        <span><b className="font-semibold text-[var(--avy-ink)]">Read-only</b> · this page cannot move capital</span>
        {access.status ? (
          <span>Refused with · <b className="font-semibold text-[var(--avy-ink)]">HTTP {access.status}{access.code ? ` ${access.code}` : ""}</b></span>
        ) : null}
      </p>
    </div>
  );
}

export function TransparencyRequestState({ state }: { state: "loading" | "fallback" }) {
  const loading = state === "loading";
  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <TransparencyTopbar freshness={state} />
      <section className="grid gap-2.5">
        <span className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]">
          Capital
        </span>
        <h1 className="m-0 max-w-none font-[family-name:var(--font-display)] text-[clamp(2.1rem,4vw,2.5rem)] font-bold leading-[1.06]">
          What the treasury holds, and how you check it.
        </h1>
        <p className="m-0 max-w-[68ch] text-base leading-relaxed text-[var(--avy-muted)]">
          {loading ? "Waiting for the first transparency read." : "The transparency read is unavailable. No last-known or placeholder values are being substituted."}
        </p>
      </section>
      {[
        ["Flow · settled work", "Jobs and paid USDC"],
        ["Escrow backing", "Poster obligations and contract balance"],
        ["Treasury", "Asset Hub and Hydration positions"],
      ].map(([title, detail]) => (
        <section key={title}>
          <SectionHead title={title} meta={detail} />
          <div className="rounded-[10px] border border-dashed border-[color:rgba(167,97,34,.42)] bg-[var(--avy-paper)] p-5 text-[var(--avy-warn)] shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between gap-3">
              <span className="font-[family-name:var(--font-mono)] text-sm">{loading ? "waiting for read" : "no read"}</span>
              <DataFreshnessPill state={state} label={loading ? "Loading" : "No read"} />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function TransparencyTopbar({ freshness }: { freshness: FreshnessState }) {
  const [time, setTime] = useState("");
  useEffect(() => {
    const tick = () => setTime(new Date().toISOString().slice(11, 19));
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 pb-1">
      <div className="flex items-center gap-2 font-[family-name:var(--font-display)] text-xs font-bold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.1em" }}>
        <span>Capital</span><span className="opacity-40">/</span><span className="text-[var(--avy-ink)]">Transparency</span>
      </div>
      <span className="inline-flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]" suppressHydrationWarning>
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] shadow-[0_0_0_3px_rgba(30,102,66,0.12)]" />
        {time || "waiting"} UTC
      </span>
      <div className="flex items-center gap-2">
        <DataFreshnessPill state={freshness} />
        <Link href="/receipts" className="inline-flex h-[34px] items-center rounded-[var(--radius)] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-white transition hover:-translate-y-px hover:bg-[var(--avy-accent-2)]">
          Open receipts
        </Link>
      </div>
    </header>
  );
}

function ProofSection({ title, meta, children }: { title: string; meta: string; children: ReactNode }) {
  const [verifyAll, setVerifyAll] = useState(false);
  const [resetId, setResetId] = useState(0);
  return (
    <section>
      <SectionHead
        title={title}
        meta={(
          <span className="flex flex-wrap items-center justify-end gap-2">
            <span>{meta}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 font-[family-name:var(--font-mono)] text-[10px] uppercase text-[var(--avy-accent)]"
              aria-pressed={verifyAll}
              onClick={() => {
                if (verifyAll) {
                  setVerifyAll(false);
                  setResetId((current) => current + 1);
                } else {
                  setVerifyAll(true);
                }
              }}
            >
              {verifyAll ? "Hide proofs" : "Verify all"}
            </Button>
          </span>
        )}
      />
      <ProofVisibilityContext.Provider value={{ verifyAll, resetId }}>
        {children}
      </ProofVisibilityContext.Provider>
    </section>
  );
}

function FlowSection({ data }: { data: TransparencyPayload }) {
  const windows = [
    ["Settled · 24h", data.flow.jobsSettled.last24h, data.flow.usdcPaid.last24h],
    ["Settled · 7d", data.flow.jobsSettled.last7d, data.flow.usdcPaid.last7d],
    ["Settled · all time", data.flow.jobsSettled.allTime, data.flow.usdcPaid.allTime],
  ] as const;
  const composition = [
    ["Platform verification runs", data.flow.composition24h.platformVerificationRuns],
    ["Ingested", data.flow.composition24h.ingested],
    ["External", data.flow.composition24h.external],
    ["Unclassified", data.flow.composition24h.unclassified],
  ] as const;

  return (
    <ProofSection title="Flow · settled work" meta="24h composition names platform-owned volume">
      <div className="grid overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] shadow-[var(--shadow-card)] backdrop-blur-[10px] lg:grid-cols-3">
        {windows.map(([label, jobs, paid], index) => (
          <div key={label} className={cn("grid gap-4 p-[18px]", index > 0 && "border-t border-[var(--avy-line-soft)] lg:border-l lg:border-t-0")}>
            <span className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.12em" }}>{label}</span>
            <InlineMetric label="Jobs" field={jobs} window={windowValue(data, WINDOW_KEY.flow)} />
            <InlineMetric label="USDC paid" field={paid} window={windowValue(data, WINDOW_KEY.flow)} />
          </div>
        ))}
      </div>
      <div className="mt-2 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--avy-line-soft)] px-4 py-2.5">
          <span className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.12em" }}>Composition · 24h</span>
          <FieldStatusPill field={data.flow.composition24h.total} />
        </div>
        <div className="grid sm:grid-cols-2 xl:grid-cols-4">
          {composition.map(([label, field], index) => (
            <div key={label} className={cn("min-w-0 px-3 py-2.5", index > 0 && "border-t border-[var(--avy-line-soft)] sm:border-l sm:border-t-0")}>
              <CompactMetric label={label} field={field} window={windowValue(data, WINDOW_KEY.flow)} />
            </div>
          ))}
        </div>
      </div>
    </ProofSection>
  );
}

function EscrowSection({ data }: { data: TransparencyPayload }) {
  const escrow = data.escrow;
  return (
    <ProofSection title="Escrow backing" meta="poster obligations vs contract balance">
      <TreasuryPanel eyebrow="Escrow backing" title="Owed in flight vs actually held" sub="reported separately; no inferred backing verdict">
        <div className="grid md:grid-cols-2">
          <ValueBlock label="Poster obligations in flight" field={escrow.posterObligationsInFlight} window={windowValue(data, WINDOW_KEY.chain)} />
          <ValueBlock label="Held by escrow contract" field={escrow.balanceHeldByEscrowContract} window={windowValue(data, WINDOW_KEY.chain)} className="border-t border-[var(--avy-line-soft)] md:border-l md:border-t-0" />
        </div>
        <div className="border-t border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] px-4 py-3">
          <InlineMetric label="Escrow contract" field={escrow.contractAddress} window={windowValue(data, WINDOW_KEY.chain)} compact />
        </div>
      </TreasuryPanel>
    </ProofSection>
  );
}

function TreasurySection({ data }: { data: TransparencyPayload }) {
  const treasury = data.treasury;
  const generation = treasury.generation;
  const aggregate = presentTransparencyField(treasury.totalUsdcEquivalent);
  return (
    <ProofSection title="Treasury" meta="three USDC-equivalent lines · configured generation only">
      <TreasuryPanel eyebrow="Treasury" title="What the treasury holds" sub="each line carries its own lens and proof">
        <div className={cn("grid gap-3 border-b border-[var(--avy-line-soft)] p-[18px]", aggregate.freshness !== "live" && "bg-[repeating-linear-gradient(135deg,transparent_0_7px,rgba(167,97,34,.055)_7px_14px)]")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.12em" }}>Treasury total · USDC-equivalent</span>
            <FieldStatusPill field={treasury.totalUsdcEquivalent} />
          </div>
          {aggregate.missing ? (
            <MissingReadReason />
          ) : (
            <span className="font-[family-name:var(--font-mono)] text-[clamp(1.9rem,5vw,2.4rem)] font-semibold leading-none text-[var(--avy-ink)]">
              {aggregate.display} USDC
            </span>
          )}
          <p className={cn("m-0 border-l-2 pl-2.5 font-[family-name:var(--font-mono)] text-[11.5px] leading-relaxed", aggregate.freshness === "live" ? "border-[var(--avy-accent)] text-[var(--avy-muted)]" : "border-[var(--avy-warn)] text-[var(--avy-warn)]")}>
            {aggregateDisclosure(treasury.totalUsdcEquivalent)}
          </p>
          <FieldEvidenceDisclosure field={treasury.totalUsdcEquivalent} window={windowValue(data, WINDOW_KEY.bank)} />
        </div>

        <div className="grid">
          <TreasuryLine label="Asset Hub multisig balance" meta="USDC held by the native treasury account" field={treasury.lines.assetHubMultisig.balance} window={windowValue(data, WINDOW_KEY.chain)} extras={[
            ["Native account", treasury.lines.assetHubMultisig.nativeAccountId32],
            ["EVM lens", treasury.lines.assetHubMultisig.evmLens],
          ]} />
          <TreasuryLine label="Deployed to Hydration" meta="aUSDC position; redeemable at par, with growth in the balance" field={treasury.lines.hydrationPosition.total} window={windowValue(data, WINDOW_KEY.bank)} />
          <TreasuryLine label="Hydration asset-22 operating float" meta="On-chain USDC available for venue operations; non-custodial" field={treasury.lines.operatingFloat.balance} window={windowValue(data, WINDOW_KEY.bank)} extras={[["Asset", treasury.lines.operatingFloat.asset]]} />
        </div>

        <div className="grid border-t border-[var(--avy-line)] md:grid-cols-2">
          <ValueBlock label="Contributed principal" field={treasury.lines.hydrationPosition.principal} window={windowValue(data, WINDOW_KEY.bank)} compact />
          <ValueBlock label="Accrued yield" field={treasury.lines.hydrationPosition.accruedYield} window={windowValue(data, WINDOW_KEY.bank)} compact className="border-t border-[var(--avy-line-soft)] md:border-l md:border-t-0" />
        </div>
        <div className="border-t border-dashed border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-[18px] py-3">
          <InlineMetric label="Accounting note" field={treasury.lines.hydrationPosition.note} window={windowValue(data, WINDOW_KEY.bank)} compact />
        </div>

        <GenerationBand generation={generation} window={windowValue(data, WINDOW_KEY.subject)} />
      </TreasuryPanel>
    </ProofSection>
  );
}

function TreasuryLine({ label, meta, field, window, extras = [] }: { label: string; meta: string; field: AnyField; window: number | null; extras?: Array<[string, AnyField]> }) {
  const view = presentTransparencyField(field);
  return (
    <div className={cn("grid gap-3 border-b border-[var(--avy-line-soft)] px-[18px] py-3.5 last:border-b-0 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center", view.freshness === "partial" && "bg-[repeating-linear-gradient(135deg,transparent_0_7px,rgba(167,97,34,.05)_7px_14px)]")}>
      <div className="grid gap-1">
        <span className="font-[family-name:var(--font-display)] text-[13px] font-bold text-[var(--avy-ink)]">{label}</span>
        <span className="font-[family-name:var(--font-mono)] text-[10.5px] leading-relaxed text-[var(--avy-muted)]">{meta}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 xl:justify-end">
        {view.missing ? <MissingReadReason /> : <FieldValue field={field} className="text-lg" />}
        <FieldStatusPill field={field} />
      </div>
      <div className="xl:col-span-2">
        <FieldEvidenceDisclosure field={field} window={window} extras={extras} />
      </div>
    </div>
  );
}

function GenerationBand({ generation, window }: { generation: TransparencyPayload["treasury"]["generation"]; window: number | null }) {
  const state = fieldText(generation.state);
  const paused = state === "paused";
  return (
    <div className={cn("grid gap-3 border-t border-[var(--avy-line)] px-[18px] py-3.5", paused ? "bg-[var(--avy-warn-soft)]/45" : "bg-[var(--avy-accent-wash)]")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="block font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.12em" }}>Configured bank generation</span>
          <strong className={cn("font-[family-name:var(--font-display)] text-sm", paused ? "text-[var(--avy-warn)]" : "text-[var(--avy-accent)]")}>
            {generationStateLabel(generation)}
          </strong>
        </div>
        <FieldStatusPill field={generation.state} />
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <CompactMetric label="Version" field={generation.version} window={window} />
        <CompactMetric label="Wrapper" field={generation.wrapperAddress} window={window} />
        <CompactMetric label="Reason" field={generation.reason} window={window} />
      </div>
    </div>
  );
}

function ReadPolicy({ data }: { data: TransparencyPayload }) {
  const policy = data.readPolicy;
  const fields = [
    ["Cache TTL", policy.cacheTtl],
    ...Object.entries(policy.freshnessWindows).map(([label, field]) => [`${label} freshness`, field] as const),
  ] as const;
  return (
    <details className="group overflow-hidden rounded-[var(--radius-sm)] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[var(--avy-muted)] marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="grid gap-0.5">
          <span className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase" style={{ letterSpacing: "0.12em" }}>Read policy</span>
          <span className="font-[family-name:var(--font-mono)] text-[10.5px]">Service configuration · cache expires before evidence freshness</span>
        </span>
        <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="grid border-t border-[var(--avy-line-soft)] sm:grid-cols-2 xl:grid-cols-5">
        {fields.map(([label, field], index) => (
          <PolicyMetric key={label} label={label} field={field} divided={index > 0} />
        ))}
      </div>
    </details>
  );
}

function ValueBlock({ label, field, window, compact = false, className }: { label: string; field: AnyField; window: number | null; compact?: boolean; className?: string }) {
  const view = presentTransparencyField(field);
  return (
    <div className={cn("grid content-start gap-2.5 p-[18px]", view.freshness === "partial" && "bg-[repeating-linear-gradient(135deg,transparent_0_7px,rgba(167,97,34,.05)_7px_14px)]", view.freshness === "fallback" && "bg-[var(--avy-warn-soft)]/20", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.12em" }}>{label}</span>
        <FieldStatusPill field={field} />
      </div>
      {view.lastKnown ? <span className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-warn)]">Last known value</span> : null}
      {view.missing ? <MissingReadReason /> : <FieldValue field={field} className={compact ? "text-[22px]" : "text-[30px]"} />}
      <FieldEvidenceDisclosure field={field} window={window} />
    </div>
  );
}

function InlineMetric({ label, field, window, compact = false }: { label: string; field: AnyField; window?: number | null; compact?: boolean }) {
  const view = presentTransparencyField(field);
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.1em" }}>{label}</span>
        <FieldStatusPill field={field} />
      </div>
      {view.missing ? <MissingReadReason compact /> : <FieldValue field={field} className={compact ? "text-sm" : "text-2xl"} />}
      <FieldEvidenceDisclosure field={field} window={window ?? null} compact />
    </div>
  );
}

function CompactMetric({ label, field, window }: { label: string; field: AnyField; window: number | null }) {
  const view = presentTransparencyField(field);
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="truncate font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.08em" }}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {view.missing ? <MissingReadReason compact /> : <FieldValue field={field} className="text-sm" />}
        <FieldStatusPill field={field} />
      </div>
      <FieldEvidenceDisclosure field={field} window={window} compact />
    </div>
  );
}

function PolicyMetric({ label, field, divided }: { label: string; field: AnyField; divided: boolean }) {
  const view = presentTransparencyField(field);
  return (
    <div className={cn("grid min-w-0 gap-2 px-4 py-3", divided && "border-t border-[var(--avy-line-soft)] sm:border-l sm:border-t-0")}>
      <span className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]" style={{ letterSpacing: "0.08em" }}>{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {view.missing ? <MissingReadReason compact /> : <FieldValue field={field} className="text-sm" />}
        <FieldStatusPill field={field} />
      </div>
      <FieldEvidenceContent field={field} window={null} compact />
    </div>
  );
}

function MissingReadReason({ compact = false }: { compact?: boolean }) {
  return (
    <span className={cn("font-[family-name:var(--font-mono)] leading-relaxed text-[var(--avy-warn)]", compact ? "text-[10.5px]" : "text-xs")}>
      Backend could not read this value.
    </span>
  );
}

function FieldValue({ field, className }: { field: AnyField; className?: string }) {
  const view = presentTransparencyField(field);
  if (view.missing) return null;
  const common = cn("font-[family-name:var(--font-mono)] font-semibold leading-tight tabular-nums", view.lastKnown ? "text-[var(--avy-muted)]" : "text-[var(--avy-ink)]", className);
  if (field.unit === "address" && typeof field.value === "string") {
    return <ExplorerLink kind="address" value={field.value} label={shortAnchor(field.value)} className={cn(common, "text-[var(--avy-accent)] hover:underline")} />;
  }
  return <span className={common}>{view.display}</span>;
}

function FieldStatusPill({ field }: { field: AnyField }) {
  const view = presentTransparencyField(field);
  return <DataFreshnessPill state={view.freshness} label={view.statusLabel} meta={`${view.statusLabel}. Status supplied by /transparency.`} />;
}

function FieldEvidenceDisclosure({ field, window, compact = false, extras = [] }: { field: AnyField; window: number | null; compact?: boolean; extras?: Array<[string, AnyField]> }) {
  const { verifyAll, resetId } = useContext(ProofVisibilityContext);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [resetId]);
  return (
    <details
      className="group/proof min-w-0"
      open={verifyAll || open}
      onToggle={(event) => {
        if (!verifyAll) setOpen(event.currentTarget.open);
      }}
    >
      <summary
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-auto w-fit cursor-pointer list-none px-0 py-0.5 font-[family-name:var(--font-mono)] text-[10px] font-semibold text-[var(--avy-accent)] marker:content-none [&::-webkit-details-marker]:hidden")}
        onClick={(event) => {
          if (verifyAll) event.preventDefault();
        }}
      >
        proof
        <ChevronDown className="size-3 transition-transform group-open/proof:rotate-180" aria-hidden="true" />
      </summary>
      <div className="mt-2 rounded-[var(--radius-sm)] border border-dashed border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] p-2.5">
        <FieldEvidenceContent field={field} window={window} compact={compact} />
        {extras.length > 0 ? (
          <div className="mt-2 grid gap-2 border-t border-dashed border-[var(--avy-line-soft)] pt-2 sm:grid-cols-2">
            {extras.map(([label, extra]) => (
              <div key={label} className="grid min-w-0 gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]">{label}</span>
                  <FieldStatusPill field={extra} />
                </div>
                {presentTransparencyField(extra).missing ? <MissingReadReason compact /> : <FieldValue field={extra} className="text-xs" />}
                <FieldEvidenceContent field={extra} window={window} compact />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function FieldEvidenceContent({ field, window, compact = false }: { field: AnyField; window: number | null; compact?: boolean }) {
  const anchors = extractProofAnchors(`${field.source} ${field.proof}`);
  return (
    <div className={cn("grid gap-1.5 font-[family-name:var(--font-mono)] text-[10.5px] leading-relaxed text-[var(--avy-muted)]", !compact && "text-[11px]")}>
      <span><b className="font-semibold text-[var(--avy-ink)]">Read</b> · {formatReadAt(field.readAtMs)}{window !== null ? ` · ${formatWindowMs(window)}` : ""}</span>
      <span className="break-words"><b className="font-semibold text-[var(--avy-ink)]">Source</b> · {field.source}</span>
      <span className="break-words"><b className="font-semibold text-[var(--avy-ink)]">Proof</b> · {field.proof}</span>
      {anchors.urls.length || anchors.addresses.length || anchors.transactions.length || anchors.routes.length ? (
        <span className="flex flex-wrap gap-x-2 gap-y-1">
          {anchors.urls.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer noopener" className="font-semibold text-[var(--avy-accent)] hover:underline">{safeHost(url)} ↗</a>)}
          {anchors.addresses.map((address) => <ExplorerLink key={address} kind="address" value={address} />)}
          {anchors.transactions.map((tx) => <ExplorerLink key={tx} kind="tx" value={tx} />)}
          {anchors.routes.map((route) => <a key={route} href={`${API_BASE_URL}${route}`} target="_blank" rel="noreferrer noopener" className="font-semibold text-[var(--avy-accent)] hover:underline">{route} ↗</a>)}
        </span>
      ) : null}
    </div>
  );
}

function windowValue(data: TransparencyPayload, key: keyof typeof WINDOW_KEY): number | null {
  const field = data.readPolicy.freshnessWindows[key];
  return field.status === "unknown" || typeof field.value !== "number" ? null : field.value;
}

function fieldText(field: AnyField): string {
  return field.status === "unknown" || field.value === null ? "no read" : String(field.value);
}

function generationStateLabel(generation: TransparencyPayload["treasury"]["generation"]): string {
  const version = fieldText(generation.version);
  const state = fieldText(generation.state);
  if (state === "paused") return `administratively paused · generation ${version}`;
  if (state === "ok") return `active · generation ${version}`;
  if (state === "no read") return "generation state has no read";
  return `${state} · generation ${version}`;
}

function shortAnchor(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
