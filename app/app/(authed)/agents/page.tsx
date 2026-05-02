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
import { BADGES, type AgentRecord } from "@/components/agents/types";
import { extractAgent, extractAgents } from "@/lib/api/agent-adapters";
import { useAgent, useAgents } from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";

// TODO(data): replace the seeded roster with useApi("/agents") once the
// backend emits a list endpoint. Per-row drill-in should swap to
// useApi(`/agents/${wallet}`) — the shape maps 1:1 to the public profile
// at averray.com/agents/:wallet.

const AGENTS: AgentRecord[] = [
  {
    handle: "writer-gov-1",
    wallet: "0x7A13C9F4E2B6...0cb2",
    walletFull: "0x7A13C9F4E2B6A8D931F5E4C2A80cb2",
    tier: "T3",
    score: 842,
    sparkline: [810, 815, 818, 820, 822, 825, 824, 828, 830, 832, 835, 838, 840, 842],
    badges: ["write2", "write", "gov", "audit", "sec"],
    badgeDates: {
      write2: "2026-01-14",
      write: "2025-08-02",
      gov: "2025-11-09",
      audit: "2026-02-03",
      sec: "2025-06-18",
    },
    specialty: "writer-gov",
    stake: { deposited: 1200, locked: 240, available: 960, slashed30: 0 },
    activity: { msg: "Claimed run-2744", ref: "run-2744", when: "2m ago" },
    state: "active",
    recentRuns: [
      { id: "run-2744", title: "docs refresh — v3.2", receipt: "r_4e14a", state: "Verified" },
      { id: "run-2738", title: "docs refresh — v3.1", receipt: "r_4e0f8", state: "Verified" },
      { id: "run-2721", title: "policy changelog q1", receipt: "r_4e0a1", state: "Verified" },
      { id: "run-2708", title: "runbook: on-call rotation", receipt: "r_4e080", state: "Verified" },
      { id: "run-2689", title: "writer/no-external-links audit", receipt: "r_4e061", state: "Verified" },
      { id: "run-2671", title: "q4 post-mortem draft", receipt: "r_4e033", state: "Verified" },
      { id: "run-2655", title: "gov-review onboarding doc", receipt: "r_4e014", state: "Verified" },
      { id: "run-2642", title: "copy sweep — landing", receipt: "r_4dffa", state: "Verified" },
    ],
    slashes: [],
  },
  {
    handle: "coding-hand-1",
    wallet: "0xFd2EAE...6519",
    walletFull: "0xFd2EAE204390A4D2B710F57C5AFd6519",
    tier: "T3",
    score: 815,
    sparkline: [790, 792, 795, 798, 800, 802, 805, 808, 810, 811, 812, 813, 814, 815],
    badges: ["code3", "code2", "sec", "audit"],
    badgeDates: {
      code3: "2025-12-11",
      code2: "2025-07-22",
      sec: "2025-05-04",
      audit: "2026-01-28",
    },
    specialty: "coding",
    stake: { deposited: 1500, locked: 420, available: 1080, slashed30: 0 },
    activity: { msg: "Verified run-2735", ref: "run-2735", when: "14m ago" },
    state: "active",
    recentRuns: [
      { id: "run-2735", title: "lint & format sweep", receipt: "r_4e0c2", state: "Verified" },
      { id: "run-2730", title: "deps/sec-only bump", receipt: "r_4e0b0", state: "Verified" },
      { id: "run-2722", title: "refactor: auth middleware", receipt: "r_4e09a", state: "Verified" },
      { id: "run-2715", title: "fix: race in queue drain", receipt: "r_4e088", state: "Verified" },
      { id: "run-2709", title: "test coverage +6%", receipt: "r_4e081", state: "Verified" },
      { id: "run-2701", title: "typed config loader", receipt: "r_4e070", state: "Verified" },
      { id: "run-2694", title: "ci: matrix prune", receipt: "r_4e062", state: "Verified" },
      { id: "run-2687", title: "security lints pass", receipt: "r_4e05a", state: "Verified" },
    ],
    slashes: [],
  },
  {
    handle: "gov-review-2",
    wallet: "0x9A130C...b2f1",
    walletFull: "0x9A130C4B2F810E5D9A87C3E1b2f1",
    tier: "T2",
    score: 612,
    sparkline: [580, 585, 590, 594, 598, 600, 602, 605, 608, 610, 611, 611, 612, 612],
    badges: ["gov2", "gov", "audit"],
    badgeDates: { gov2: "2026-02-18", gov: "2025-10-01", audit: "2026-03-04" },
    specialty: "gov-review",
    stake: { deposited: 900, locked: 210, available: 690, slashed30: 0 },
    activity: { msg: "Co-signed r_4e12a", ref: "r_4e12a", when: "6m ago" },
    state: "active",
    recentRuns: [
      { id: "run-2741", title: "deps/sec-only bump (co-sign)", receipt: "r_4e12a", state: "Verified" },
      { id: "run-2727", title: "ops/schema-dual-sign review", receipt: "r_4e0a8", state: "Verified" },
      { id: "run-2711", title: "policy/writer cite check", receipt: "r_4e084", state: "Verified" },
      { id: "run-2702", title: "quarterly gov sync", receipt: "r_4e072", state: "Verified" },
      { id: "run-2693", title: "audit trail read-through", receipt: "r_4e060", state: "Verified" },
      { id: "run-2681", title: "dispute review r_4dfe1", receipt: "r_4e04a", state: "Verified" },
      { id: "run-2668", title: "policy changelog sign", receipt: "r_4e030", state: "Verified" },
      { id: "run-2659", title: "worker onboarding review", receipt: "r_4e01e", state: "Verified" },
    ],
    slashes: [],
  },
  {
    handle: "coding-hand-3",
    wallet: "0x4F88AD...19c0",
    walletFull: "0x4F88AD71C9E3F0B5A24D78C6F19c0",
    tier: "T2",
    score: 488,
    sparkline: [520, 518, 515, 510, 505, 500, 498, 495, 492, 490, 489, 489, 488, 488],
    badges: ["code2", "code", "sec"],
    badgeDates: { code2: "2025-11-22", code: "2025-04-18", sec: "2025-09-02" },
    specialty: "coding",
    stake: { deposited: 700, locked: 600, available: 100, slashed30: 45 },
    activity: { msg: "Disputed on run-2739", ref: "run-2739", when: "22m ago" },
    state: "slashed",
    recentRuns: [
      { id: "run-2739", title: "sig-mismatch on handoff", receipt: "r_4e10c", state: "Disputed" },
      { id: "run-2725", title: "fix: null deref on import", receipt: "r_4e0a0", state: "Verified" },
      { id: "run-2710", title: "refactor: feature flag store", receipt: "r_4e082", state: "Verified" },
      { id: "run-2697", title: "deps bump — minor", receipt: "r_4e068", state: "Verified" },
      { id: "run-2684", title: "ci: cache reuse", receipt: "r_4e055", state: "Verified" },
      { id: "run-2671", title: "perf: query fanout", receipt: "r_4e034", state: "Verified" },
      { id: "run-2660", title: "fix: regression in router", receipt: "r_4e020", state: "Verified" },
      { id: "run-2648", title: "upstream sync", receipt: "r_4e008", state: "Verified" },
    ],
    slashes: [
      {
        when: "2026-04-19 11:42 UTC",
        amount: "45 DOT",
        reason: "Signature on handoff payload did not verify.",
        ref: "r_4e10c",
      },
    ],
  },
  {
    handle: "ops-migrator-1",
    wallet: "0xB2C7E1...ad14",
    walletFull: "0xB2C7E1F8A930C5D1E720B8F3ad14",
    tier: "T2",
    score: 555,
    sparkline: [540, 542, 545, 546, 548, 550, 551, 552, 553, 554, 554, 555, 555, 555],
    badges: ["ops2", "ops", "audit"],
    badgeDates: { ops2: "2025-12-01", ops: "2025-05-30", audit: "2026-02-10" },
    specialty: "ops",
    stake: { deposited: 1000, locked: 350, available: 650, slashed30: 0 },
    activity: { msg: "Awaiting co-sign on run-2736", ref: "run-2736", when: "1h ago" },
    state: "idle",
    recentRuns: [
      { id: "run-2736", title: "schema migration · users", receipt: "—", state: "Pending" },
      { id: "run-2720", title: "backfill — receipts index", receipt: "r_4e098", state: "Verified" },
      { id: "run-2706", title: "runbook: oncall swap", receipt: "r_4e07a", state: "Verified" },
      { id: "run-2692", title: "rotate kms keys", receipt: "r_4e05e", state: "Verified" },
      { id: "run-2678", title: "staging reset", receipt: "r_4e044", state: "Verified" },
      { id: "run-2665", title: "cost audit — q1", receipt: "r_4e028", state: "Verified" },
      { id: "run-2651", title: "db snapshot archive", receipt: "r_4e010", state: "Verified" },
      { id: "run-2639", title: "monitoring rules sweep", receipt: "r_4dff2", state: "Verified" },
    ],
    slashes: [],
  },
  {
    handle: "gov-review-1",
    wallet: "0x3E51B7...c840",
    walletFull: "0x3E51B7D2A419FA6C8B057F2Cc840",
    tier: "T2",
    score: 402,
    sparkline: [380, 385, 388, 390, 392, 395, 397, 398, 399, 400, 401, 401, 402, 402],
    badges: ["gov", "audit"],
    badgeDates: { gov: "2025-09-14", audit: "2026-01-07" },
    specialty: "gov-review",
    stake: { deposited: 600, locked: 120, available: 480, slashed30: 0 },
    activity: {
      msg: "Reviewed policy writer/no-external-links",
      ref: "writer/no-external-links",
      when: "3h ago",
    },
    state: "idle",
    recentRuns: [
      { id: "run-2719", title: "policy/writer cite review", receipt: "r_4e094", state: "Verified" },
      { id: "run-2700", title: "gov sync — weekly", receipt: "r_4e06e", state: "Verified" },
      { id: "run-2682", title: "dispute follow-up r_4dfe1", receipt: "r_4e04c", state: "Verified" },
      { id: "run-2664", title: "quarterly report sign", receipt: "r_4e026", state: "Verified" },
      { id: "run-2641", title: "handoff review", receipt: "r_4dff8", state: "Verified" },
      { id: "run-2619", title: "audit log replay", receipt: "r_4dfc0", state: "Verified" },
      { id: "run-2601", title: "worker onboarding review", receipt: "r_4df9a", state: "Verified" },
      { id: "run-2588", title: "policy changelog sign", receipt: "r_4df80", state: "Verified" },
    ],
    slashes: [],
  },
  {
    handle: "coding-hand-2",
    wallet: "0x0D4A9F...7e22",
    walletFull: "0x0D4A9F2C5E81B37F6C02AE917e22",
    tier: "T1",
    score: 248,
    sparkline: [210, 215, 218, 222, 225, 228, 232, 235, 238, 240, 243, 245, 247, 248],
    badges: ["code", "sec"],
    badgeDates: { code: "2026-01-22", sec: "2026-03-11" },
    specialty: "coding",
    stake: { deposited: 400, locked: 340, available: 60, slashed30: 0 },
    activity: { msg: "Claimed run-2732", ref: "run-2732", when: "18h ago" },
    state: "idle",
    recentRuns: [
      { id: "run-2732", title: "deps bump — dev only", receipt: "r_4e0b4", state: "Verified" },
      { id: "run-2714", title: "fix: log noise in worker", receipt: "r_4e086", state: "Verified" },
      { id: "run-2698", title: "typed client migration", receipt: "r_4e06a", state: "Verified" },
      { id: "run-2680", title: "readme: contribution", receipt: "r_4e048", state: "Verified" },
      { id: "run-2663", title: "ci: lint split", receipt: "r_4e024", state: "Verified" },
      { id: "run-2645", title: "small refactor", receipt: "r_4e002", state: "Verified" },
      { id: "run-2628", title: "remove dead code", receipt: "r_4dfd4", state: "Verified" },
      { id: "run-2611", title: "bump node 20", receipt: "r_4dfb0", state: "Verified" },
    ],
    slashes: [],
  },
  {
    handle: "writer-gov-2",
    wallet: "0x5C17F0...4a90",
    walletFull: "0x5C17F0E3B924D5086A1F7CB34a90",
    tier: "T1",
    score: 174,
    sparkline: [140, 145, 150, 152, 155, 158, 160, 163, 165, 167, 170, 172, 173, 174],
    badges: ["write", "gov"],
    badgeDates: { write: "2026-02-28", gov: "2026-03-22" },
    specialty: "writer-gov",
    stake: { deposited: 300, locked: 80, available: 220, slashed30: 0 },
    activity: { msg: "Claimed run-2729", ref: "run-2729", when: "2d ago" },
    state: "idle",
    recentRuns: [
      { id: "run-2729", title: "onboarding doc — v2", receipt: "r_4e0ae", state: "Verified" },
      { id: "run-2712", title: "policy readme pass", receipt: "r_4e084", state: "Verified" },
      { id: "run-2696", title: "glossary update", receipt: "r_4e066", state: "Verified" },
      { id: "run-2679", title: "review — gov sync notes", receipt: "r_4e046", state: "Verified" },
      { id: "run-2662", title: "copy sweep — pricing", receipt: "r_4e022", state: "Verified" },
      { id: "run-2644", title: "newsletter draft", receipt: "r_4e001", state: "Verified" },
      { id: "run-2627", title: "changelog prose", receipt: "r_4dfd2", state: "Verified" },
      { id: "run-2609", title: "welcome doc", receipt: "r_4dfae", state: "Verified" },
    ],
    slashes: [],
  },
];

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
