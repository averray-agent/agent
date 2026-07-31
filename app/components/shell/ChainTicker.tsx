"use client";

import { useEffect, useState } from "react";

import { useHealth } from "@/lib/api/hooks";
import { deriveChainTicker, type ChainTickerTone } from "@/lib/chain-ticker";
import { cn } from "@/lib/utils/cn";

// Live block-height chip for the operator rail. Data comes from the shared
// /health poll (useHealth → SWR); the height never counts up on its own — only
// the age ticks, anchored to the backend's `asOf`. Stale/failing reads dull the
// chip to a warn tone rather than presenting old data as live. All display
// logic is in the pure deriveChainTicker so it stays honest and testable.

const DOT_TONE: Record<ChainTickerTone, string> = {
  ok: "bg-[var(--accent)]",
  degraded: "bg-[var(--warn)]",
  awaiting: "bg-[var(--muted)]",
};

export function ChainTicker() {
  const { data, error } = useHealth();
  const [nowMs, setNowMs] = useState<number | null>(null);

  // Start the clock only on the client (SSR/static-export renders no time), then
  // tick once a second so the age advances without touching the height.
  useEffect(() => {
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const view = deriveChainTicker({
    health: data as never,
    pollError: Boolean(error),
    nowMs: nowMs ?? 0,
  });

  const dotAnimate = view.tone === "ok" && !view.stale;

  return (
    <div
      className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5"
      role="status"
      aria-label={view.title}
      title={view.title}
    >
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          DOT_TONE[view.tone],
          dotAnimate && "animate-pulse"
        )}
      />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[var(--ink)]">
          {view.kind === "awaiting" ? "chain · —" : view.heightLabel}
        </span>
        <span className="truncate text-[10px] text-[var(--muted)]">
          {view.kind === "awaiting"
            ? "awaiting chain read"
            : `${view.chainLabel}${view.ageLabel ? ` · ${view.ageLabel}` : ""}`}
        </span>
      </span>
    </div>
  );
}
