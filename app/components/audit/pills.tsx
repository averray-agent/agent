import { cn } from "@/lib/utils/cn";
import type { AuditSource, AuditCategory } from "./types";

const SOURCE: Record<AuditSource, { cls: string; label: string; dotCls: string }> = {
  operator: {
    cls: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
    label: "Operator",
    dotCls: "bg-[var(--avy-accent)]",
  },
  system: {
    cls: "bg-[#ebe7da] text-[#756d58]",
    label: "System",
    dotCls: "bg-[#756d58]",
  },
  contract: {
    cls: "bg-[#e6ecf7] text-[var(--avy-blue)]",
    label: "Contract",
    dotCls: "bg-[var(--avy-blue)]",
  },
};

export function SourcePill({
  source,
  className,
}: {
  source: AuditSource;
  className?: string;
}) {
  const s = SOURCE[source];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase whitespace-nowrap",
        s.cls,
        className
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dotCls)} />
      {s.label}
    </span>
  );
}

const CATEGORY_LABEL: Record<AuditCategory, string> = {
  policy: "policy",
  runs: "runs",
  treasury: "treasury",
  xcm: "xcm",
  badge: "badge",
  dispute: "dispute",
  auth: "auth",
  verifier: "verifier",
};

export function CategoryChip({
  category,
  className,
}: {
  category: AuditCategory;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[4px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-1.5 py-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]",
        className
      )}
      style={{ letterSpacing: 0 }}
    >
      {CATEGORY_LABEL[category]}
    </span>
  );
}
