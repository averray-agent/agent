"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const pad = (n: number) => String(n).padStart(2, "0");
const SEED_BLOCK = 28_419_821;

export function OverviewTopbar() {
  const [time, setTime] = useState("");
  const [block, setBlock] = useState(SEED_BLOCK);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`);
    };
    tick();
    const tId = setInterval(tick, 1000);
    const bId = setInterval(() => setBlock((b) => b + 1), 6000);
    return () => {
      clearInterval(tId);
      clearInterval(bId);
    };
  }, []);

  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div
          className="flex items-center gap-2 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.08em" }}
        >
          <span>Room</span>
          <span className="opacity-40">/</span>
          <span className="text-[var(--avy-ink)]">Overview</span>
        </div>
        <span
          className="inline-flex items-center gap-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
          suppressHydrationWarning
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] [animation:pulse_2s_infinite]" />
          <span className="text-[var(--avy-ink)]">{time || "—"} UTC</span>
          <span className="opacity-40">·</span>
          <span className="text-[var(--avy-accent)]">#{block.toLocaleString()}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-ink)] transition-transform hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)]"
          style={{ letterSpacing: "0.04em" }}
        >
          Export briefing
        </button>
        <Link
          href="/runs"
          className="inline-flex h-[34px] items-center gap-1.5 rounded-[8px] bg-[var(--avy-accent)] px-3.5 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
          style={{ letterSpacing: "0.04em" }}
        >
          Open run queue
        </Link>
      </div>
    </header>
  );
}
