import { JobCard, type JobCardData } from "./JobCard";
import { cn } from "@/lib/utils/cn";

export interface RecommendationRailProps {
  workerTier: string;
  workerScore: number;
  jobs: JobCardData[];
  totalMatches: number;
  /**
   * `"vertical"` stacks cards in a narrow sidebar (original shape, used when
   * there's real estate to the right of the queue). `"horizontal"` lays the
   * cards out in a flex-wrap grid — used when the rail sits below a
   * split-pane queue+detail area so it doesn't fight for vertical space.
   * Reflows to multiple rows at narrow widths instead of scrolling
   * horizontally so trailing cards don't get silently clipped.
   */
  layout?: "vertical" | "horizontal";
}

export function RecommendationRail({
  workerTier,
  workerScore,
  jobs,
  totalMatches,
  layout = "vertical",
}: RecommendationRailProps) {
  const isHorizontal = layout === "horizontal";
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

      {isHorizontal ? (
        // Flex-wrap grid: cards keep a ~300px target width and reflow into
        // additional rows at narrow viewports instead of overflowing the
        // container. Avoids the previous behaviour where the rail's
        // horizontal scroll silently clipped the last card on operator
        // monitors that don't render a visible scrollbar.
        <div className="flex flex-wrap gap-2 p-2.5">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="min-w-[260px] grow basis-[280px]"
            >
              <JobCard job={job} />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-2.5">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}

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
