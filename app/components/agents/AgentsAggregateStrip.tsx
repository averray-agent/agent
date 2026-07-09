import { cn } from "@/lib/utils/cn";
import type { AgentRecord } from "./types";

export interface AgentsAggregateStripProps {
  agents: AgentRecord[];
}

/**
 * Top-of-page summary cards on /agents. Each card is explicitly scoped —
 * every number is derived from the visible roster so the operator never
 * reads seeded platform-wide counters as live state.
 */
export function AgentsAggregateStrip({ agents }: AgentsAggregateStripProps) {
  const rosterCount = agents.length;
  const workingNow = agents.filter((a) => isWorking(a.state)).length;
  const slashed = agents.filter((a) => a.state === "slashed").length;
  const verifiedBadges = agents.reduce((count, agent) => count + agent.badges.length, 0);

  const scores = agents.map((a) => a.score);
  const avgRep =
    rosterCount > 0
      ? Math.round(scores.reduce((s, n) => s + n, 0) / rosterCount)
      : 0;

  // Working / Roster meta uses the actual roster size so the copy stays
  // honest at small N: "1 visible agent" reads better than "below
  // healthy floor" when the roster is just one wallet.
  const workingMeta =
    rosterCount === 0
      ? "no agents visible"
      : workingNow === 0
        ? rosterCount === 1
          ? "1 visible agent · idle"
          : `${rosterCount} visible · all idle`
        : `${workingNow} working · ${rosterCount} visible`;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <AggCard
        scope="visible roster"
        label="Working now"
        value={`${workingNow}`}
        unit={`/ ${rosterCount}`}
        meta={workingMeta}
        metaTone={workingNow > 0 ? "ok" : "muted"}
      />
      <AggCard
        scope="visible roster"
        label="Badge receipts"
        value={`${verifiedBadges}`}
        unit="badges"
        meta={rosterCount === 0 ? "no agents visible" : "verified outcomes only"}
        metaTone={verifiedBadges > 0 ? "ok" : "muted"}
      />
      <AggCard
        scope="visible roster"
        label="Avg reputation"
        value={`${avgRep}`}
        mono
        meta={
          rosterCount === 0
            ? "no agents visible"
            : `across ${rosterCount} visible agent${rosterCount === 1 ? "" : "s"}`
        }
        metaTone={avgRep > 0 ? "ok" : "muted"}
      />
      <AggCard
        scope="visible roster"
        label="Agents slashed"
        value={`${slashed}`}
        valueAccent={slashed > 0 ? "bad" : undefined}
        meta={
          slashed > 0
            ? `${slashed} with recorded slash events`
            : "no recorded slash events"
        }
        metaTone={slashed > 0 ? "bad" : "ok"}
      />
    </div>
  );
}

function isWorking(state: AgentRecord["state"]): boolean {
  // "Working now" for the strip means: holds an open claim or has work
  // in some pre-verify lifecycle stage. `active` is the legacy umbrella
  // for "has a verified history", which is *not* the same as "currently
  // doing work" — we don't count those.
  return state === "claimed" || state === "working" || state === "submitted";
}

interface AggCardProps {
  scope: string;
  label: string;
  value: string;
  unit?: string;
  mono?: boolean;
  meta: string;
  metaTone?: "muted" | "ok" | "warn" | "bad";
  valueAccent?: "bad";
}

function AggCard({
  scope,
  label,
  value,
  unit,
  mono,
  meta,
  metaTone = "muted",
  valueAccent,
}: AggCardProps) {
  return (
    <article className="flex min-h-[96px] flex-col gap-1.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)] backdrop-blur-[8px]">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex flex-col gap-px">
          <span
            className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
            style={{ letterSpacing: "0.12em" }}
          >
            {label}
          </span>
          <span
            className="font-[family-name:var(--font-mono)] text-[9.5px] uppercase text-[var(--avy-muted)] opacity-80"
            style={{ letterSpacing: "0.1em" }}
          >
            {scope}
          </span>
        </div>
      </div>
      <div className="flex items-end justify-between gap-2">
        <span
          className={cn(
            "flex items-baseline gap-1.5 font-[family-name:var(--font-display)] font-bold text-[2rem] leading-none tabular-nums",
            mono && "!font-[family-name:var(--font-mono)]",
            valueAccent === "bad" && "text-[#8a2a2a]",
            !valueAccent && "text-[var(--avy-ink)]"
          )}
        >
          {value}
          {unit ? (
            <span className="text-[13px] font-semibold text-[var(--avy-muted)]">
              {unit}
            </span>
          ) : null}
        </span>
      </div>
      <span
        className={cn(
          "flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px]",
          metaTone === "ok" && "text-[var(--avy-accent)]",
          metaTone === "warn" && "text-[var(--avy-warn)]",
          metaTone === "bad" && "text-[#8a2a2a]",
          (!metaTone || metaTone === "muted") && "text-[var(--avy-muted)]"
        )}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" />
        {meta}
      </span>
    </article>
  );
}
