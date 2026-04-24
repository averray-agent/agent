import { cn } from "@/lib/utils/cn";
import type { DisputeOrigin, DisputeState } from "./types";

const ORIGIN: Record<DisputeOrigin, { cls: string; label: string }> = {
  signature: {
    cls: "bg-[#f3d2c9] text-[#8c2a17]",
    label: "Signature",
  },
  schema: {
    cls: "bg-[#fff0d8] text-[var(--avy-warn)]",
    label: "Schema",
  },
  "co-sign-missing": {
    cls: "bg-[#e6ecf7] text-[var(--avy-blue)]",
    label: "Co-sign missing",
  },
  "policy-violation": {
    cls: "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
    label: "Policy violation",
  },
  timeout: {
    cls: "bg-[#ebe7da] text-[#756d58]",
    label: "Timeout",
  },
};

export function OriginPill({
  origin,
  className,
}: {
  origin: DisputeOrigin;
  className?: string;
}) {
  const o = ORIGIN[origin];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[6px] border border-transparent px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase whitespace-nowrap",
        o.cls,
        className
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {o.label}
    </span>
  );
}

const STATE: Record<
  DisputeState,
  { cls: string; label: string; pulse?: boolean; dot?: boolean }
> = {
  open: {
    cls: "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
    label: "Open",
    pulse: true,
    dot: true,
  },
  "awaiting-evidence": {
    cls: "bg-[#fff0d8] text-[var(--avy-warn)]",
    label: "Awaiting evidence",
    dot: true,
  },
  "under-review": {
    cls: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
    label: "Under review",
    dot: true,
  },
  escalated: {
    cls: "bg-[#f3d2c9] text-[#8c2a17]",
    label: "Escalated",
    dot: true,
  },
  resolved: {
    cls: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]",
    label: "Resolved",
  },
};

export function DisputeStatePill({
  state,
  className,
}: {
  state: DisputeState;
  className?: string;
}) {
  const s = STATE[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase whitespace-nowrap",
        s.cls,
        className
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {s.dot ? (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full bg-current opacity-80",
            s.pulse && "[animation:pulse_1.6s_ease-in-out_infinite]"
          )}
        />
      ) : null}
      {s.label}
    </span>
  );
}
