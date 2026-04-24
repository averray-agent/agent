import { cn } from "@/lib/utils/cn";
import { BADGES, specialtyColor, type BadgeSpecialtyColor } from "./types";

const TONES: Record<BadgeSpecialtyColor, string> = {
  code: "bg-[#d6eadf] text-[#1e6642] border-[color:rgba(30,102,66,0.25)]",
  write: "bg-[#e6e2f0] text-[#4a3f7a] border-[color:rgba(74,63,122,0.22)]",
  ops: "bg-[#f1d8b8] text-[#7a4a18] border-[color:rgba(167,97,34,0.30)]",
  gov: "bg-[#d8e6f0] text-[#2a4a6a] border-[color:rgba(42,74,106,0.25)]",
};

export interface BadgeChipProps {
  badgeId: string;
  size?: "sm" | "md";
}

export function BadgeChip({ badgeId, size = "sm" }: BadgeChipProps) {
  const def = BADGES[badgeId];
  if (!def) return null;
  const tone = specialtyColor(def.specialty);
  return (
    <span
      className={cn(
        "grid place-items-center rounded-[6px] border font-[family-name:var(--font-display)] font-extrabold",
        size === "sm" ? "h-[22px] w-[22px] text-[10px]" : "h-7 w-7 text-[11px]",
        TONES[tone]
      )}
      style={{ letterSpacing: "0.04em" }}
      title={def.name}
    >
      {def.glyph}
    </span>
  );
}

export function BadgeStrip({
  badges,
  max = 3,
}: {
  badges: string[];
  max?: number;
}) {
  const shown = badges.slice(0, max);
  const extra = badges.length - shown.length;
  const title = badges
    .map((b) => BADGES[b]?.name)
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex items-center gap-[3px]" title={title}>
      {shown.map((b) => (
        <BadgeChip key={b} badgeId={b} />
      ))}
      {extra > 0 ? (
        <span
          className="ml-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
}
