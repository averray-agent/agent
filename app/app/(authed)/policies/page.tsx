"use client";

import { useMemo, useState } from "react";
import { DetailDrawer } from "@/components/shell/DetailDrawer";
import { PoliciesTopbar } from "@/components/policies/PoliciesTopbar";
import { PoliciesAggregateStrip } from "@/components/policies/PoliciesAggregateStrip";
import {
  PoliciesFilterRail,
  type PoliciesFilter,
} from "@/components/policies/PoliciesFilterRail";
import { PoliciesTable } from "@/components/policies/PoliciesTable";
import { PolicyLegend } from "@/components/policies/PolicyLegend";
import {
  PolicyDrawerBody,
  PolicyDrawerHeader,
} from "@/components/policies/PolicyDrawerBody";
import { POLICIES } from "@/components/policies/policies-data";
import { SIGNERS } from "@/components/policies/signers";
import type { PolicyState } from "@/components/policies/types";

const STATUS_TO_STATE: Record<Exclude<PoliciesFilter["status"], "all">, PolicyState> = {
  active: "Active",
  draft: "Draft",
  "pending-signers": "Pending",
  retired: "Retired",
};

// TODO(data): replace the seed roster with useApi("/policies") once the
// backend emits a list endpoint. Drill-in swaps to useApi(`/policies/${tag}`).
// Propose-change form posts to POST /admin/policies and queues a proposal.

export default function PoliciesPage() {
  const [filter, setFilter] = useState<PoliciesFilter>({
    scope: "all",
    status: "all",
    severity: "all",
    q: "",
  });
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    return POLICIES.filter((p) => {
      if (filter.scope !== "all" && p.scope !== filter.scope) return false;
      if (filter.status !== "all" && p.state !== STATUS_TO_STATE[filter.status])
        return false;
      if (filter.severity !== "all" && p.severity !== filter.severity) return false;
      if (q) {
        const hay = [
          p.tag,
          p.scope,
          p.severity,
          p.gates,
          p.handler,
          `v${p.revision}`,
          p.lastChange.text,
          ...p.signerKeys.map((k) => SIGNERS[k].addr),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [filter]);

  const picked = pickedId ? POLICIES.find((p) => p.id === pickedId) ?? null : null;

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <PoliciesTopbar />

      <header className="flex flex-col gap-1.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Rule surface
        </span>
        <h1 className="m-0 font-[family-name:var(--font-display)] text-[2.4rem] font-bold leading-none text-[var(--avy-ink)]">
          Policies
        </h1>
        <p className="m-0 mt-0.5 max-w-[62ch] font-[family-name:var(--font-body)] text-[16px] leading-[1.55] text-[var(--avy-muted)]">
          Every action is gated by a policy — every change is signed.
        </p>
      </header>

      <PoliciesAggregateStrip policies={POLICIES} />
      <PoliciesFilterRail filter={filter} onChange={setFilter} />
      <PoliciesTable
        rows={filtered}
        totalCount={POLICIES.length}
        selectedId={pickedId}
        onSelect={(p) => {
          setPickedId(p.id);
          setDrawerOpen(true);
        }}
      />
      <PolicyLegend />

      <DetailDrawer
        open={drawerOpen && !!picked}
        onClose={() => setDrawerOpen(false)}
        width={620}
        title={picked ? <PolicyDrawerHeader policy={picked} /> : null}
      >
        {picked ? <PolicyDrawerBody policy={picked} /> : null}
      </DetailDrawer>
    </div>
  );
}
