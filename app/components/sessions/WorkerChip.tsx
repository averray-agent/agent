import { cn } from "@/lib/utils/cn";

type WorkerTone = "sage" | "ink" | "clay" | "blue" | "muted";

const TONE: Record<WorkerTone, string> = {
  sage: "bg-gradient-to-br from-[#1e6642] to-[#0f6b4f] text-white",
  ink: "bg-[#101419] text-white",
  clay: "bg-[#a76122] text-white",
  blue: "bg-[var(--avy-blue)] text-white",
  muted: "bg-[#5f655f] text-white",
};

export function WorkerChip({
  tone,
  initials,
  handle,
  address,
}: {
  tone: WorkerTone;
  initials: string;
  handle: string;
  address: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "grid h-[20px] w-[20px] shrink-0 place-items-center rounded-[5px] font-[family-name:var(--font-display)] text-[9px] font-extrabold uppercase",
          TONE[tone]
        )}
        style={{ letterSpacing: "0.04em" }}
      >
        {initials}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-[family-name:var(--font-body)] text-[12.5px] font-semibold text-[var(--avy-ink)]">
          {handle}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          {address}
        </span>
      </span>
    </span>
  );
}
