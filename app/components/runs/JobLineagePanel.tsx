"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ApiError } from "@/lib/api/client";
import { useJobTimeline } from "@/lib/api/hooks";
import {
  buildJobTimeline,
  type JobTimeline,
  type TimelineLineage,
} from "@/lib/api/job-timeline";
import { cn } from "@/lib/utils/cn";

/**
 * Sub-job lineage panel for /runs/detail. Closes the
 * CORE_FRAMEWORK_ROADMAP §8 unchecked item ("extend profile and
 * operator UI surfaces around sub-contracting history") for the
 * operator app side.
 *
 * Reads the same `/admin/jobs/timeline` payload the JobTimelinePanel
 * already fetches — SWR dedupes by URL key, so this panel is a free
 * second consumer of one fetch. Surfaces three lineage relationships
 * the timeline already returns:
 *
 *   1. Parent session — the in-flight parent run that spawned this
 *      sub-job (via `POST /jobs/sub`). Renders a deeplink back to
 *      `/runs?run=<parent-job>` so the operator can hop up the tree.
 *   2. Child jobs / sessions — sub-jobs the loaded run created. Each
 *      child job links back into /runs.
 *   3. Recurring template / derivatives — when the loaded job is
 *      itself a recurring template, lists the derivative jobs the
 *      scheduler has fired. When it's a derivative, the parent
 *      template id is exposed for context.
 *
 * Only rendered on the standalone /runs/detail page (showLifecycle
 * === true) — same gate as the JobTimelinePanel — so the queue
 * page stays scannable.
 */
export function JobLineagePanel({ jobId }: { jobId: string }) {
  const request = useJobTimeline(jobId);
  const data: JobTimeline = useMemo(
    () => buildJobTimeline(request.data),
    [request.data]
  );
  const unauthenticated =
    request.error instanceof ApiError &&
    (request.error.status === 401 || request.error.status === 403);

  // Roll the lineage shape into a flat "do we have anything to show?"
  // gate. When every relationship is empty, the panel renders a quiet
  // empty state rather than five blank stubs — most jobs aren't part
  // of any lineage.
  const lineage = data.lineage;
  const hasParent = Boolean(lineage.parentSession || lineage.parentSessionId);
  const hasChildren = lineage.childJobIds.length > 0;
  const hasRecurringTemplate = lineage.recurringTemplate;
  const hasDerivatives = lineage.derivativeJobIds.length > 0;
  const isDerivative =
    !lineage.recurringTemplate && Boolean(lineage.templateId);
  const empty =
    !hasParent && !hasChildren && !hasRecurringTemplate && !isDerivative;

  return (
    <section
      aria-labelledby="job-lineage-heading"
      className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-4 shadow-[var(--shadow-card)]"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span
            className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
            style={{ letterSpacing: "0.12em" }}
          >
            Sub-job lineage
          </span>
          <h2
            id="job-lineage-heading"
            className="m-0 font-[family-name:var(--font-display)] text-[16px] font-bold text-[var(--avy-ink)]"
          >
            Parents, children, and recurring derivatives
          </h2>
        </div>
        <LineageSummaryHint
          data={data}
          loading={Boolean(request.isLoading)}
          unauthenticated={unauthenticated}
          empty={empty}
        />
      </header>

      {empty ? (
        <EmptyState
          unauthenticated={unauthenticated}
          loading={Boolean(request.isLoading)}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ParentBlock lineage={lineage} />
          <RecurringBlock
            lineage={lineage}
            isDerivative={isDerivative}
            hasDerivatives={hasDerivatives}
          />
          <ChildrenBlock lineage={lineage} />
        </div>
      )}
    </section>
  );
}

function LineageSummaryHint({
  data,
  loading,
  unauthenticated,
  empty,
}: {
  data: JobTimeline;
  loading: boolean;
  unauthenticated: boolean;
  empty: boolean;
}) {
  if (unauthenticated) {
    return <Hint>sign in to load</Hint>;
  }
  if (loading && data.summary.eventCount === 0) {
    return <Hint>loading…</Hint>;
  }
  if (empty) return <Hint>no related runs</Hint>;
  const parts: string[] = [];
  if (data.summary.childJobCount > 0) {
    parts.push(
      `${data.summary.childJobCount} child${data.summary.childJobCount === 1 ? "" : "ren"}`
    );
  }
  if (data.lineage.recurringTemplate && data.summary.derivativeJobCount > 0) {
    parts.push(
      `${data.summary.derivativeJobCount} derivative${data.summary.derivativeJobCount === 1 ? "" : "s"}`
    );
  }
  if (data.lineage.parentSessionId) parts.push("has parent");
  return <Hint>{parts.length > 0 ? parts.join(" · ") : "/admin/jobs/timeline"}</Hint>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
      style={{ letterSpacing: 0 }}
    >
      {children}
    </span>
  );
}

function EmptyState({
  unauthenticated,
  loading,
}: {
  unauthenticated: boolean;
  loading: boolean;
}) {
  return (
    <div className="rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] p-4 text-center">
      <p
        className="m-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
        style={{ letterSpacing: 0 }}
      >
        {unauthenticated
          ? "Sign in with your operator wallet to load lineage. /admin/jobs/timeline is admin-gated."
          : loading
            ? "Loading lineage…"
            : "This run isn't part of any lineage. No parent session, no child runs, not a recurring template."}
      </p>
    </div>
  );
}

function ParentBlock({ lineage }: { lineage: TimelineLineage }) {
  const parent = lineage.parentSession;
  const hasParent = Boolean(parent || lineage.parentSessionId);
  if (!hasParent) {
    return (
      <Block label="Parent session" tone="muted">
        <p className="m-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]" style={{ letterSpacing: 0 }}>
          No parent — this is a top-level run.
        </p>
      </Block>
    );
  }
  if (!parent) {
    // We have a parentSessionId from the lineage block but no resolved
    // parent record (the state store dropped it). Render the id as a
    // mono code element so the operator can copy it for grep.
    return (
      <Block label="Parent session" tone="warn">
        <p className="m-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]" style={{ letterSpacing: 0 }}>
          {lineage.parentSessionId}
        </p>
        <Note>Parent session id present but record not in the active store.</Note>
      </Block>
    );
  }
  return (
    <Block label="Parent session" tone="ok">
      <RelatedJobLink
        jobId={parent.jobId}
        label={parent.jobId}
        meta={`session ${shortId(parent.sessionId)} · ${parent.status}`}
      />
      {parent.wallet ? (
        <Note>
          Parent worker:{" "}
          <code className="font-[family-name:var(--font-mono)] text-[var(--avy-ink)]">
            {shortAddress(parent.wallet)}
          </code>
        </Note>
      ) : null}
    </Block>
  );
}

function ChildrenBlock({ lineage }: { lineage: TimelineLineage }) {
  if (lineage.childJobIds.length === 0) {
    return (
      <Block label="Child runs" tone="muted" className="lg:col-span-2">
        <p className="m-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]" style={{ letterSpacing: 0 }}>
          No sub-jobs spawned from this run yet.
        </p>
      </Block>
    );
  }
  return (
    <Block label={`Child runs · ${lineage.childJobIds.length}`} tone="ok" className="lg:col-span-2">
      <ul className="m-0 grid gap-1.5 p-0 list-none">
        {lineage.childJobIds.map((childJobId) => (
          <li key={childJobId}>
            <RelatedJobLink jobId={childJobId} label={childJobId} />
          </li>
        ))}
      </ul>
      {lineage.childSessionIds.length > 0 ? (
        <Note>
          {lineage.childSessionIds.length} session
          {lineage.childSessionIds.length === 1 ? "" : "s"} across these child
          runs.
        </Note>
      ) : null}
    </Block>
  );
}

function RecurringBlock({
  lineage,
  isDerivative,
  hasDerivatives,
}: {
  lineage: TimelineLineage;
  isDerivative: boolean;
  hasDerivatives: boolean;
}) {
  if (lineage.recurringTemplate) {
    return (
      <Block label="Recurring template" tone="ok">
        <p
          className="m-0 font-[family-name:var(--font-body)] text-[12.5px] leading-[1.45] text-[var(--avy-ink)]"
          style={{ letterSpacing: 0 }}
        >
          This run is the recurring template. The scheduler has fired{" "}
          <strong className="font-semibold">
            {lineage.derivativeJobIds.length}
          </strong>{" "}
          derivative{lineage.derivativeJobIds.length === 1 ? "" : "s"}.
        </p>
        {hasDerivatives ? (
          <ul className="m-0 mt-1.5 grid gap-1 p-0 list-none">
            {lineage.derivativeJobIds.slice(0, 5).map((jobId) => (
              <li key={jobId}>
                <RelatedJobLink jobId={jobId} label={jobId} />
              </li>
            ))}
            {lineage.derivativeJobIds.length > 5 ? (
              <li>
                <Note>
                  + {lineage.derivativeJobIds.length - 5} more derivative
                  {lineage.derivativeJobIds.length - 5 === 1 ? "" : "s"}.
                </Note>
              </li>
            ) : null}
          </ul>
        ) : null}
      </Block>
    );
  }
  if (isDerivative && lineage.templateId) {
    return (
      <Block label="Recurring derivative" tone="ok">
        <p
          className="m-0 font-[family-name:var(--font-body)] text-[12.5px] leading-[1.45] text-[var(--avy-ink)]"
          style={{ letterSpacing: 0 }}
        >
          Fired by recurring template{" "}
          <RelatedJobLink jobId={lineage.templateId} label={lineage.templateId} inline />
          .
        </p>
      </Block>
    );
  }
  return (
    <Block label="Recurring" tone="muted">
      <p className="m-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]" style={{ letterSpacing: 0 }}>
        Not a recurring template or derivative.
      </p>
    </Block>
  );
}

function Block({
  label,
  tone,
  children,
  className,
}: {
  label: string;
  tone: "ok" | "warn" | "muted";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-[8px] border border-[var(--avy-line-soft)] bg-[var(--avy-paper-solid)] p-3",
        className
      )}
    >
      <span
        className={cn(
          "font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase",
          tone === "ok" && "text-[var(--avy-accent)]",
          tone === "warn" && "text-[var(--avy-warn)]",
          tone === "muted" && "text-[var(--avy-muted)]"
        )}
        style={{ letterSpacing: "0.14em" }}
      >
        {label}
      </span>
      {children}
    </article>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="m-0 mt-0.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
      style={{ letterSpacing: 0 }}
    >
      {children}
    </p>
  );
}

function RelatedJobLink({
  jobId,
  label,
  meta,
  inline,
}: {
  jobId: string;
  label: string;
  meta?: string;
  inline?: boolean;
}) {
  const href = `/runs?run=${encodeURIComponent(jobId)}`;
  const className = inline
    ? "font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-accent)] hover:underline"
    : "block font-[family-name:var(--font-mono)] text-[12.5px] leading-[1.4] text-[var(--avy-accent)] hover:underline";
  if (inline) {
    return (
      <Link href={href} className={className}>
        <code>{label}</code>
      </Link>
    );
  }
  return (
    <Link href={href} className={className}>
      <code className="break-all">{label}</code>
      {meta ? (
        <span className="block font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]">
          {meta}
        </span>
      ) : null}
    </Link>
  );
}

function shortId(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function shortAddress(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
