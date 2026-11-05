import { personhoodPill } from "@/lib/agents/personhood-line";

type PersonhoodRead = {
  available?: boolean;
  tier?: string | null;
  line?: { text?: string | null; pill?: string | null; tooltip?: string | null } | null;
} | null;

const PILL_CLASS: Record<"lite" | "full" | "suspended", string> = {
  lite: "bg-[#f3e6d4] text-[#8a5a1e]",
  full: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
  suspended: "bg-[#f3d9d9] text-[#8a2a2a]",
};

export function PersonhoodPill({ read }: { read: PersonhoodRead | null }) {
  const pill = personhoodPill(read);
  if (!pill) return null;
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase ${PILL_CLASS[pill.pill]}`}
      style={{ letterSpacing: "0.08em" }}
      title={pill.tooltip}
    >
      {pill.pill}
    </span>
  );
}
