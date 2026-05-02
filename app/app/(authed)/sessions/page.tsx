"use client";

import { useMemo, useState } from "react";
import { DetailDrawer } from "@/components/shell/DetailDrawer";
import { SessionsTopbar } from "@/components/sessions/SessionsTopbar";
import { SessionsAggregateStrip } from "@/components/sessions/SessionsAggregateStrip";
import {
  SessionsFilterRail,
  type SessionsFilter,
} from "@/components/sessions/SessionsFilterRail";
import { SessionsTable } from "@/components/sessions/SessionsTable";
import { SessionDrawerBody } from "@/components/sessions/SessionDrawerBody";
import { SessionStatePill } from "@/components/sessions/pills";
import {
  useAdminSessions,
  useJobs,
  useSession,
  useSessionTimeline,
} from "@/lib/api/hooks";
import { freshnessFromRequests } from "@/components/shell/DataFreshnessPill";
import { buildSessionDetails, mergeSessionTimeline } from "@/lib/api/session-adapters";

function valueBucket(amountStr: string): SessionsFilter["value"] {
  const n = Number(amountStr);
  if (!Number.isFinite(n)) return "all";
  if (n < 10) return "lt-10";
  if (n < 100) return "10-100";
  if (n < 1000) return "100-1k";
  return "1k-plus";
}

export default function SessionsPage() {
  const sessionsQuery = useAdminSessions();
  const jobsQuery = useJobs();
  const [filter, setFilter] = useState<SessionsFilter>({
    state: "all",
    asset: "all",
    value: "all",
    verifier: "all",
    q: "",
  });
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const liveSessions = useMemo(
    () => buildSessionDetails(sessionsQuery.data, jobsQuery.data),
    [jobsQuery.data, sessionsQuery.data]
  );
  const sessions = liveSessions;

  const filtered = useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filter.state !== "all" && s.state !== filter.state) return false;
      if (filter.asset !== "all" && s.escrow.asset !== filter.asset) return false;
      if (filter.verifier !== "all" && s.verifierMode !== filter.verifier) return false;
      if (filter.value !== "all" && valueBucket(s.escrow.amount) !== filter.value) return false;
      if (q) {
        const hay = [
          s.id,
          s.runRef,
          s.job.title,
          s.job.meta,
          s.worker.handle,
          s.worker.address,
          s.policy,
          s.receipt ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [filter, sessions]);

  const pickedFromList = pickedId ? sessions.find((s) => s.id === pickedId) ?? null : null;
  const sessionDetail = useSession(drawerOpen && pickedFromList ? pickedFromList.id : null);
  const sessionTimeline = useSessionTimeline(drawerOpen && pickedFromList ? pickedFromList.id : null);
  const livePickedDetail = useMemo(() => {
    if (!sessionDetail.data) return null;
    return buildSessionDetails([sessionDetail.data], jobsQuery.data)[0] ?? null;
  }, [jobsQuery.data, sessionDetail.data]);
  const pickedBase = livePickedDetail ?? pickedFromList;
  const picked = pickedBase && sessionTimeline.data
    ? mergeSessionTimeline(pickedBase, sessionTimeline.data)
    : pickedBase;

  const freshness = freshnessFromRequests(sessionsQuery, jobsQuery);

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <SessionsTopbar freshness={freshness} />

      <header className="flex flex-col gap-1.5">
        <span
          className="font-[family-name:var(--font-display)] text-[11.5px] font-extrabold uppercase text-[var(--avy-accent)]"
          style={{ letterSpacing: "0.12em" }}
        >
          Capital movement
        </span>
        <h1 className="m-0 font-[family-name:var(--font-display)] text-[2.4rem] font-bold leading-none text-[var(--avy-ink)]">
          Sessions
        </h1>
        <p className="m-0 mt-0.5 max-w-[62ch] font-[family-name:var(--font-body)] text-[16px] leading-[1.55] text-[var(--avy-muted)]">
          Every capital-movement lifecycle keyed to a run. Funded, claimed, submitted,
          verified, settled — or disputed and slashed. Auditors read this page; nobody
          edits it.
        </p>
      </header>

      <SessionsAggregateStrip sessions={sessions} />
      <SessionsFilterRail filter={filter} onChange={setFilter} />
      <SessionsTable
        rows={filtered}
        totalCount={sessions.length}
        selectedId={pickedId}
        onSelect={(s) => {
          setPickedId(s.id);
          setDrawerOpen(true);
        }}
      />

      <DetailDrawer
        open={drawerOpen && !!picked}
        onClose={() => setDrawerOpen(false)}
        width={640}
        title={
          picked ? (
            <>
              <span
                className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-accent)]"
                style={{ letterSpacing: "0.14em" }}
              >
                Session · read-only
              </span>
              <h2
                className="mt-0.5 font-[family-name:var(--font-mono)] text-[18px] font-semibold leading-none text-[var(--avy-ink)]"
                style={{ letterSpacing: 0 }}
              >
                {picked.id}
              </h2>
            </>
          ) : null
        }
        meta={
          picked ? (
            <div
              className="flex flex-wrap items-center gap-2 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              <SessionStatePill state={picked.state} />
              <span>
                on <span className="text-[var(--avy-ink)]">{picked.runRef}</span>
              </span>
              <span>·</span>
              <span>
                {picked.escrow.amount} {picked.escrow.asset} escrow
              </span>
            </div>
          ) : null
        }
      >
        {picked ? <SessionDrawerBody session={picked} /> : null}
      </DetailDrawer>
    </div>
  );
}
