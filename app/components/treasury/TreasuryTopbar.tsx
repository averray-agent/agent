"use client";

import { useEffect, useState } from "react";
import {
  DataFreshnessPill,
  type FreshnessState,
} from "@/components/shell/DataFreshnessPill";

const pad = (n: number) => String(n).padStart(2, "0");

function formatTime(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function TreasuryTopbar({ freshness }: { freshness?: FreshnessState }) {
  const [time, setTime] = useState("");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(formatTime(d));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="flex items-center justify-between gap-4 pb-1">
      <div
        className="flex items-center gap-2 font-[family-name:var(--font-display)] text-xs font-bold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.1em" }}
      >
        <span>Capital</span>
        <span className="opacity-40">/</span>
        <span className="text-[var(--avy-ink)]">Treasury</span>
      </div>

      <div
        className="flex items-center gap-3.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        suppressHydrationWarning
      >
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] shadow-[0_0_0_3px_rgba(30,102,66,0.12)] [animation:pulse_2s_infinite]" />
          <span>{time || "—"} UTC</span>
        </span>
      </div>

      <div className="flex items-center gap-2">
        {freshness ? <DataFreshnessPill state={freshness} /> : null}
        <button
          type="button"
          className="inline-flex h-[34px] items-center gap-2 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 font-[family-name:var(--font-display)] text-xs font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.32)]"
          style={{ letterSpacing: "0.04em" }}
        >
          Move capital
        </button>
        <button
          type="button"
          className="inline-flex h-[34px] items-center gap-2 rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-xs font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
          style={{ letterSpacing: "0.04em" }}
        >
          Propose policy change
        </button>
      </div>
    </header>
  );
}
