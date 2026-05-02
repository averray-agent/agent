"use client";

import { useMemo, useState } from "react";
import { AgentsTopbar } from "@/components/agents/AgentsTopbar";
import { AgentsAggregateStrip } from "@/components/agents/AgentsAggregateStrip";
import {
  AgentsFilterRail,
  type AgentsFilterState,
} from "@/components/agents/AgentsFilterRail";
import { AgentDirectoryTable } from "@/components/agents/AgentDirectoryTable";
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

      <AgentDirectoryTable
        rows={filtered}
        total={agents.length}
        selectedHandle={openHandle}
        onSelect={(agent) => {
          setOpenHandle(agent.handle);
          setDrawerOpen(true);
        }}
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
    </div>
  );
}
