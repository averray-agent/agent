"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Compass, X } from "lucide-react";
import { useAuth } from "@/lib/auth/use-auth";
import {
  shouldShowOverviewOrientation,
  OVERVIEW_ORIENTATION_DISMISSED_KEY,
} from "@/lib/ui/overview-orientation";

interface OrientationCardProps {
  /** Open runs + sessions + receipts — the room's current activity. */
  roomActivityCount: number;
  /** Activity requests have resolved (data or error), not still loading. */
  activityResolved: boolean;
}

/**
 * First-load orientation card (roadmap A4). Shows a single dismissable
 * next-step nudge to a signed-in operator whose room has no activity yet,
 * then stays gone once dismissed (persisted) or once the room has any
 * activity. Sits above the vitals hero as a slim strip so it orients
 * without competing with the metrics.
 */
export function OrientationCard({
  roomActivityCount,
  activityResolved,
}: OrientationCardProps) {
  const auth = useAuth();
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Client-only: read auth + the persisted dismissal after mount so we
  // never render a wrong frame during SSR / pre-hydration.
  useEffect(() => {
    setMounted(true);
    try {
      setDismissed(
        window.localStorage.getItem(OVERVIEW_ORIENTATION_DISMISSED_KEY) === "1"
      );
    } catch {
      // localStorage unavailable (e.g. private mode) — treat as not dismissed.
    }
  }, []);

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(OVERVIEW_ORIENTATION_DISMISSED_KEY, "1");
    } catch {
      // Best-effort persistence; the card still hides for this session.
    }
  }

  const show =
    mounted &&
    shouldShowOverviewOrientation({
      dismissed,
      authenticated: auth.authenticated,
      activityResolved,
      roomActivityCount,
    });

  if (!show) return null;

  return (
    <section
      aria-label="Getting started"
      className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--accent-soft)] px-4 py-3"
    >
      <Compass
        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-[family-name:var(--font-display)] text-sm font-semibold tracking-tight text-[var(--ink)]">
          Welcome to your control room
        </p>
        <p className="text-[13px] leading-relaxed text-[var(--muted)]">
          This is where agent work becomes a legible trail — runs are posted,
          verified, settled in USDC, and turned into portable reputation. Your
          room is quiet right now; start by browsing the open runs.
        </p>
      </div>
      <Link
        href="/runs"
        className="shrink-0 self-center rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-solid)] px-3 py-1.5 text-[13px] font-semibold text-[var(--accent-hover)] transition-colors hover:bg-[var(--paper)]"
      >
        Browse open runs →
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss getting-started card"
        className="shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
