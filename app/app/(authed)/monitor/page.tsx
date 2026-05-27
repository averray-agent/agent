"use client";

// Hermes Handoff Monitor — board page (M3)
//
// Static rich-mix layout. Wires:
//   - TopStrip (KPIs derived from fixture cards)
//   - BoardNowBanner (mode follows fixture state — action when an
//     action card is present, calm otherwise)
//   - LanesBar (search disabled, filter chips count-only)
//   - Board with full card rendering via CardRouter
//
// M3 swaps M2's empty card array for the fixtures so the page
// demonstrates every card type + variant. M4 swaps fixtures for
// live SWR data. M5 wires the drawer (click handler currently
// no-ops; M5 routes ?card= URL param).
//
// The auth guard (PR #462 / Package E) already wraps this via the
// (authed) layout, so unauthed visitors never see it.

import { useMemo } from "react";
import { deriveBoardState } from "@/lib/monitor/board-state.js";
import { FIXTURE_CARDS } from "@/lib/monitor/fixtures";
import { TopStrip } from "@/components/monitor/TopStrip";
import { BoardNowBanner } from "@/components/monitor/BoardNowBanner";
import { LanesBar } from "@/components/monitor/LanesBar";
import {
  Board,
  DEFAULT_EXPANDED,
  ACTION_EXPANDED,
  CALM_EXPANDED,
} from "@/components/monitor/Board";
import { CardRouter } from "@/components/monitor/cards/CardRouter";

export default function MonitorPage() {
  // M3: fixture data. M4 replaces with `useBoardState()` (SWR over
  // /api/monitor/board) + SSE-driven updates. The current-time
  // stamp is deterministic across SSR hydration because we compute
  // it once at mount.
  const cards = FIXTURE_CARDS;
  const nowLabel = useMemo(() => buildNowLabel(), []);

  const state = useMemo(
    () => deriveBoardState(cards, { nowLabel, streamOnline: true }),
    [cards, nowLabel]
  );

  // Pick the expansion preset based on the board's mode so the
  // first paint already shows the right shape:
  //   - action  → ACTION_EXPANDED (operator-review + hermes-checking + deploying + done)
  //   - calm    → CALM_EXPANDED (just done)
  //   - default → DEFAULT_EXPANDED
  const initialExpanded =
    state.mode === "action"
      ? ACTION_EXPANDED
      : state.mode === "calm"
        ? CALM_EXPANDED
        : DEFAULT_EXPANDED;

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
          <Board
            grouped={state.grouped}
            initialExpanded={initialExpanded}
            renderCard={(card) => (
              <CardRouter
                key={card.id}
                card={card}
                // M5 wires the actual drawer; M3's click is a no-op
                // so the cards are still clickable (visual focus state)
                // without yet routing to a detail surface.
                onClick={() => undefined}
              />
            )}
          />
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
