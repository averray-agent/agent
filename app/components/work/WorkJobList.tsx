"use client";

import { ArrowRight, Clock3, Fuel, ShieldCheck, WalletCards } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useHumanWorkJobs } from "@/lib/api/hooks";
import { formatAmount } from "@/lib/format";
import { filterHumanWorkListings, workJobHref } from "@/lib/work/human-work.js";
import type { HumanJobListing } from "./types";

export function WorkJobList() {
  const jobsQuery = useHumanWorkJobs();
  const jobs = filterHumanWorkListings(jobsQuery.data) as HumanJobListing[];

  if (jobsQuery.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2" aria-label="Loading open work">
        {[0, 1, 2, 3].map((item) => (
          <Card key={item}>
            <CardContent className="space-y-4 py-6">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-4/5" />
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (jobsQuery.error) {
    return (
      <Card className="border-[color:rgba(167,97,34,0.34)]">
        <CardContent className="py-8">
          <p className="eyebrow text-[var(--warn)]">Live catalogue unavailable</p>
          <h2 className="mt-2 text-xl font-semibold">Open work could not be loaded.</h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
            Nothing is being shown as available while the live board is unreadable. Retry the request when the connection returns.
          </p>
          <button className="mt-5 text-sm font-semibold text-[var(--accent)] underline underline-offset-4" onClick={() => void jobsQuery.mutate()}>
            Retry live catalogue
          </button>
        </CardContent>
      </Card>
    );
  }

  if (jobs.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="eyebrow">No open starter work</p>
          <h2 className="mt-2 text-xl font-semibold">Nothing claimable is listed right now.</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">No open starter work right now — lanes refill on a schedule.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {jobs.map((job) => <WorkJobCard key={job.id} job={job} />)}
    </div>
  );
}

function WorkJobCard({ job }: { job: HumanJobListing }) {
  const reward = formatAmount(job.reward?.amount ?? undefined, job.reward?.asset ?? "");
  return (
    <Card className="group flex h-full flex-col transition-transform hover:-translate-y-0.5 hover:border-[var(--line-strong)]">
      <CardContent className="flex h-full flex-col gap-5 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="success">Open</Badge>
              {job.tier ? <Badge tone="muted">{job.tier}</Badge> : null}
            </div>
            <h2 className="mt-3 text-xl font-semibold leading-snug">{job.title || job.id}</h2>
          </div>
          <strong className="shrink-0 font-[family-name:var(--font-display)] text-lg text-[var(--accent)]">{reward}</strong>
        </div>
        <p className="text-sm leading-relaxed text-[var(--muted)]">
          {job.successCriteria || job.summary || "Open the task to read the exact success criteria."}
        </p>
        <div className="mt-auto grid gap-2 border-t border-[var(--line)] pt-4 text-xs text-[var(--muted)] sm:grid-cols-2">
          <Term icon={Clock3}>{formatTtl(job.claimTtlSeconds)}</Term>
          <Term icon={WalletCards}>{formatStake(job.stake, job.reward?.asset)}</Term>
          <Term icon={Fuel}>{job.requiresSponsoredGas ? "Gas brokered" : "Worker-paid gas"}</Term>
          <Term icon={ShieldCheck}>{job.onboardingWaiverEligible ? "Fresh-wallet waiver eligible" : "Bond rules apply"}</Term>
        </div>
        <a className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--accent)]" href={workJobHref(job.id)}>
          Review terms <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
        </a>
      </CardContent>
    </Card>
  );
}

function Term({ icon: Icon, children }: { icon: typeof Clock3; children: React.ReactNode }) {
  return <span className="flex items-center gap-2"><Icon className="h-3.5 w-3.5 text-[var(--accent)]" />{children}</span>;
}

function formatTtl(seconds: number | null | undefined): string {
  if (!Number.isFinite(Number(seconds))) return "TTL shown in task";
  const minutes = Math.round(Number(seconds) / 60);
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h claim window` : `${minutes}m claim window`;
}

function formatStake(value: number | string | null | undefined, asset: string | null | undefined): string {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? `${formatAmount(number, asset ?? "")} at claim` : "No listed stake";
}
