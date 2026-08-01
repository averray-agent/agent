"use client";

import { useMemo } from "react";
import { PosterTopbar } from "@/components/poster/PosterTopbar";
import { PosterModeBanner } from "@/components/poster/PosterModeBanner";
import { PosterJobsTable } from "@/components/poster/PosterJobsTable";
import { DraftLookupPanel } from "@/components/poster/DraftLookupPanel";
import { NewBountyPanel } from "@/components/poster/NewBountyPanel";
import { ReviewQueue } from "@/components/poster/ReviewQueue";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";
import { useExternalJobs, usePosterOnboarding } from "@/lib/api/hooks";
import { buildPosterJobsView } from "@/lib/api/poster-adapters";
import { useAuth } from "@/lib/auth/use-auth";
import { shortAddress } from "@/lib/format";

/**
 * C1 of the poster-door clarity packet: the read-only poster lens.
 * Everything rendered here is the API's own truth — the external catalog
 * projection and the public poster-onboarding facts. No posting controls
 * exist yet by design (that's C2); the banner says so instead of hinting.
 */
export default function PosterPage() {
  const auth = useAuth();
  const jobsRequest = useExternalJobs();
  const onboardingRequest = usePosterOnboarding();

  const wallet = auth.wallet ?? null;
  const view = useMemo(
    () => buildPosterJobsView(jobsRequest.data, wallet),
    [jobsRequest.data, wallet]
  );
  const freshness = freshnessFromRequests(jobsRequest, onboardingRequest);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <PosterTopbar freshness={freshness} />

      <header className="flex flex-col gap-1.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Demand · external bounties
        </span>
        <h1 className="font-[family-name:var(--font-display)] text-[26px] font-extrabold text-[var(--avy-ink)]">
          Posting
        </h1>
        <p className="max-w-[640px] font-[family-name:var(--font-body)] text-[13.5px] leading-relaxed text-[var(--avy-muted)]">
          Jobs funded through the external poster door, seen the way the
          platform records them: the on-chain poster, the live claim-bond
          estimate, and the funding transaction.
        </p>
      </header>

      <PosterModeBanner
        onboarding={onboardingRequest.data}
        unavailable={Boolean(onboardingRequest.error) && !onboardingRequest.data}
      />

      <ReviewQueue rows={view.mine.filter((row) => row.state === "submitted")} />

      <section className="flex flex-col gap-2.5">
        <h2
          className="font-[family-name:var(--font-display)] text-[12px] font-extrabold uppercase text-[var(--avy-ink)]"
          style={{ letterSpacing: "0.1em" }}
        >
          New bounty
        </h2>
        <NewBountyPanel onboarding={onboardingRequest.data} wallet={wallet} />
      </section>

      <section className="flex flex-col gap-2.5">
        <h2
          className="font-[family-name:var(--font-display)] text-[12px] font-extrabold uppercase text-[var(--avy-ink)]"
          style={{ letterSpacing: "0.1em" }}
        >
          My posted jobs
          {wallet ? (
            <span className="ml-2 font-[family-name:var(--font-mono)] text-[11px] font-normal normal-case text-[var(--avy-muted)]" style={{ letterSpacing: 0 }}>
              poster {shortAddress(wallet)}
            </span>
          ) : null}
        </h2>
        <PosterJobsTable
          rows={view.mine}
          externalTotal={view.externalTotal}
          wallet={wallet}
          loading={jobsRequest.isLoading === true}
        />
      </section>

      <section className="flex flex-col gap-2.5">
        <h2
          className="font-[family-name:var(--font-display)] text-[12px] font-extrabold uppercase text-[var(--avy-ink)]"
          style={{ letterSpacing: "0.1em" }}
        >
          Draft lookup
        </h2>
        <DraftLookupPanel />
      </section>
    </div>
  );
}
