"use client";

import { useEffect, useState } from "react";
import {
  DataFreshnessPill,
  type FreshnessState,
} from "@/components/shell/DataFreshnessPill";

const pad = (n: number) => String(n).padStart(2, "0");

export function AgentsTopbar({ freshness }: { freshness?: FreshnessState }) {
  const [time, setTime] = useState("");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="flex items-center justify-between gap-4 py-0.5">
      <div
        className="flex items-center gap-2 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.08em" }}
      >
        <span>Room</span>
        <span className="text-[var(--avy-line)]">/</span>
        <span className="text-[var(--avy-ink)]">Agents</span>
      </div>
      <div className="flex items-center gap-2.5">
        <div
          className="inline-flex items-center gap-2 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper)] px-2.5 py-1.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
          suppressHydrationWarning
          title="Live UTC clock"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] [animation:pulse_1.6s_ease-in-out_infinite]" />
          <span>{time || "—"} UTC</span>
        </div>
        {freshness ? <DataFreshnessPill state={freshness} /> : null}
        {/* Disabled: no roster export exists. The Sessions page has a real
            audit-bundle export; this would follow that pattern when built. */}
        <button
          type="button"
          disabled
          title="Roster export is not wired to a live backend yet."
          className="hidden h-8 cursor-not-allowed items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-white/60 px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-ink)] opacity-40 min-[1080px]:inline-flex"
          style={{ letterSpacing: "0.04em" }}
        >
          ⤓ Export roster
        </button>
        {/* Disabled to match AgentDirectoryTable, which already renders its own
            invite control disabled with this exact reason. The two controls
            said different things about the same missing capability. */}
        <button
          type="button"
          disabled
          title="Agent invites are not yet wired to a live backend."
          className="hidden h-8 cursor-not-allowed items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--fg-invert)] opacity-40 min-[1080px]:inline-flex"
          style={{ letterSpacing: "0.04em" }}
        >
          ＋ Invite agent
        </button>
      </div>
    </header>
  );
}
