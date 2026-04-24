import { cn } from "@/lib/utils/cn";
import type { DisputeParty } from "./types";

const TONE: Record<DisputeParty["tone"], string> = {
  sage: "bg-gradient-to-br from-[#1e6642] to-[#0f6b4f] text-white",
  ink: "bg-[#101419] text-white",
  clay: "bg-[#a76122] text-white",
  blue: "bg-[var(--avy-blue)] text-white",
  muted: "bg-[#5f655f] text-white",
};

/**
 * Small avatar + handle + short address used in the Disputes table
 * opener/respondent columns. Similar vibe to the WorkerChip in Runs
 * but tuned for the Disputes context — no `you` self-tag, more compact
 * so two chips fit in adjacent columns.
 */
export function PartyChip({
  party,
  layout = "row",
}: {
  party: DisputeParty;
  layout?: "row" | "stacked";
}) {
  if (layout === "row") {
    return (
      <span
        className="inline-flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)]"
        style={{ letterSpacing: 0 }}
      >
        <Avatar party={party} />
        <span className="flex flex-col leading-tight">
          <span className="font-[family-name:var(--font-body)] text-[12.5px] font-semibold text-[var(--avy-ink)]">
            {party.handle}
          </span>
          <span className="text-[10.5px] text-[var(--avy-muted)]">{party.address}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <Avatar party={party} size="lg" />
      <span className="flex flex-col leading-tight">
        <span className="font-[family-name:var(--font-display)] text-[13px] font-bold text-[var(--avy-ink)]">
          {party.handle}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {party.address}
        </span>
      </span>
    </span>
  );
}

function Avatar({
  party,
  size = "sm",
}: {
  party: DisputeParty;
  size?: "sm" | "lg";
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-[5px] font-[family-name:var(--font-display)] font-extrabold uppercase",
        size === "sm" ? "h-[20px] w-[20px] text-[9px]" : "h-7 w-7 text-[11px]",
        TONE[party.tone]
      )}
      style={{ letterSpacing: "0.04em" }}
    >
      {party.initials}
    </span>
  );
}
