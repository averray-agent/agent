import { cn } from "@/lib/utils/cn";
import type { PolicySeverity, PolicyState, PolicyScope } from "./types";

const SEVERITY: Record<PolicySeverity, { cls: string; label: string }> = {
  advisory: { cls: "bg-[#ebe7da] text-[#756d58]", label: "Advisory" },
  gating: { cls: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]", label: "Gating" },
  "hard-stop": { cls: "bg-[#f3d2c9] text-[#8c2a17]", label: "Hard-stop" },
};

export function SeverityPill({
  severity,
  className,
}: {
  severity: PolicySeverity;
  className?: string;
}) {
  const s = SEVERITY[severity];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase whitespace-nowrap",
        s.cls,
        className
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {s.label}
    </span>
  );
}

const STATE: Record<
  PolicyState,
  { cls: string; dot: boolean; label: string; pulse?: boolean }
> = {
  Active: { cls: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]", dot: true, label: "Active" },
  Pending: { cls: "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]", dot: true, label: "Pending", pulse: true },
  Draft: { cls: "bg-[#ebe7da] text-[#756d58]", dot: false, label: "Draft" },
  Retired: { cls: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-muted)]", dot: false, label: "Retired" },
};

export function StatePill({ state, className }: { state: PolicyState; className?: string }) {
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

const SCOPE_LABEL: Record<PolicyScope, string> = {
  claim: "Claim",
  settle: "Settle",
  xcm: "XCM",
  badge: "Badge",
  "co-sign": "Co-sign",
  worker: "Worker",
  treasury: "Treasury",
};

export function ScopePill({
  scope,
  label,
  className,
}: {
  scope?: PolicyScope;
  label?: string;
  className?: string;
}) {
  const text = label ?? (scope ? SCOPE_LABEL[scope] : "");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[4px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] font-medium text-[var(--avy-ink)]",
        className
      )}
      style={{ letterSpacing: 0 }}
    >
      {text}
    </span>
  );
}
