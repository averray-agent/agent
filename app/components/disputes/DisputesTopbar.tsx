"use client";

import { useEffect, useState } from "react";
import {
  DataFreshnessPill,
  type FreshnessState,
} from "@/components/shell/DataFreshnessPill";

const pad = (n: number) => String(n).padStart(2, "0");

export function DisputesTopbar({ freshness }: { freshness?: FreshnessState }) {
  const [time, setTime] = useState("");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
      );
    };
    tick();
    const tId = setInterval(tick, 1000);
    return () => {
      clearInterval(tId);
    };
  }, []);

  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div
          className="flex items-center gap-2 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.08em" }}
        >
          <span>Governance</span>
          <span className="opacity-40">/</span>
          <span className="text-[var(--avy-ink)]">Disputes</span>
        </div>
        <span
          className="inline-flex items-center gap-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
          suppressHydrationWarning
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] [animation:pulse_2s_infinite]" />
          <span className="text-[var(--avy-ink)]">{time || "—"} UTC</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        {freshness ? <DataFreshnessPill state={freshness} /> : null}
        <button
          type="button"
          className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)]"
          style={{ letterSpacing: "0.04em" }}
        >
          Open queue
        </button>
        <button
          type="button"
          className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] border border-[color:rgba(167,97,34,0.35)] bg-[var(--avy-warn-soft)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-warn)] transition-transform hover:-translate-y-px hover:border-[color:rgba(167,97,34,0.55)]"
          style={{ letterSpacing: "0.04em" }}
        >
          Escalate to verifier-2
        </button>
      </div>
    </header>
  );
}
