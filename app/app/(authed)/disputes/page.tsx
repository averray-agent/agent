"use client";

import { useMemo, useState } from "react";
import { DetailDrawer } from "@/components/shell/DetailDrawer";
import { DisputesTopbar } from "@/components/disputes/DisputesTopbar";
import { DisputesAggregateStrip } from "@/components/disputes/DisputesAggregateStrip";
import {
  DisputesFilterRail,
  type DisputesFilter,
} from "@/components/disputes/DisputesFilterRail";
import { DisputesTable } from "@/components/disputes/DisputesTable";
import { DisputesLegend } from "@/components/disputes/DisputesLegend";
import { DisputeDrawerBody } from "@/components/disputes/DisputeDrawerBody";
import { DisputeStatePill, OriginPill } from "@/components/disputes/pills";
import { extractDispute, extractDisputeList } from "@/lib/api/dispute-adapters";
import { useDispute, useDisputes } from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";

export default function DisputesPage() {
  const disputesRequest = useDisputes();
  const [filter, setFilter] = useState<DisputesFilter>({
    state: "all",
    severity: "all",
    origin: "all",
    q: "",
  });
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const liveDisputes = useMemo(
    () => extractDisputeList(disputesRequest.data),
    [disputesRequest.data]
  );
  const disputes = liveDisputes;
  const isLive = liveDisputes.length > 0;
  const pickedFromList = pickedId
    ? disputes.find((d) => d.id === pickedId) ?? null
    : null;
  const detailRequest = useDispute(drawerOpen && pickedFromList ? pickedFromList.id : null);
  const pickedDetail = extractDispute(detailRequest.data);
  const picked = pickedDetail ?? pickedFromList;

  const filtered = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    return disputes.filter((d) => {
      if (filter.state !== "all" && d.state !== filter.state) return false;
      if (filter.severity !== "all" && d.severity !== filter.severity) return false;
      if (filter.origin !== "all" && d.origin !== filter.origin) return false;
      if (q) {
        const hay = [
          d.id,
          d.runRef,
          d.openingReceipt,
          d.opener.handle,
          d.opener.address,
          d.respondent.handle,
          d.respondent.address,
          d.summary,
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [disputes, filter]);

  const freshness = freshnessFromRequests(disputesRequest);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <DisputesTopbar freshness={freshness} />

      <header className="flex flex-col gap-1.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Contested runs
        </span>
        <h1 className="m-0 font-[family-name:var(--font-display)] text-[2.4rem] font-bold leading-none text-[var(--avy-ink)]">
          Disputes
        </h1>
        <p className="m-0 mt-0.5 max-w-[62ch] font-[family-name:var(--font-body)] text-[16px] leading-[1.55] text-[var(--avy-muted)]">
          Stake frozen, runs paused, verdicts pending. Every resolution signs a
          rationale into the receipt — no freeform chat, no deletable decisions.
        </p>
      </header>

      <DisputesAggregateStrip disputes={disputes} />
      <DisputesFilterRail filter={filter} onChange={setFilter} />
      <DisputesTable
        rows={filtered}
        totalCount={disputes.length}
        selectedId={pickedId}
        onSelect={(d) => {
          setPickedId(d.id);
          setDrawerOpen(true);
        }}
      />
      <DisputesLegend />

      <DetailDrawer
        open={drawerOpen && !!picked}
        onClose={() => setDrawerOpen(false)}
        width={680}
        title={
          picked ? (
            <>
              <span
                className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
                style={{ letterSpacing: "0.14em" }}
              >
                Dispute · frozen stake
              </span>
              <h2
                className="mt-0.5 font-[family-name:var(--font-mono)] text-[20px] font-semibold leading-none text-[var(--avy-ink)]"
                style={{ letterSpacing: 0 }}
              >
                {picked.id}
              </h2>
            </>
          ) : null
        }
        meta={
          picked ? (
            <div
              className="flex flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              <OriginPill origin={picked.origin} />
              <DisputeStatePill state={picked.state} />
              <span>
                on <span className="text-[var(--avy-ink)]">{picked.runRef}</span>
              </span>
              <span>·</span>
              <span>opened {picked.openedAt}</span>
            </div>
          ) : null
        }
      >
        {picked ? <DisputeDrawerBody dispute={picked} live={isLive} /> : null}
      </DetailDrawer>
    </div>
  );
}
