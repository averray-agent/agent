import { cn } from "@/lib/utils/cn";

export type ReceiptKind = "run" | "settle" | "policy" | "badge";

const KIND_CLASSES: Record<ReceiptKind, string> = {
  run: "bg-[color:rgba(30,102,66,0.08)] text-[var(--avy-accent)] border-[color:rgba(30,102,66,0.18)]",
  settle:
    "bg-[color:rgba(37,78,154,0.08)] text-[var(--avy-blue)] border-[color:rgba(37,78,154,0.18)]",
  policy:
    "bg-[color:rgba(167,97,34,0.08)] text-[var(--avy-warn)] border-[color:rgba(167,97,34,0.18)]",
  badge: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-ink)] border-[color:rgba(17,19,21,0.12)]",
};

const KIND_LABEL: Record<ReceiptKind, string> = {
  run: "Run",
  settle: "Settle",
  policy: "Policy",
  badge: "Badge",
};

export function KindChip({
  kind,
  className,
}: {
  kind: ReceiptKind;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[6px] border px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
        KIND_CLASSES[kind],
        className
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}
