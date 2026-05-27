"use client";

// Hermes Handoff Monitor — board page (M2)
//
// Static empty-board layout. Wires:
//   - TopStrip (with zeroed KPIs)
//   - BoardNowBanner (calm tone — "you're done for now")
//   - LanesBar (search disabled, filter chips count-only)
//   - Board (calm expansion preset: Done expanded, rest collapsed)
//
// No live data yet — M4 swaps the empty card list for an SWR-driven
// useBoardState() hook. M3 fills the rendered Done lane with closed
// cards from real data + adds the type-specific card components.
// M7 mounts the Hermes co-pilot rail to the right of `.hm-main`.
//
// The auth guard (PR #462 / Package E) already wraps this via the
// (authed) layout, so unauthed visitors never see it.

import { useMemo } from "react";
import { deriveBoardState } from "@/lib/monitor/board-state.js";
import type { BoardCard } from "@/lib/monitor/card-types.js";
import { TopStrip } from "@/components/monitor/TopStrip";
import { BoardNowBanner } from "@/components/monitor/BoardNowBanner";
import { LanesBar } from "@/components/monitor/LanesBar";
import { Board, CALM_EXPANDED } from "@/components/monitor/Board";

export default function MonitorPage() {
  // M2: no live data. Empty card list drives the calm / "you're done
  // for now" state. The current-time stamp is derived once at first
  // render so the page is deterministic for snapshot tests. M4 swaps
  // in a useLiveStream() tick.
  const cards: BoardCard[] = useMemo(() => [], []);
  const nowLabel = useMemo(() => buildNowLabel(), []);

  const state = useMemo(
    () => deriveBoardState(cards, { nowLabel, streamOnline: true }),
    [cards, nowLabel]
  );

  return (
    <div className="hm-board">
      <TopStrip
        counts={state.counts}
        liveAt={nowLabel.replace(/ utc$/i, "")}
      />

      <BoardNowBanner banner={state.banner} />

      <div className="hm-main">
        <div className="hm-lanes-wrap">
          <LanesBar counts={state.counts} mode={state.mode} />
          <Board grouped={state.grouped} initialExpanded={CALM_EXPANDED} />
        </div>
        {/* M7 mounts <CoPilotRail /> here. */}
      </div>
    </div>
  );
}

/**
 * Render the current UTC time as "HH:MM:SS utc". Stable across SSR
 * hydration because we compute once per mount and never re-render.
 */
function buildNowLabel(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} utc`;
}
