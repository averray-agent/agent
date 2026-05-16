"use client";

import { useMemo } from "react";
import { DrawerSection } from "@/components/shell/DetailDrawer";
import { SessionStatePill, VerifierModeChip } from "./pills";
import { WorkerChip } from "./WorkerChip";
import { VerticalLifecycleRail } from "./VerticalLifecycleRail";
import { EscrowLedger } from "./EscrowLedger";
import { PayoutTrail } from "./PayoutTrail";
import {
  EMPTY_TIMELINE_EVENT_FILTERS,
  isTimelineEventFilterActive,
  TimelineEventFilters,
  type TimelineEventFilterValue,
} from "@/components/runs/TimelineEventFilters";
import type { EscrowMovement, SessionDetail } from "./types";

export interface SessionDrawerBodyProps {
  session: SessionDetail;
  /** URL-backed timeline event filter from the sessions page. Drawer
   *  filters `movements` client-side because /session/timeline does
   *  not currently accept the filter params /admin/jobs/timeline
   *  does. */
  eventFilters?: TimelineEventFilterValue;
  onEventFiltersChange?: (next: TimelineEventFilterValue) => void;
}

export function SessionDrawerBody({
  session,
  eventFilters,
  onEventFiltersChange,
}: SessionDrawerBodyProps) {
  const filters = eventFilters ?? EMPTY_TIMELINE_EVENT_FILTERS;
  const filtersActive = isTimelineEventFilterActive(filters);
  const visibleMovements = useMemo(
    () => filterMovements(session.movements, filters),
    [filters, session.movements]
  );
  const hiddenCount = session.movements.length - visibleMovements.length;
  const handleFilterChange = onEventFiltersChange ?? (() => {});

  return (
    <>
      <DrawerSection title="Session">
        <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <SessionStatePill state={session.state} />
            <VerifierModeChip mode={session.verifierMode} />
            <span
              className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              policy · <span className="text-[var(--avy-ink)]">{session.policy}</span>
            </span>
          </div>
          <div>
            <div className="font-[family-name:var(--font-display)] text-[15px] font-bold text-[var(--avy-ink)]">
              {session.job.title}
            </div>
            <div
              className="mt-0.5 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {session.job.meta}
            </div>
          </div>
          <WorkerChip
            tone={session.worker.tone}
            initials={session.worker.initials}
            handle={session.worker.handle}
            address={session.worker.address}
          />
          <div
            className="flex flex-wrap gap-4 border-t border-[var(--avy-line-soft)] pt-2.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
            style={{ letterSpacing: 0 }}
          >
            <span>
              Run · <span className="text-[var(--avy-ink)]">{session.runRef}</span>
            </span>
            <span>
              Escrow ·{" "}
              <span className="text-[var(--avy-ink)]">
                {session.escrow.amount} {session.escrow.asset}
              </span>
            </span>
            <span>
              Opened · <span className="text-[var(--avy-ink)]">{session.openedAt}</span>
            </span>
            {session.receipt ? (
              <span>
                Receipt ·{" "}
                <span className="text-[var(--avy-accent)]">{session.receipt}</span>
              </span>
            ) : null}
            {session.disputeHref ? (
              <a
                href={session.disputeHref}
                className="border-b border-dashed border-[color:rgba(140,42,23,0.4)] text-[#8c2a17] hover:text-[#6a2010]"
              >
                Open dispute →
              </a>
            ) : null}
          </div>
        </div>
      </DrawerSection>

      <DrawerSection title="Lifecycle">
        <VerticalLifecycleRail stages={session.lifecycle} />
      </DrawerSection>

      <DrawerSection
        title={
          filtersActive
            ? `Escrow ledger · ${visibleMovements.length} of ${session.movements.length} movements`
            : `Escrow ledger · ${session.movements.length} movements`
        }
      >
        {onEventFiltersChange ? (
          <div className="mb-2">
            <TimelineEventFilters
              value={filters}
              onChange={handleFilterChange}
              idPrefix="session-timeline-filter"
            />
          </div>
        ) : null}
        {filtersActive && visibleMovements.length === 0 && session.movements.length > 0 ? (
          <div className="rounded-[8px] border border-dashed border-[var(--avy-line)] bg-[rgba(255,253,247,0.5)] p-4 text-center">
            <p
              className="m-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              No events match these filters.
            </p>
            {onEventFiltersChange ? (
              <button
                type="button"
                onClick={() => handleFilterChange(EMPTY_TIMELINE_EVENT_FILTERS)}
                className="mt-2 rounded-[6px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-2.5 py-1 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-ink)] transition-colors hover:border-[color:rgba(30,102,66,0.35)] hover:text-[var(--avy-accent)]"
                style={{ letterSpacing: "0.08em" }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <EscrowLedger movements={visibleMovements} />
            {filtersActive && hiddenCount > 0 ? (
              <p
                className="m-0 mt-1.5 font-[family-name:var(--font-mono)] text-[11px] text-[var(--avy-muted)]"
                style={{ letterSpacing: 0 }}
              >
                {hiddenCount} hidden by filter — clear filters to see all events.
              </p>
            ) : null}
          </>
        )}
      </DrawerSection>

      <DrawerSection title="Payout trail">
        <PayoutTrail payouts={session.payouts} />
      </DrawerSection>

      <DrawerSection title="Evidence & verifier">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <LinkCard
            role="Evidence"
            ref={`/badges/${session.runRef}`}
            href={session.evidenceHref}
          />
          <LinkCard
            role="Verifier output"
            ref={`${session.verifierMode} · handler-v0.14`}
            href={session.verifierHref}
          />
        </div>
      </DrawerSection>
    </>
  );
}

function LinkCard({
  role,
  ref,
  href,
}: {
  role: string;
  ref: string;
  href: string;
}) {
  return (
    <a
      href={href}
      className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-3 py-2 transition-colors hover:border-[color:rgba(30,102,66,0.28)] hover:bg-white"
    >
      <span className="flex flex-col gap-0.5">
        <span
          className="font-[family-name:var(--font-display)] text-[9.5px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.12em" }}
        >
          {role}
        </span>
        <span
          className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--avy-ink)]"
          style={{ letterSpacing: 0 }}
        >
          {ref}
        </span>
      </span>
      <span className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--avy-accent)]">
        →
      </span>
    </a>
  );
}

function filterMovements(
  movements: EscrowMovement[],
  filters: TimelineEventFilterValue
): EscrowMovement[] {
  const source = filters.source.trim().toLowerCase();
  const topic = filters.topic.trim().toLowerCase();
  const phase = filters.phase.trim().toLowerCase();
  const severity = filters.severity.trim().toLowerCase();
  const wallet = filters.wallet.trim().toLowerCase();
  const correlationId = filters.correlationId.trim().toLowerCase();
  if (!source && !topic && !phase && !severity && !wallet && !correlationId) {
    return movements;
  }
  return movements.filter((movement) => {
    if (source && (movement.source ?? "").toLowerCase() !== source) return false;
    if (topic) {
      // Match on either the explicit topic or the rendered label
      // (legacy seed movements only carry the label) so an operator
      // filtering by `session.claimed` still sees the seed row.
      const movementTopic = (movement.topic ?? movement.label ?? "").toLowerCase();
      if (!movementTopic.includes(topic)) return false;
    }
    if (phase && (movement.phase ?? "").toLowerCase() !== phase) return false;
    if (severity && (movement.severity ?? "").toLowerCase() !== severity)
      return false;
    if (wallet) {
      const haystack = [movement.wallet, movement.from, movement.to]
        .map((v) => (v ?? "").toLowerCase())
        .join(" ");
      if (!haystack.includes(wallet)) return false;
    }
    if (
      correlationId &&
      (movement.correlationId ?? "").toLowerCase() !== correlationId
    )
      return false;
    return true;
  });
}
