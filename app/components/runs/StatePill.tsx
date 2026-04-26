import { cn } from "@/lib/utils/cn";

export type RunState = "ready" | "claimed" | "submitted" | "disputed" | "settled";
export type Tier = "T1" | "T2" | "T3";

const STATE_CLASSES: Record<RunState, string> = {
  ready: "bg-[#e6ecf7] text-[#254e9a]",
  claimed: "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
  submitted: "bg-[#fff0d8] text-[#a76122]",
  disputed: "bg-[#f4ddd5] text-[#a03a1a]",
  settled: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-ink)]",
};

const TIER_CLASSES: Record<Tier, string> = {
  T1: "bg-[#e9f2e0] text-[#425d1a]",
  T2: "bg-[#e8efea] text-[#326244]",
  T3: "bg-[#e6ecf7] text-[#254e9a]",
};

const STATE_LABEL: Record<RunState, string> = {
  ready: "Ready",
  claimed: "Claimed",
  submitted: "Submitted",
  disputed: "Disputed",
  settled: "Settled",
};

const PILL_BASE =
  "inline-flex items-center gap-1.5 min-h-[22px] px-2.5 py-0.5 rounded-full font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase whitespace-nowrap";

export function StatePill({
  state,
  className,
}: {
  state: RunState;
  className?: string;
}) {
  return (
    <span
      className={cn(PILL_BASE, STATE_CLASSES[state], className)}
      style={{ letterSpacing: "0.1em" }}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current opacity-80" />
      {STATE_LABEL[state]}
    </span>
  );
}

export function TierPill({ tier, className }: { tier: Tier; className?: string }) {
  return (
    <span
      className={cn(PILL_BASE, TIER_CLASSES[tier], className)}
      style={{ letterSpacing: "0.1em" }}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current opacity-80" />
      Tier {tier.slice(1)}
    </span>
  );
}

export function VerifierModePill({
  label,
  tone = "claimed",
  className,
}: {
  label: string;
  tone?: RunState;
  className?: string;
}) {
  return (
    <span
      className={cn(PILL_BASE, STATE_CLASSES[tone], className)}
      style={{ letterSpacing: "0.1em" }}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current opacity-80" />
      {label}
    </span>
  );
}

/**
 * Small "where did this job come from" badge. Each ingested-source kind
 * gets its own dark mark so an operator can tell a GitHub run from a
 * Wikipedia maintenance run at a glance, without leaving the run queue.
 *
 * Stays inside the existing token palette — every variant uses one of
 * the established neutral fills the rest of the app already uses for
 * inverted chips.
 */
export type SourceKind = "github" | "wikipedia" | "osv" | "oss";

const SOURCE_CLASSES: Record<SourceKind, string> = {
  github: "bg-[#111418] text-white",
  wikipedia: "bg-[var(--avy-ink)] text-white",
  osv: "bg-[#3a1f1f] text-white",
  oss: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-ink)]",
};

const SOURCE_LABEL: Record<SourceKind, string> = {
  github: "GitHub",
  wikipedia: "Wikipedia",
  osv: "OSV",
  oss: "OSS",
};

export function SourceBadge({
  kind,
  /**
   * Optional secondary tag rendered as a tight separator pill inside the
   * badge — e.g. SourceBadge kind="osv" secondary="NVD" produces
   * `OSV · NVD`. Used to surface CVE/NVD cross-references on OSV
   * advisories without spinning up a second badge component.
   */
  secondary,
  className,
}: {
  kind: SourceKind;
  secondary?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase whitespace-nowrap",
        SOURCE_CLASSES[kind],
        className
      )}
      style={{ letterSpacing: "0.1em" }}
    >
      {kind === "github" ? (
        <GitHubGlyph />
      ) : kind === "wikipedia" ? (
        <WikipediaGlyph />
      ) : kind === "osv" ? (
        <OsvGlyph />
      ) : (
        <span className="h-[5px] w-[5px] rounded-full bg-current opacity-80" />
      )}
      {SOURCE_LABEL[kind]}
      {secondary ? (
        <>
          <span className="opacity-50">·</span>
          <span>{secondary}</span>
        </>
      ) : null}
    </span>
  );
}

function GitHubGlyph() {
  // Inline SVG so we don't pull in another icon bundle just for one mark.
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function OsvGlyph() {
  // Stylised shield to mark advisory provenance — pairs with the OSV
  // label in the same way GitHub/Wikipedia glyphs pair with theirs.
  // Avoids the OSV.dev logomark to keep the badge readable at 10px and
  // sidestep brand-mark constraints.
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
    >
      <path
        d="M8 1.5 13.25 3v4.5c0 3.4-2.4 6.2-5.25 7-2.85-.8-5.25-3.6-5.25-7V3L8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="m5.6 8.2 1.7 1.7 3.1-3.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WikipediaGlyph() {
  // Stylised "W" in a circle. Avoids using Wikipedia's own brand mark
  // (which has trademark constraints) and keeps the badge readable at
  // 10px alongside the GitHub octocat.
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="10"
      height="10"
      fill="none"
    >
      <circle cx="8" cy="8" r="7.25" stroke="currentColor" strokeWidth="1.5" />
      <text
        x="8"
        y="11.4"
        textAnchor="middle"
        fontFamily="serif"
        fontSize="9"
        fontWeight="700"
        fill="currentColor"
      >
        W
      </text>
    </svg>
  );
}
