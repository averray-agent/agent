"use client";

import { useEffect, useState } from "react";
import {
  DataFreshnessPill,
  type FreshnessState,
} from "@/components/shell/DataFreshnessPill";

const pad = (n: number) => String(n).padStart(2, "0");

function formatClock(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} · ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function ReceiptsTopbar({ freshness }: { freshness?: FreshnessState }) {
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () => setClock(formatClock(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="flex items-center justify-between gap-4">
      <div
        className="flex items-center gap-2 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.08em" }}
      >
        <span>Room</span>
        <span className="opacity-40">/</span>
        <span className="text-[var(--avy-ink)]">Receipts</span>
      </div>

      <div
        className="flex items-center gap-3.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        suppressHydrationWarning
      >
        <span className="inline-flex items-center gap-1.5 text-[var(--avy-ink)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] [animation:pulse_2s_infinite]" />
          {clock || "—"}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {freshness ? <DataFreshnessPill state={freshness} /> : null}
        <button
          type="button"
          className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)] hover:bg-white/96"
          style={{ letterSpacing: "0.04em" }}
        >
          ⤓ Export bundle
        </button>
        <button
          type="button"
          className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
          style={{ letterSpacing: "0.04em" }}
        >
          ✓ Verify signature
        </button>
      </div>
    </header>
  );
}
