"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils/cn";
import type { PolicyScope, PolicySeverity } from "./types";

export type StatusFilter = "all" | "active" | "draft" | "pending-signers" | "retired";

export interface PoliciesFilter {
  scope: PolicyScope | "all";
  status: StatusFilter;
  severity: PolicySeverity | "all";
  q: string;
}

const SCOPES: (PolicyScope | "all")[] = [
  "all",
  "claim",
  "settle",
  "xcm",
  "badge",
  "co-sign",
  "worker",
  "treasury",
];
const STATUSES: StatusFilter[] = ["all", "active", "draft", "pending-signers", "retired"];
const SEVERITIES: (PolicySeverity | "all")[] = ["all", "advisory", "gating", "hard-stop"];

export function PoliciesFilterRail({
  filter,
  onChange,
}: {
  filter: PoliciesFilter;
  onChange: (next: PoliciesFilter) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const set = <K extends keyof PoliciesFilter>(k: K, v: PoliciesFilter[K]) =>
    onChange({ ...filter, [k]: v });

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-3 shadow-[var(--shadow-card)] backdrop-blur-[8px]">
      <Row label="Scope">
        {SCOPES.map((s) => (
          <Chip key={s} on={filter.scope === s} onClick={() => set("scope", s)}>
            {s}
          </Chip>
        ))}
      </Row>
      <Row label="Status">
        {STATUSES.map((s) => (
          <Chip key={s} on={filter.status === s} onClick={() => set("status", s)}>
            {s === "pending-signers" ? "pending signers" : s}
          </Chip>
        ))}
      </Row>
      <Row label="Severity">
        {SEVERITIES.map((s) => (
          <Chip key={s} on={filter.severity === s} onClick={() => set("severity", s)}>
            {s}
          </Chip>
        ))}
      </Row>
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-[family-name:var(--font-mono)] text-xs text-[var(--avy-muted)]"
        >
          ⌕
        </span>
        <input
          ref={inputRef}
          type="text"
          value={filter.q}
          onChange={(e) => set("q", e.target.value)}
          placeholder="Filter by tag, scope, signer, revision…"
          className="h-9 w-full rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] pl-8 pr-10 font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-ink)] placeholder:text-[var(--avy-muted)] focus:border-[color:rgba(30,102,66,0.3)] focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[color:rgba(30,102,66,0.26)]"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-[5px] border border-[var(--avy-line)] bg-[color:rgba(17,19,21,0.06)] px-1.5 py-px font-[family-name:var(--font-mono)] text-[11px] leading-none text-[var(--avy-muted)]"
        >
          /
        </span>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="min-w-[3.2rem] font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        {label}
      </span>
      <div className="inline-flex flex-wrap gap-0.5 rounded-[8px] bg-[color:rgba(17,19,21,0.04)] p-[3px]">
        {children}
      </div>
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-[6px] border-0 bg-transparent px-2.5 py-1 font-[family-name:var(--font-display)] text-[11px] font-bold uppercase transition-colors",
        on
          ? "bg-[var(--avy-paper-solid)] text-[var(--avy-accent)] shadow-[0_1px_0_rgba(17,19,21,0.04),0_1px_4px_rgba(17,19,21,0.08)]"
          : "text-[var(--avy-muted)] hover:text-[var(--avy-ink)]"
      )}
      style={{ letterSpacing: "0.06em" }}
    >
      {children}
    </button>
  );
}
