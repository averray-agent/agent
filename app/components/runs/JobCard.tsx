import { cn } from "@/lib/utils/cn";
import {
  TierPill,
  VerifierModePill,
  SourceBadge,
  type Tier,
  type RunState,
} from "./StatePill";
import type { JobSource } from "./types";
import {
  CLAIM_STATE_LABEL,
  formatClaimReason,
  type ClaimSummary,
} from "@/lib/api/claim-status";

export interface JobCardData {
  id: string;
  title: string;
  jobMeta: string;
  /**
   * Short category label (e.g. "docs", "coding", "testing"). For GitHub
   * jobs this comes from the ingestion classifier; for native jobs it's
   * the job's domain tag.
   */
  category?: string;
  source?: JobSource;
  rewardValue: string;
  rewardCurrency: string;
  rewardUsd: string;
  tier: Tier;
  modeLabel: string;
  modeTone?: RunState;
  meta: { label: string; value: string; accent?: boolean }[];
  fit: number; // 0..5
  hot?: boolean;
  /**
   * Claim contract surfaced from the job feed. Drives the Claim button
   * (disabled unless `claimable === true`) and replaces the legacy
   * "always claimable" assumption that used to live on this card.
   */
  claim?: ClaimSummary;
}

export function JobCard({ job }: { job: JobCardData }) {
  return (
    <article
      className={cn(
        "grid gap-2 rounded-[8px] border border-[var(--avy-line)] bg-[#fffdf7] p-3 transition-all hover:-translate-y-px hover:border-[color:rgba(30,102,66,0.22)] hover:shadow-[0_4px_12px_rgba(30,37,44,0.06)]",
        job.hot &&
          "border-[color:rgba(30,102,66,0.35)] bg-gradient-to-b from-[rgba(214,234,223,0.5)] from-0% to-[#fffdf7] to-40%"
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h4
            className="m-0 line-clamp-2 font-[family-name:var(--font-display)] text-[13px] font-bold leading-[1.25] text-[var(--avy-ink)]"
            title={job.title}
          >
            {job.title}
          </h4>
          {job.source?.type === "github_issue" ? (
            <p
              className="mt-1 flex items-center gap-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              <span className="truncate text-[var(--avy-ink)]">
                {job.source.repo}
              </span>
              <span className="text-[var(--avy-accent)]">
                #{job.source.issueNumber}
              </span>
            </p>
          ) : job.source?.type === "wikipedia_article" ? (
            <p
              className="mt-1 flex items-center gap-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              <span className="shrink-0">{job.source.language}.wikipedia</span>
              <span className="truncate text-[var(--avy-ink)]">
                / &ldquo;{job.source.pageTitle}&rdquo;
              </span>
            </p>
          ) : job.source?.type === "osv_advisory" ? (
            <p
              className="mt-1 flex items-center gap-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              <span className="shrink-0">
                {job.source.ecosystem} / {job.source.packageName}
              </span>
              <span className="truncate text-[var(--avy-accent)]">
                · {job.source.advisoryId}
              </span>
            </p>
          ) : job.source?.type === "open_data_dataset" ? (
            <p
              className="mt-1 flex items-center gap-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              <span className="truncate text-[var(--avy-ink)]">
                {job.source.datasetTitle}
              </span>
              {job.source.agency ? (
                <>
                  <span className="shrink-0 opacity-40">·</span>
                  <span className="shrink-0 truncate">{job.source.agency}</span>
                </>
              ) : null}
            </p>
          ) : job.source?.type === "openapi_spec" ? (
            <p
              className="mt-1 flex items-center gap-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              <span className="shrink-0">{job.source.provider}</span>
              <span className="truncate text-[var(--avy-ink)]">
                / {job.source.apiTitle}
              </span>
            </p>
          ) : job.source?.type === "standards_spec" ? (
            <p
              className="mt-1 flex items-center gap-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              <span className="shrink-0">{job.source.provider.toUpperCase()}</span>
              <span className="truncate text-[var(--avy-ink)]">
                / {job.source.specTitle}
              </span>
            </p>
          ) : (
            <p
              className="mt-1 truncate font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {job.jobMeta}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div>
            <span className="font-[family-name:var(--font-display)] text-[15px] font-bold leading-none text-[var(--avy-ink)]">
              {job.rewardValue}
            </span>
            <span
              className="ml-0.5 font-[family-name:var(--font-mono)] text-[10px] font-medium text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {job.rewardCurrency}
            </span>
          </div>
          <p className="mt-1 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]">
            {job.rewardUsd}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1">
        {job.source?.type === "github_issue" ? (
          <SourceBadge kind="github" />
        ) : job.source?.type === "wikipedia_article" ? (
          <SourceBadge kind="wikipedia" />
        ) : job.source?.type === "osv_advisory" ? (
          <SourceBadge
            kind="osv"
            secondary={(job.source.cves?.length ?? 0) > 0 ? "NVD" : undefined}
          />
        ) : job.source?.type === "open_data_dataset" ? (
          <SourceBadge kind="data_gov" />
        ) : job.source?.type === "openapi_spec" ? (
          <SourceBadge kind="openapi" />
        ) : job.source?.type === "standards_spec" ? (
          <SourceBadge kind="standards" />
        ) : null}
        <TierPill tier={job.tier} />
        {job.category ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-[color:rgba(17,19,21,0.06)] px-2 py-0.5 font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-ink)]"
            style={{ letterSpacing: "0.1em" }}
          >
            {job.category}
          </span>
        ) : null}
        <VerifierModePill label={job.modeLabel} tone={job.modeTone ?? "claimed"} />
      </div>

      <dl
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1 border-t border-[var(--avy-line-soft)] pt-2 font-[family-name:var(--font-mono)] text-[10.5px]"
        style={{ letterSpacing: 0 }}
      >
        {job.meta.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-[var(--avy-muted)]">{row.label}</dt>
            <dd
              className={cn(
                "m-0 min-w-0 break-words font-medium",
                row.accent ? "text-[var(--avy-accent)]" : "text-[var(--avy-ink)]"
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {/*
       * When the row carries the new claim contract, surface
       * `effectiveState` + the human reason so an operator scanning
       * the rail can immediately tell why an "open" job isn't
       * actually grabbable. Hidden when the row predates the
       * contract, so older fixtures still render normally.
       */}
      {job.claim ? (
        <p
          className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
          title={`reason: ${job.claim.reason}`}
        >
          <b
            className={cn(
              "font-semibold",
              job.claim.claimable
                ? "text-[var(--avy-accent)]"
                : "text-[var(--avy-ink)]"
            )}
          >
            {CLAIM_STATE_LABEL[job.claim.state]}
          </b>
          {" · "}
          {formatClaimReason(job.claim.reason)}
          {job.claim.retryLimit > 0
            ? ` · ${job.claim.remainingClaimAttempts}/${job.claim.retryLimit} attempts left`
            : null}
        </p>
      ) : null}

      <div className="mt-0.5 flex items-center justify-between gap-2">
        <FitMeter fit={job.fit} />
        {/*
         * Brief: "Disable claim/start buttons unless claimable === true."
         * When the row doesn't carry a claim contract yet (older
         * fixtures), default to enabled — that's the legacy behaviour
         * and we don't want to silently disable everything during
         * rollout.
         */}
        <button
          type="button"
          disabled={job.claim ? !job.claim.claimable : false}
          title={
            job.claim && !job.claim.claimable
              ? formatClaimReason(job.claim.reason)
              : undefined
          }
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-[8px] px-2.5 font-[family-name:var(--font-display)] text-[10.5px] font-bold uppercase transition-transform",
            job.claim && !job.claim.claimable
              ? "cursor-not-allowed bg-[color:rgba(17,19,21,0.08)] text-[var(--avy-muted)]"
              : "bg-[var(--avy-accent)] text-[var(--fg-invert)] hover:-translate-y-px hover:bg-[var(--avy-accent-2)]"
          )}
          style={{ letterSpacing: "0.06em" }}
        >
          Claim
        </button>
      </div>
    </article>
  );
}

function FitMeter({ fit }: { fit: number }) {
  return (
    <div className="flex items-center gap-1.5 font-[family-name:var(--font-mono)] text-[10px] text-[var(--avy-accent)]">
      <span className="inline-flex gap-0.5">
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-2 w-[3px] rounded-[1px]",
              i < fit
                ? "bg-[var(--avy-accent)]"
                : "bg-[color:rgba(30,102,66,0.18)]"
            )}
          />
        ))}
      </span>
      <span>Fit {fit}/5</span>
    </div>
  );
}
