import { cn } from "@/lib/utils/cn";

export type WorkerVariant = "self" | "a" | "b" | "c" | "d" | "unclaimed";

const AVATAR_BG: Record<WorkerVariant, string> = {
  self: "bg-gradient-to-br from-[#1e6642] to-[#0f6b4f] text-white",
  a: "bg-[#254e9a] text-white",
  b: "bg-[#a76122] text-white",
  c: "bg-[#5f655f] text-white",
  d: "bg-[#101419] text-white",
  unclaimed: "bg-[#d4d0c2] text-[#5f655f]",
};

export interface WorkerChipProps {
  variant: WorkerVariant;
  initials: string;
  label: string;
  isSelf?: boolean;
}

export function WorkerChip({ variant, initials, label, isSelf }: WorkerChipProps) {
  return (
    <span className="inline-flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-ink)]">
      <span
        className={cn(
          "grid h-[18px] w-[18px] place-items-center rounded-[5px] font-[family-name:var(--font-display)] text-[9px] font-extrabold uppercase",
          AVATAR_BG[variant]
        )}
        style={{ letterSpacing: "0.04em" }}
      >
        {initials}
      </span>
      {label}
      {isSelf ? (
        <span
          className="ml-1 font-[family-name:var(--font-display)] text-[9px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.1em" }}
        >
          you
        </span>
      ) : null}
    </span>
  );
}
