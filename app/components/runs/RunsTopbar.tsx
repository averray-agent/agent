"use client";

import { useEffect, useState } from "react";

function formatTime(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

const SEED_BLOCK = 24_118_402;

export function RunsTopbar() {
  const [time, setTime] = useState("");
  const [block, setBlock] = useState(SEED_BLOCK);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(formatTime(d));
      // Polkadot block ~6s cadence — bump every 6s mod for the demo clock.
      if (d.getUTCSeconds() % 6 === 0) setBlock((b) => b + 1);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-3.5 px-0.5 py-1">
      <div
        className="flex items-center gap-2 font-[family-name:var(--font-display)] text-[11.5px] font-bold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.08em" }}
      >
        <span>Room</span>
        <span className="opacity-50">/</span>
        <span className="text-[var(--avy-ink)]">Runs</span>
      </div>

      <div
        className="inline-flex items-center justify-self-center gap-2.5 rounded-full border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-1.5 font-[family-name:var(--font-mono)] text-xs text-[var(--avy-ink)]"
        suppressHydrationWarning
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#2d8e5e] shadow-[0_0_0_3px_rgba(45,142,94,0.18)]" />
        <span className="text-[var(--avy-muted)]">UTC</span>
        <span>{time || "—"}</span>
        <span className="text-[var(--avy-muted)]">·</span>
        <span className="text-[var(--avy-muted)]">block</span>
        <span>{block.toLocaleString()}</span>
      </div>

      <div className="flex items-center justify-self-end gap-2">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-2 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--avy-ink)] transition-all hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.24)] hover:bg-white"
          style={{ letterSpacing: "0.04em" }}
        >
          ＋ New job
          <span className="rounded-[3px] bg-[color:rgba(17,19,21,0.06)] px-1.5 py-px font-[family-name:var(--font-mono)] text-[10.5px] font-medium text-[var(--avy-muted)]">
            N
          </span>
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-2 rounded-[8px] bg-[var(--avy-accent)] px-3 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase text-[var(--fg-invert)] transition-transform hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
          style={{ letterSpacing: "0.04em" }}
        >
          Open run
          <span className="rounded-[3px] bg-black/20 px-1.5 py-px font-[family-name:var(--font-mono)] text-[10.5px] font-medium text-white/70">
            O
          </span>
        </button>
      </div>
    </header>
  );
}
