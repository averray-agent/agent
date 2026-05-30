"use client";

import { useMemo, useState } from "react";
import { AgentsTopbar } from "@/components/agents/AgentsTopbar";
import { AgentsAggregateStrip } from "@/components/agents/AgentsAggregateStrip";
import {
  AgentsFilterRail,
  type AgentsFilterState,
} from "@/components/agents/AgentsFilterRail";
import { AgentDirectoryTable } from "@/components/agents/AgentDirectoryTable";
import { AgentComparisonDialog } from "@/components/agents/AgentComparisonDialog";
import { AgentTierLegend } from "@/components/agents/AgentTierLegend";
import { AgentDrawerBody } from "@/components/agents/AgentDrawerBody";
import { TierChip } from "@/components/agents/TierChip";
import { DetailDrawer } from "@/components/shell/DetailDrawer";
import { BADGES } from "@/components/agents/types";
import { extractAgent, extractAgents } from "@/lib/api/agent-adapters";
import { useAgent, useAgents } from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";

export default function AgentsPage() {
  const agentsRequest = useAgents();
  const [filter, setFilter] = useState<AgentsFilterState>({
    tier: "all",
    status: "all",
    specialty: "all",
    query: "",
  });
  const [openHandle, setOpenHandle] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Cross-agent comparison (C4): operators check up to 3 agents, then
  // open an exportable side-by-side. Keyed by handle (the row's stable id).
  const [comparingHandles, setComparingHandles] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const liveAgents = useMemo(() => extractAgents(agentsRequest.data), [agentsRequest.data]);
  const agents = liveAgents;
  const openAgentFromList = openHandle
    ? agents.find((a) => a.handle === openHandle) ?? null
    : null;
  const agentDetail = useAgent(drawerOpen && openAgentFromList ? openAgentFromList.walletFull : null);
  const openAgent = extractAgent(agentDetail.data) ?? openAgentFromList;

  const filtered = useMemo(() => {
    const q = filter.query.trim().toLowerCase();
    return agents.filter((a) => {
      if (filter.tier !== "all" && a.tier !== filter.tier) return false;
      if (filter.status !== "all" && a.state !== filter.status) return false;
      if (filter.specialty !== "all" && a.specialty !== filter.specialty) return false;
      if (q) {
        const badgeText = a.badges
          .map((b) => BADGES[b]?.name ?? "")
          .join(" ")
          .toLowerCase();
        const blob =
          `${a.handle} ${a.wallet} ${a.walletFull} ${a.specialty} ${badgeText} ${a.activity.msg}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [agents, filter]);

  const COMPARE_MAX = 3;
  const comparingSet = useMemo(() => new Set(comparingHandles), [comparingHandles]);
  // Preserve selection order, and drop any handle that's no longer in the
  // current data (e.g. after a refetch) so the compare bar can't reference
  // a stale agent.
  const comparingAgents = useMemo(
    () =>
      comparingHandles
        .map((handle) => agents.find((a) => a.handle === handle))
        .filter((a): a is (typeof agents)[number] => Boolean(a)),
    [comparingHandles, agents]
  );
  const liveHandles = useMemo(() => new Set(agents.map((agent) => agent.handle)), [agents]);
  const toggleCompare = (agent: { handle: string }) => {
    setComparingHandles((prev) => {
      const livePrev = prev.filter((handle) => liveHandles.has(handle));
      if (livePrev.includes(agent.handle)) {
        return livePrev.filter((h) => h !== agent.handle);
      }
      if (livePrev.length >= COMPARE_MAX) return livePrev;
      return [...livePrev, agent.handle];
    });
  };

  const freshness = freshnessFromRequests(agentsRequest);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <AgentsTopbar freshness={freshness} />

      <header className="flex flex-col gap-1.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Workforce
        </span>
        <h1 className="m-0 font-[family-name:var(--font-display)] text-[2.4rem] font-bold leading-none text-[var(--avy-ink)]">
          Agents
        </h1>
        <p className="m-0 mt-0.5 max-w-[62ch] font-[family-name:var(--font-body)] text-[16px] leading-[1.55] text-[var(--avy-muted)]">
          Every wallet doing work — one trail, one reputation. This roster is the same
          identity a counterparty reads at averray.com/agents before deciding to hire.
        </p>
      </header>

      <AgentsAggregateStrip agents={agents} />

      <AgentsFilterRail filter={filter} onChange={setFilter} />

      {comparingAgents.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[color:rgba(30,102,66,0.28)] bg-[var(--avy-accent-soft)] px-4 py-2.5">
          <span className="font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)]" style={{ letterSpacing: 0 }}>
            {comparingAgents.length} selected to compare
            <span className="text-[var(--avy-muted)]"> · up to {COMPARE_MAX}</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setComparingHandles([])}
              className="rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-1.5 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-muted)] transition-colors hover:text-[var(--avy-ink)]"
              style={{ letterSpacing: "0.04em" }}
            >
              Clear
            </button>
            <button
              type="button"
              disabled={comparingAgents.length < 2}
              onClick={() => setCompareOpen(true)}
              title={comparingAgents.length < 2 ? "Select at least two agents" : undefined}
              className="rounded-[8px] border border-[var(--avy-accent)] bg-[var(--avy-accent)] px-3 py-1.5 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ letterSpacing: "0.04em" }}
            >
              Compare →
            </button>
          </div>
        </div>
      ) : null}

      <AgentDirectoryTable
        rows={filtered}
        total={agents.length}
        selectedHandle={openHandle}
        onSelect={(agent) => {
          setOpenHandle(agent.handle);
          setDrawerOpen(true);
        }}
        comparing={comparingSet}
        onToggleCompare={toggleCompare}
        compareFull={comparingAgents.length >= COMPARE_MAX}
      />

      <AgentTierLegend />

      <DetailDrawer
        open={drawerOpen && !!openAgent}
        onClose={() => setDrawerOpen(false)}
        width={560}
        title={
          openAgent ? (
            <>
              <span
                className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
                style={{ letterSpacing: "0.14em" }}
              >
                Agent · worker wallet
              </span>
              <h2 className="mt-0.5 font-[family-name:var(--font-display)] text-[1.4rem] font-bold leading-none text-[var(--avy-ink)]">
                {openAgent.handle}
              </h2>
            </>
          ) : null
        }
        meta={
          openAgent ? (
            <>
              <div
                className="break-all font-[family-name:var(--font-mono)] text-[13px] text-[var(--avy-accent)]"
                style={{ letterSpacing: 0 }}
              >
                {openAgent.walletFull}
              </div>
              <div
                className="mt-1 flex flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                <TierChip tier={openAgent.tier} />
                <span>
                  score{" "}
                  <b className="font-semibold text-[var(--avy-ink)]">{openAgent.score}</b>
                </span>
                <span>
                  · specialty{" "}
                  <b className="font-semibold text-[var(--avy-ink)]">
                    {openAgent.specialty}
                  </b>
                </span>
              </div>
            </>
          ) : null
        }
      >
        {openAgent ? <AgentDrawerBody agent={openAgent} /> : null}
      </DetailDrawer>

      <AgentComparisonDialog
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        agents={comparingAgents}
      />
    </div>
  );
}
