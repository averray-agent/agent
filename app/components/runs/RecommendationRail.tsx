import { JobCard, type JobCardData } from "./JobCard";

export interface RecommendationRailProps {
  workerTier: string;
  workerScore: number;
  jobs: JobCardData[];
  totalMatches: number;
}

export function RecommendationRail({
  workerTier,
  workerScore,
  jobs,
  totalMatches,
}: RecommendationRailProps) {
  return (
    <aside className="flex flex-col overflow-hidden rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)]">
      <header className="border-b border-[var(--avy-line-soft)] px-3.5 py-3 pb-2.5">
        <h3 className="m-0 font-[family-name:var(--font-display)] text-[14px] font-bold">
          For you · ready to claim
        </h3>
        <p
          className="mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
          style={{ letterSpacing: 0 }}
        >
          Ranked by tier fit · your reputation{" "}
          <b className="font-semibold text-[var(--avy-ink)]">
            {workerTier} · {workerScore}
          </b>
        </p>
      </header>

      <div className="flex flex-col gap-2 p-2.5">
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
      </div>

      <footer
        className="flex items-center justify-between border-t border-[var(--avy-line-soft)] bg-[#faf8f1] px-3.5 py-2.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        <span>
          {jobs.length} of {totalMatches} matches
        </span>
        <a className="cursor-pointer text-[var(--avy-accent)]">See all ready →</a>
      </footer>
    </aside>
  );
}
