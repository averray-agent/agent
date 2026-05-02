"use client";

import { useMemo, useState } from "react";
import { ReceiptsTopbar } from "@/components/receipts/ReceiptsTopbar";
import {
  ReceiptsKpiStrip,
  type ReceiptsKpi,
} from "@/components/receipts/ReceiptsKpiStrip";
import {
  ReceiptsFilters,
  type FilterGroup,
} from "@/components/receipts/ReceiptsFilters";
import {
  ReceiptsTable,
} from "@/components/receipts/ReceiptsTable";
import {
  ReceiptShapesLegend,
  type ShapeEntry,
} from "@/components/receipts/ReceiptShapesLegend";
import { KindChip } from "@/components/receipts/KindChip";
import { DetailDrawer } from "@/components/shell/DetailDrawer";
import { ReceiptDrawerBody } from "@/components/receipts/ReceiptDrawerBody";
import { SourceBadge } from "@/components/runs/StatePill";
import {
  buildReceiptDrawer,
  extractReceiptRows,
  type ReceiptRowWithMeta,
} from "@/lib/api/receipt-adapters";
import { useBadge, useBadges } from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";

const KPIS: ReceiptsKpi[] = [
  {
    label: "Total receipts",
    value: "0",
    unit: "indexed",
    meta: "from /badges",
  },
  {
    label: "Signed in 24h",
    value: "0",
    meta: "signed in the last 24h",
  },
  {
    label: "Co-signed",
    value: "0.0",
    unit: "%",
    pillRight: (
      <span
        className="inline-flex min-h-[22px] items-center rounded-full bg-[var(--avy-accent-soft)] px-2.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.08em" }}
      >
        within target
      </span>
    ),
    meta: "0 of 0 receipts · signer chain present",
    metaTone: "warn",
  },
  {
    label: "Avg time-to-sign",
    value: "—",
    meta: "timing not emitted by /badges yet",
  },
];

const FILTERS: FilterGroup[] = [
  {
    id: "kind",
    label: "Kind",
    initial: "all",
    options: [
      { value: "all", label: "All" },
      { value: "run", label: "Run" },
      { value: "settle", label: "Settle" },
      { value: "policy", label: "Policy" },
      { value: "badge", label: "Badge" },
    ],
  },
  {
    id: "signer",
    label: "Signer",
    initial: "all",
    options: [
      { value: "all", label: "All" },
      { value: "verifier", label: "Verifier" },
      { value: "operator", label: "Operator" },
      { value: "worker", label: "Worker" },
      { value: "cosigner", label: "Co-signer" },
    ],
  },
  {
    id: "date",
    label: "Date",
    initial: "7d",
    options: [
      { value: "today", label: "Today" },
      { value: "7d", label: "7d" },
      { value: "30d", label: "30d" },
      { value: "custom", label: "Custom…" },
    ],
  },
];

const SHAPES: ShapeEntry[] = [
  {
    kind: "run",
    title: "run-receipt",
    body: "The agent's output for a claimed run. Carries the diff or artifact hash, the verifier's pass/fail verdict, and the policy that was checked.",
    fields: ["run_id", "artifact_hash", "verdict"],
  },
  {
    kind: "settle",
    title: "settle-receipt",
    body: "Stake movement triggered by a verified run. Records the wallet, amount, counterparty, and the run-receipt it settles against.",
    fields: ["amount", "wallet", "origin_receipt"],
  },
  {
    kind: "policy",
    title: "policy-receipt",
    body: "A policy was attached, amended, or retired. The signing operator and the exact policy revision are both captured.",
    fields: ["policy_tag", "revision", "operator"],
  },
  {
    kind: "badge",
    title: "badge-receipt",
    body: (
      <>
        Identity or reputation award. Fetchable at{" "}
        <span className="font-[family-name:var(--font-mono)] text-[var(--avy-ink)]">
          /badges/:sessionId
        </span>{" "}
        for any third party.
      </>
    ),
    fields: ["badge_id", "tier", "session"],
  },
];

export default function ReceiptsPage() {
  const badgesRequest = useBadges();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const liveRows = useMemo(() => extractReceiptRows(badgesRequest.data), [badgesRequest.data]);
  const rows = liveRows;
  const kpis = useMemo(() => receiptKpis(rows), [rows]);
  const selected = selectedId ? rows.find((r) => r.id === selectedId) ?? null : null;
  const detailRequest = useBadge(drawerOpen && selected ? selected.sessionId : null);
  const drawerModel = selected ? buildReceiptDrawer(selected, detailRequest.data) : null;

  const freshness = freshnessFromRequests(badgesRequest);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <ReceiptsTopbar freshness={freshness} />

      <header className="flex flex-col gap-1.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Evidence library
        </span>
        <h1 className="m-0 font-[family-name:var(--font-display)] text-[34px] font-bold leading-none text-[var(--avy-ink)]">
          Receipts
        </h1>
        <p className="m-0 mt-0.5 max-w-[68ch] font-[family-name:var(--font-body)] text-[14px] leading-[1.55] text-[var(--avy-muted)]">
          Every signed output a verified run has produced. Immutable, tamper-evident,
          co-signed where policy requires. Point buyers and auditors here to check the work.
        </p>
      </header>

      <ReceiptsKpiStrip kpis={kpis} />
      <ReceiptsFilters groups={FILTERS} />
      <ReceiptsTable
        rows={rows}
        selectedId={selectedId}
        onSelect={(row) => {
          setSelectedId(row.id);
          setDrawerOpen(true);
        }}
        shownCount={rows.length}
        totalCount={rows.length}
      />
      <ReceiptShapesLegend shapes={SHAPES} />

      <DetailDrawer
        open={drawerOpen && !!selected}
        onClose={() => setDrawerOpen(false)}
        title={
          <h2
            className="m-0 font-[family-name:var(--font-mono)] text-[18px] font-semibold leading-none text-[var(--avy-accent)]"
            style={{ letterSpacing: 0 }}
          >
            {selected?.id}
          </h2>
        }
        meta={
          selected ? (
            <div
              className="flex flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              <KindChip kind={selected.kind} />
              {selected.source ? <SourceBadge kind={selected.source} /> : null}
              <span className="text-[var(--avy-ink)]">{selected.policy}</span>
              <span>·</span>
              <span>{selected.issuedAtIso ? receiptDate(selected.issuedAtIso) : "2026-04-24"} · {selected.signedAt}</span>
            </div>
          ) : null
        }
      >
        {drawerModel ? (
          <ReceiptDrawerBody
            signatures={drawerModel.signatures}
            evidenceJson={drawerModel.evidenceJson}
            evidenceMeta={drawerModel.evidenceMeta}
            evidenceRawHref={drawerModel.evidenceRawHref}
            links={drawerModel.links}
            source={drawerModel.source}
          />
        ) : null}
      </DetailDrawer>
    </div>
  );
}

function receiptKpis(rows: ReceiptRowWithMeta[]): ReceiptsKpi[] {
  const now = Date.now();
  const signed24h = rows.filter((row) => {
    const parsed = Date.parse(row.issuedAtIso);
    return Number.isFinite(parsed) && now - parsed <= 24 * 60 * 60 * 1000;
  }).length;
  const coSigned = rows.filter((row) => row.signers.length > 1).length;
  const coSignedPct = rows.length ? Math.round((coSigned / rows.length) * 1000) / 10 : 0;

  return [
    {
      ...KPIS[0],
      value: rows.length.toLocaleString(),
      unit: "indexed",
      meta: "from /badges",
    },
    {
      ...KPIS[1],
      value: signed24h.toLocaleString(),
      meta: "signed in the last 24h",
    },
    {
      ...KPIS[2],
      value: coSignedPct.toFixed(1),
      meta: `${coSigned} of ${rows.length} receipts · signer chain present`,
      metaTone: coSignedPct >= 95 ? "ok" : "warn",
    },
    {
      ...KPIS[3],
      value: "—",
      unit: undefined,
      meta: "timing not emitted by /badges yet",
    },
  ];
}

function receiptDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString().slice(0, 10);
}
