"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils/cn";
import type { AgentTier, AgentState, AgentSpecialty } from "./types";

export interface AgentsFilterState {
  tier: AgentTier | "all";
  status: AgentState | "all";
  specialty: AgentSpecialty | "all";
  query: string;
}

export interface AgentsFilterRailProps {
  filter: AgentsFilterState;
  onChange: (next: AgentsFilterState) => void;
}

export function AgentsFilterRail({ filter, onChange }: AgentsFilterRailProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const set = <K extends keyof AgentsFilterState>(k: K, v: AgentsFilterState[K]) =>
    onChange({ ...filter, [k]: v });

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-3 backdrop-blur-[8px]">
      <Group label="Tier">
        <Chip on={filter.tier === "all"} onClick={() => set("tier", "all")}>
          All
        </Chip>
        <Chip on={filter.tier === "T1"} onClick={() => set("tier", "T1")}>
          T1
        </Chip>
        <Chip on={filter.tier === "T2"} onClick={() => set("tier", "T2")}>
          T2
        </Chip>
        <Chip on={filter.tier === "T3"} onClick={() => set("tier", "T3")}>
          T3
        </Chip>
      </Group>

      <GroupDivider />

      <Group label="Status">
        <Chip on={filter.status === "all"} onClick={() => set("status", "all")}>
          All
        </Chip>
        <Chip on={filter.status === "active"} onClick={() => set("status", "active")}>
          Active
        </Chip>
        <Chip on={filter.status === "idle"} onClick={() => set("status", "idle")}>
          Idle
        </Chip>
        <Chip on={filter.status === "slashed"} onClick={() => set("status", "slashed")}>
          Slashed
        </Chip>
      </Group>

      <GroupDivider />

      <Group label="Specialty">
        <Chip on={filter.specialty === "all"} onClick={() => set("specialty", "all")}>
          All
        </Chip>
        <Chip on={filter.specialty === "coding"} onClick={() => set("specialty", "coding")}>
          Coding
        </Chip>
        <Chip
          on={filter.specialty === "writer-gov"}
          onClick={() => set("specialty", "writer-gov")}
        >
          Writer-gov
        </Chip>
        <Chip on={filter.specialty === "ops"} onClick={() => set("specialty", "ops")}>
          Ops
        </Chip>
        <Chip
          on={filter.specialty === "gov-review"}
          onClick={() => set("specialty", "gov-review")}
        >
          Gov-review
        </Chip>
      </Group>

      <div className="relative ml-auto min-w-[280px] max-w-[360px] flex-1">
        <input
          ref={inputRef}
          type="text"
          value={filter.query}
          onChange={(e) => set("query", e.target.value)}
          placeholder="Filter by wallet, handle, badge, policy…"
          className="h-8 w-full rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] pl-3 pr-10 font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-ink)] placeholder:text-[var(--avy-muted)] focus:border-[color:rgba(30,102,66,0.45)] focus:outline-none focus:ring-[3px] focus:ring-[color:rgba(30,102,66,0.10)]"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-[4px] border border-[var(--avy-line)] bg-white/60 px-1.5 py-px font-[family-name:var(--font-mono)] text-[11px] leading-none text-[var(--avy-muted)]"
        >
          /
        </span>
      </div>
    </div>
  );
}

function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="mr-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.12em" }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function GroupDivider() {
  return <span className="h-5 w-px bg-[var(--avy-line-soft)]" aria-hidden="true" />;
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
        "rounded-full border px-2.5 py-1 font-[family-name:var(--font-display)] text-[11px] font-bold transition-colors",
        on
          ? "border-[var(--avy-accent)] bg-[var(--avy-accent)] text-[var(--fg-invert)]"
          : "border-[var(--avy-line)] bg-transparent text-[var(--avy-muted)] hover:border-[color:rgba(17,19,21,0.22)] hover:text-[var(--avy-ink)]"
      )}
      style={{ letterSpacing: "0.02em" }}
    >
      {children}
    </button>
  );
}
