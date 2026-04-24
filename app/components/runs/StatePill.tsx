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
 * Small "where did this job come from" badge. GitHub-ingested jobs get the
 * GitHub mark + label; the OSS variant is a neutral fallback if we widen
 * ingestion to non-GitHub OSS trackers later.
 */
export type SourceKind = "github" | "oss";

const SOURCE_CLASSES: Record<SourceKind, string> = {
  github: "bg-[#111418] text-white",
  oss: "bg-[color:rgba(17,19,21,0.06)] text-[var(--avy-ink)]",
};

const SOURCE_LABEL: Record<SourceKind, string> = {
  github: "GitHub",
  oss: "OSS",
};

export function SourceBadge({
  kind,
  className,
}: {
  kind: SourceKind;
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
      {kind === "github" ? <GitHubGlyph /> : <span className="h-[5px] w-[5px] rounded-full bg-current opacity-80" />}
      {SOURCE_LABEL[kind]}
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
