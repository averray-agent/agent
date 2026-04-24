"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils/cn";

interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

/** Unified LCS diff — ported verbatim from the handoff. */
function computeDiff(prev: string, next: string): DiffLine[] {
  const a = prev.split("\n");
  const b = next.split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "-", text: a[i] });
      i++;
    } else {
      out.push({ kind: "+", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ kind: "-", text: a[i++] });
  while (j < n) out.push({ kind: "+", text: b[j++] });
  return out;
}

export function DiffView({
  prev,
  next,
  prevLabel,
  nextLabel,
}: {
  prev: string;
  next: string;
  prevLabel: string;
  nextLabel: string;
}) {
  const lines = useMemo(() => computeDiff(prev, next), [prev, next]);

  return (
    <div className="overflow-hidden rounded-[8px] border border-[var(--avy-line)] bg-[#131715] font-[family-name:var(--font-mono)] text-[11.5px] text-[#e8e5dc]">
      <header
        className="grid grid-cols-2 border-b border-white/5 bg-black/20"
        style={{ letterSpacing: 0 }}
      >
        <span className="border-r border-white/5 px-3 py-1.5 text-[#e38a8a]">
          <span className="mr-1 font-bold">−</span>
          {prevLabel}
        </span>
        <span className="px-3 py-1.5 text-[#9bd7b5]">
          <span className="mr-1 font-bold">+</span>
          {nextLabel}
        </span>
      </header>
      <div className="max-h-[320px] overflow-auto py-1.5" style={{ letterSpacing: 0 }}>
        {lines.map((ln, i) => (
          <div
            key={i}
            className={cn(
              "grid grid-cols-[24px_1fr] items-start px-2.5 leading-[1.55]",
              ln.kind === "+" && "bg-[rgba(155,215,181,0.09)]",
              ln.kind === "-" && "bg-[rgba(227,138,138,0.09)]"
            )}
          >
            <span
              className={cn(
                "select-none text-center",
                ln.kind === "+" && "text-[#9bd7b5]",
                ln.kind === "-" && "text-[#e38a8a]",
                ln.kind === " " && "text-[#6c7a72]"
              )}
            >
              {ln.kind}
            </span>
            <span className="whitespace-pre">{ln.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
