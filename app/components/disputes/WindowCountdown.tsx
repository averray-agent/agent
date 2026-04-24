"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";

export interface WindowCountdownProps {
  /** Total window in seconds. */
  total: number;
  /** Seconds already elapsed when the fixture was seeded. */
  elapsed: number;
  /** Show a smaller layout for inline use inside tables. */
  size?: "sm" | "md";
  /** If true, pause the live tick (used for resolved disputes). */
  frozen?: boolean;
}

/**
 * Live-ticking countdown with a three-state visual:
 *   - neutral: > 10% remaining
 *   - amber  : < 10% remaining, pulses once per second
 *   - expired: 0 remaining, deep-red frame, no pulse
 *
 * Pure client component — no hydration mismatch because the initial
 * render takes the seeded `elapsed` value directly.
 */
export function WindowCountdown({
  total,
  elapsed: seedElapsed,
  size = "md",
  frozen,
}: WindowCountdownProps) {
  const [elapsed, setElapsed] = useState(seedElapsed);

  useEffect(() => {
    if (frozen) {
      setElapsed(seedElapsed);
      return;
    }
    setElapsed(seedElapsed);
    const id = setInterval(() => {
      setElapsed((e) => Math.min(total, e + 1));
    }, 1000);
    return () => clearInterval(id);
  }, [frozen, seedElapsed, total]);

  const remaining = Math.max(0, total - elapsed);
  const pct = remaining / total;
  const expired = remaining === 0;
  const hot = !expired && pct <= 0.1;

  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-[family-name:var(--font-mono)] tabular-nums",
        size === "sm" ? "text-[11px]" : "text-[12.5px]",
        expired && "border border-[color:rgba(140,42,23,0.35)] bg-[color:rgba(243,210,201,0.55)] text-[#8c2a17]",
        hot && "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
        !expired && !hot && "bg-[color:rgba(17,19,21,0.05)] text-[var(--avy-ink)]"
      )}
      style={{ letterSpacing: 0 }}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full bg-current",
          hot && "[animation:pulse_1s_ease-in-out_infinite]",
          expired && "opacity-70"
        )}
      />
      {expired ? "expired" : `${mm}:${ss}`}
    </span>
  );
}
