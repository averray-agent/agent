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
   * cards out left-to-right and scrolls on overflow — used when the rail sits
   * below a split-pane queue+detail area so it doesn't fight for vertical
   * space.
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
        <div className="relative">
          <div
            className="flex gap-2 overflow-x-auto p-2.5 [-webkit-overflow-scrolling:touch]"
            // Tuck a little extra padding on the right so the last card
            // doesn't butt up against the fade overlay.
            style={{ paddingRight: "2.5rem" }}
          >
            {jobs.map((job) => (
              <div key={job.id} className="w-[300px] shrink-0">
                <JobCard job={job} />
              </div>
            ))}
          </div>
          {/* Right-edge fade: tells the user there's more content past the
              visible edge without relying on a visible scrollbar. Pointer-
              events-none so it doesn't block clicks on the card underneath. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--avy-paper-solid)] to-transparent"
          />
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
