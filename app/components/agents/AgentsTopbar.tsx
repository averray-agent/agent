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
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-white/60 px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.22)] hover:bg-white/92"
          style={{ letterSpacing: "0.04em" }}
        >
          ⤓ Export roster
        </button>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
          style={{ letterSpacing: "0.04em" }}
        >
          ＋ Invite agent
        </button>
      </div>
    </header>
  );
}
