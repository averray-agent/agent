import { SectionHead } from "./SectionHead";
import { cn } from "@/lib/utils/cn";
import {
  type ProviderOperation,
  type ProviderHealth,
  type ProviderMode,
  PROVIDER_HEALTH_LABEL,
  PROVIDER_MODE_LABEL,
  PROVIDER_TARGET_UNIT,
  summarizeSkipReasons,
} from "@/lib/api/provider-operations";

export interface ProviderOperationsCardProps {
  providers: ProviderOperation[];
  meta?: string;
}

export function ProviderOperationsCard({
  providers,
  meta,
}: ProviderOperationsCardProps) {
  return (
    <section>
      <SectionHead
        title="Provider operations"
        meta={meta ?? `${providers.length} sources`}
      />
      <div className="overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] shadow-[var(--shadow-card)]">
        {providers.length === 0 ? (
          <EmptyRow />
        ) : (
          providers.map((provider) => (
            <ProviderRow key={provider.key} provider={provider} />
          ))
        )}
      </div>
    </section>
  );
}

function ProviderRow({ provider }: { provider: ProviderOperation }) {
  const openJobs = provider.currentOpenJobs;
  const cap = provider.maxOpenJobs;
  const fillPct = cap > 0 ? Math.min(100, Math.round((openJobs / cap) * 100)) : 0;
  const lastRun = provider.lastRun;
  const errored = lastRun ? lastRun.errorCount > 0 : false;
  const targetUnit = PROVIDER_TARGET_UNIT[provider.key];

  return (
    <div className="grid grid-cols-1 gap-3 border-b border-[var(--avy-line-soft)] p-[0.95rem_1.15rem] last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.6fr)]">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-[family-name:var(--font-display)] text-[14px] font-bold text-[var(--avy-ink)]">
            {provider.label}
          </span>
          <HealthPill tone={provider.health} />
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        >
          <ModeBadge mode={provider.mode} />
          <span>·</span>
          <span>
            <span className="text-[var(--avy-ink)]">{provider.targetCount}</span>{" "}
            {targetUnit}
          </span>
          {provider.queryCount !== undefined ? (
            <>
              <span>·</span>
              <span>
                <span className="text-[var(--avy-ink)]">{provider.queryCount}</span>{" "}
                queries
              </span>
            </>
          ) : null}
          {provider.nextQuery ? (
            <>
              <span>·</span>
              <span>
                next <span className="text-[var(--avy-ink)]">&ldquo;{provider.nextQuery}&rdquo;</span>
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]">
          <span className="text-[var(--avy-muted)]">open jobs</span>
          <span>
            {openJobs}
            <span className="text-[var(--avy-muted)]"> / {cap}</span>
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-[color:rgba(17,19,21,0.06)]">
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              fillPct >= 100
                ? "bg-[var(--avy-warn)]"
                : "bg-[var(--avy-accent)]"
            )}
            style={{ width: `${fillPct}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1 font-[family-name:var(--font-body)] text-[12.5px] leading-[1.45] text-[var(--avy-ink)]">
        {lastRun && lastRun.summary ? (
          <span>{lastRun.summary}</span>
        ) : (
          <span className="text-[var(--avy-muted)]">No runs recorded yet.</span>
        )}
        {lastRun && lastRun.skipped.length > 0 ? (
          <span className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
            skipped:{" "}
            {summarizeSkipReasons(lastRun.skipped)
              .map((entry) => `${entry.count} ${entry.label}`)
              .join(" · ")}
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
          <span>{provider.lastRunAt ? `last run ${formatRelative(provider.lastRunAt)}` : "never"}</span>
          {errored ? (
            <span className="rounded-full bg-[var(--avy-warn-soft)] px-1.5 py-px font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-warn)]" style={{ letterSpacing: "0.08em" }}>
              {lastRun!.errorCount} error{lastRun!.errorCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {provider.running ? (
            <span className="inline-flex items-center gap-1 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-accent)]" style={{ letterSpacing: "0.08em" }}>
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] [animation:pulse_2.2s_ease-in-out_infinite]" />
              Running
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function HealthPill({ tone }: { tone: ProviderHealth }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
        tone === "healthy" && "bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
        tone === "dry_run" && "bg-[var(--avy-blue-soft,#dde8f1)] text-[var(--avy-blue,#3a6f9a)]",
        tone === "at_capacity" && "bg-[var(--avy-warn-soft)] text-[var(--avy-warn)]",
        tone === "error" && "bg-[#f3d7d4] text-[#a0322a]",
        tone === "disabled" && "bg-[#ebe7da] text-[#756d58]"
      )}
      style={{ letterSpacing: "0.1em" }}
    >
      <span className="h-[5px] w-[5px] rounded-full bg-current" />
      {PROVIDER_HEALTH_LABEL[tone]}
    </span>
  );
}

function ModeBadge({ mode }: { mode: ProviderMode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[4px] px-1.5 py-px font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
        mode === "live" && "bg-[var(--avy-accent-wash)] text-[var(--avy-accent)]",
        mode === "dry_run" && "bg-[color:rgba(17,19,21,0.04)] text-[var(--avy-ink)]",
        mode === "disabled" && "bg-[color:rgba(17,19,21,0.04)] text-[var(--avy-muted)]"
      )}
      style={{ letterSpacing: "0.08em" }}
    >
      {PROVIDER_MODE_LABEL[mode]}
    </span>
  );
}

function EmptyRow() {
  return (
    <div className="p-[1.05rem_1.15rem] font-[family-name:var(--font-body)] text-[13px] text-[var(--avy-muted)]">
      Provider operations status is unavailable right now.
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.round(deltaHr / 24);
  return `${deltaDay}d ago`;
}

export const PROVIDER_OPERATIONS_FIXTURE: ProviderOperation[] = [
  {
    key: "github",
    label: "GitHub issues",
    mode: "live",
    health: "healthy",
    enabled: true,
    running: false,
    intervalMs: 5 * 60_000,
    maxJobsPerRun: 8,
    maxOpenJobs: 24,
    currentOpenJobs: 11,
    targetCount: 14,
    lastRunAt: new Date(Date.now() - 90_000).toISOString(),
    lastRun: {
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      finishedAt: new Date(Date.now() - 90_000).toISOString(),
      dryRun: false,
      candidateCount: 26,
      createdCount: 4,
      skippedCount: 22,
      errorCount: 0,
      summary: "26 candidates, 4 created, 22 skipped, 0 errors",
      skipped: [
        { reason: "source_already_ingested" },
        { reason: "source_already_ingested" },
        { reason: "source_already_ingested" },
      ],
    },
  },
  {
    key: "wikipedia",
    label: "Wikipedia maintenance",
    mode: "live",
    health: "healthy",
    enabled: true,
    running: true,
    intervalMs: 10 * 60_000,
    maxJobsPerRun: 6,
    maxOpenJobs: 18,
    currentOpenJobs: 4,
    targetCount: 9,
    lastRunAt: new Date(Date.now() - 240_000).toISOString(),
    lastRun: {
      startedAt: new Date(Date.now() - 280_000).toISOString(),
      finishedAt: new Date(Date.now() - 240_000).toISOString(),
      dryRun: false,
      candidateCount: 18,
      createdCount: 2,
      skippedCount: 16,
      errorCount: 0,
      summary: "18 candidates, 2 created, 16 skipped, 0 errors",
      skipped: [],
    },
  },
  {
    key: "osv",
    label: "OSV advisories",
    mode: "live",
    health: "at_capacity",
    enabled: true,
    running: false,
    intervalMs: 15 * 60_000,
    maxJobsPerRun: 4,
    maxOpenJobs: 12,
    currentOpenJobs: 12,
    targetCount: 31,
    lastRunAt: new Date(Date.now() - 600_000).toISOString(),
    lastRun: {
      startedAt: new Date(Date.now() - 660_000).toISOString(),
      finishedAt: new Date(Date.now() - 600_000).toISOString(),
      dryRun: false,
      candidateCount: 9,
      createdCount: 0,
      skippedCount: 9,
      errorCount: 0,
      summary: "9 candidates, 0 created, 9 skipped (cap reached), 0 errors",
      skipped: [],
    },
  },
  {
    key: "openData",
    label: "Open data",
    mode: "dry_run",
    health: "dry_run",
    enabled: true,
    running: false,
    intervalMs: 30 * 60_000,
    maxJobsPerRun: 3,
    maxOpenJobs: 10,
    currentOpenJobs: 2,
    targetCount: 7,
    queryCount: 12,
    nextQuery: "transport",
    lastRunAt: new Date(Date.now() - 1_500_000).toISOString(),
    lastRun: {
      startedAt: new Date(Date.now() - 1_540_000).toISOString(),
      finishedAt: new Date(Date.now() - 1_500_000).toISOString(),
      dryRun: true,
      candidateCount: 12,
      createdCount: 0,
      skippedCount: 12,
      errorCount: 0,
      summary: "12 candidates, 0 created (dry run), 12 skipped, 0 errors",
      skipped: [
        { reason: "dataset_already_ingested" },
        { reason: "dataset_already_ingested" },
        { reason: "source_already_ingested" },
      ],
    },
  },
  {
    key: "standards",
    label: "Standards freshness",
    mode: "live",
    health: "error",
    enabled: true,
    running: false,
    intervalMs: 60 * 60_000,
    maxJobsPerRun: 2,
    maxOpenJobs: 8,
    currentOpenJobs: 1,
    targetCount: 5,
    lastRunAt: new Date(Date.now() - 1_800_000).toISOString(),
    lastRun: {
      startedAt: new Date(Date.now() - 1_840_000).toISOString(),
      finishedAt: new Date(Date.now() - 1_800_000).toISOString(),
      dryRun: false,
      candidateCount: 5,
      createdCount: 0,
      skippedCount: 3,
      errorCount: 2,
      summary: "5 candidates, 0 created, 3 skipped, 2 errors",
      skipped: [],
    },
  },
  {
    key: "openApi",
    label: "OpenAPI quality",
    mode: "disabled",
    health: "disabled",
    enabled: false,
    running: false,
    intervalMs: 60 * 60_000,
    maxJobsPerRun: 2,
    maxOpenJobs: 6,
    currentOpenJobs: 0,
    targetCount: 4,
  },
];
