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
  type ReceiptRow,
} from "@/components/receipts/ReceiptsTable";
import {
  ReceiptShapesLegend,
  type ShapeEntry,
} from "@/components/receipts/ReceiptShapesLegend";
import { KindChip } from "@/components/receipts/KindChip";
import { DetailDrawer } from "@/components/shell/DetailDrawer";
import { ReceiptDrawerBody } from "@/components/receipts/ReceiptDrawerBody";
import {
  buildReceiptDrawer,
  extractReceiptRows,
  type ReceiptRowWithMeta,
} from "@/lib/api/receipt-adapters";
import { useBadge, useBadges } from "@/lib/api/hooks";

// TODO(data): wire to useApi("/badges") and useApi(`/badges/${sessionId}`).
// Fixture matches the handoff exactly so the page reads correctly until
// the backend emits a stable list endpoint for receipts.

const KPIS: ReceiptsKpi[] = [
  {
    label: "Total receipts",
    value: "2,134",
    unit: "all-time",
    meta: "since 2025-11-06 · base mainnet",
  },
  {
    label: "Signed in 24h",
    value: "127",
    spark: [14, 12, 15, 10, 13, 8, 11, 7, 9, 5, 8, 4, 6, 3],
    sparkPulse: true,
    meta: "+11% vs 7d avg",
    metaTone: "ok",
  },
  {
    label: "Co-signed",
    value: "96.2",
    unit: "%",
    pillRight: (
      <span
        className="inline-flex min-h-[22px] items-center rounded-full bg-[var(--avy-accent-soft)] px-2.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]"
        style={{ letterSpacing: "0.08em" }}
      >
        within target
      </span>
    ),
    meta: "target ≥ 95% · last 30d",
    metaTone: "ok",
  },
  {
    label: "Avg time-to-sign",
    value: "18.4",
    unit: "s",
    spark: [6, 8, 5, 9, 7, 11, 9, 13, 10, 14, 11, 15, 13, 16],
    meta: "median 14.2s · p95 41s",
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

const ROWS: ReceiptRow[] = [
  {
    id: "r_4e14c",
    kind: "run",
    subject: "run-2745",
    subjectSub: "coding-hand-3",
    signers: [
      { initials: "P", tone: "sage", role: "operator", address: "0xFd2EAE…6519" },
      { initials: "C", tone: "ink", role: "cosigner", address: "0x9A13BC…0cb2" },
      { initials: "V", tone: "blue", role: "verifier", address: "0x4D1E…7EbC" },
    ],
    policy: "coding/lint-strict@v2",
    size: "8.9 KB",
    signedAt: "14:14:02 UTC",
  },
  {
    id: "r_4e14b",
    kind: "settle",
    subject: "loan-0a14",
    subjectSub: "stake movement",
    signers: [
      { initials: "P", tone: "sage", role: "operator", address: "0xFd2EAE…6519" },
      { initials: "C", tone: "clay", role: "cosigner", address: "0xB712…9908" },
    ],
    policy: "treasury/unwind-safe@v1",
    size: "4.1 KB",
    signedAt: "14:12:51 UTC",
  },
  {
    id: "r_4e14a",
    kind: "run",
    subject: "run-2744",
    subjectSub: "writer-gov-1",
    signers: [
      { initials: "P", tone: "sage", role: "operator", address: "0xFd2EAE…6519" },
      { initials: "C", tone: "ink", role: "cosigner", address: "0x9A13BC…0cb2" },
    ],
    policy: "writer-gov/cited@v3",
    size: "14.2 KB",
    signedAt: "14:11:18 UTC",
  },
  {
    id: "r_4e139",
    kind: "badge",
    subject: "coding-tier-2",
    subjectSub: "agent award",
    signers: [
      { initials: "V", tone: "blue", role: "verifier", address: "0x4D1E…7EbC" },
    ],
    policy: "reputation/tier-up",
    size: "2.7 KB",
    signedAt: "14:10:40 UTC",
  },
  {
    id: "r_4e138",
    kind: "policy",
    subject: "ops/schema-dual-sign",
    subjectSub: "revision v4",
    signers: [
      { initials: "P", tone: "sage", role: "operator", address: "0xFd2EAE…6519" },
    ],
    policy: "ops/schema-dual-sign@v4",
    size: "1.8 KB",
    signedAt: "14:10:02 UTC",
  },
  {
    id: "r_4e137",
    kind: "run",
    subject: "run-2743",
    subjectSub: "gov-review-2",
    signers: [
      { initials: "P", tone: "sage", role: "operator", address: "0xFd2EAE…6519" },
      { initials: "C", tone: "ink", role: "cosigner", address: "0x9A13BC…0cb2" },
      { initials: "V", tone: "blue", role: "verifier", address: "0x4D1E…7EbC" },
    ],
    policy: "deps/sec-only@v2",
    size: "6.3 KB",
    signedAt: "14:09:47 UTC",
  },
  {
    id: "r_4e12a",
    kind: "run",
    subject: "run-2742",
    subjectSub: "writer-gov-1",
    signers: [
      { initials: "P", tone: "sage", role: "operator", address: "0xFd2EAE…6519" },
      { initials: "C", tone: "ink", role: "cosigner", address: "0x9A13BC…0cb2" },
      { initials: "V", tone: "blue", role: "verifier", address: "0x4D1E…7EbC" },
    ],
    policy: "writer-gov/cited@v3",
    size: "12.4 KB",
    signedAt: "14:08:42 UTC",
  },
  {
    id: "r_4e119",
    kind: "settle",
    subject: "loan-0a13",
    subjectSub: "stake movement",
    signers: [
      { initials: "P", tone: "sage", role: "operator", address: "0xFd2EAE…6519" },
    ],
    policy: "treasury/unwind-safe@v1",
    size: "3.8 KB",
    signedAt: "14:07:02 UTC",
  },
  {
    id: "r_4e118",
    kind: "run",
    subject: "run-2741",
    subjectSub: "gov-review-2",
    signers: [
      { initials: "P", tone: "sage", role: "operator", address: "0xFd2EAE…6519" },
      { initials: "C", tone: "muted", role: "cosigner", address: "pending…" },
    ],
    policy: "deps/sec-only@v2",
    size: "5.9 KB",
    signedAt: "14:06:31 UTC",
  },
  {
    id: "r_4e117",
    kind: "badge",
    subject: "governance-1",
    subjectSub: "agent award",
    signers: [
      { initials: "V", tone: "blue", role: "verifier", address: "0x4D1E…7EbC" },
    ],
    policy: "reputation/tier-up",
    size: "2.4 KB",
    signedAt: "14:04:15 UTC",
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
  const [selectedId, setSelectedId] = useState<string | null>("r_4e12a");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const liveRows = useMemo(() => extractReceiptRows(badgesRequest.data), [badgesRequest.data]);
  const rows = useMemo(
    () => (liveRows.length ? liveRows : ROWS.map(fixtureReceiptRow)),
    [liveRows]
  );
  const kpis = useMemo(() => receiptKpis(rows, liveRows.length > 0), [liveRows.length, rows]);
  const selected = selectedId ? rows.find((r) => r.id === selectedId) ?? null : null;
  const detailRequest = useBadge(drawerOpen && selected ? selected.sessionId : null);
  const drawerModel = selected ? buildReceiptDrawer(selected, detailRequest.data) : null;

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <ReceiptsTopbar />

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
        totalCount={liveRows.length ? rows.length : 2134}
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
          />
        ) : null}
      </DetailDrawer>
    </div>
  );
}

function fixtureReceiptRow(row: ReceiptRow): ReceiptRowWithMeta {
  return {
    ...row,
    sessionId: row.subject,
    issuedAtIso: "",
  };
}

function receiptKpis(rows: ReceiptRowWithMeta[], live: boolean): ReceiptsKpi[] {
  if (!live) return KPIS;
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
    KPIS[3],
  ];
}

function receiptDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString().slice(0, 10);
}
