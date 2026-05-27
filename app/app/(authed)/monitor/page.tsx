"use client";

// Hermes Handoff Monitor — board page (M4)
//
// Live-data wired. Reads from /api/monitor/board (SWR) + receives
// per-card mutations via /api/monitor/stream (SSE). The page no
// longer imports fixtures directly — the backend's monitor-service
// is the source of truth; for M4 that service is seeded from the
// SAME fixture set the frontend used to ship, so visually
// nothing changes vs. M3.
//
// What changed from M3:
//   - useMonitorBoard() replaces the static FIXTURE_CARDS import
//   - LIVE indicator reflects real SSE stream status
//   - localStorage snapshots written on every refresh (per §21
//     decision #4 of the spec)
//   - The TopStrip's "Refresh" button now actually refreshes
//
// Still M3-level for the click path (drawer is M5).

import { useMemo } from "react";
import { deriveBoardState } from "@/lib/monitor/board-state.js";
import type { BoardCard } from "@/lib/monitor/card-types.js";
import { useMonitorBoard } from "@/lib/api/hooks/useMonitorBoard";
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
  const { data, isLoading, streamStatus, refresh } = useMonitorBoard();

  const cards: BoardCard[] = useMemo(
    () => data?.cards ?? [],
    [data]
  );
  const nowLabel = useMemo(() => buildNowLabel(data?.at), [data?.at]);

  const state = useMemo(
    () =>
      deriveBoardState(cards, {
        nowLabel,
        streamOnline: streamStatus === "open",
      }),
    [cards, nowLabel, streamStatus]
  );

  // Expansion preset follows the derived mode.
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
        liveAt={liveIndicatorLabel(streamStatus, nowLabel)}
        deployHealth={streamStatus === "open" ? "OK" : "UNKNOWN"}
        onRefresh={() => {
          refresh().catch(() => {
            // Errors surface via the SWR `error` field; the manual
            // refresh button doesn't need its own toast for M4.
          });
        }}
      />

      <BoardNowBanner banner={state.banner} />

      <div className="hm-main">
        <div className="hm-lanes-wrap">
          <LanesBar counts={state.counts} mode={state.mode} />
          {isLoading && !data ? (
            <div className="hm-lane-empty" style={{ padding: "2rem" }}>
              Loading board…
            </div>
          ) : (
            <Board
              grouped={state.grouped}
              initialExpanded={initialExpanded}
              renderCard={(card) => (
                <CardRouter
                  key={card.id}
                  card={card}
                  // M5 wires the actual drawer.
                  onClick={() => undefined}
                />
              )}
            />
          )}
        </div>
        {/* M7 mounts <CoPilotRail /> here. */}
      </div>
    </div>
  );
}

/**
 * Render the board's `at` timestamp as "HH:MM:SS utc". Falls back
 * to the local clock if data hasn't arrived yet.
 */
function buildNowLabel(serverAt: string | undefined): string {
  const d = serverAt ? new Date(serverAt) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} utc`;
}

/**
 * Format the LIVE indicator label in the TopStrip. When the stream
 * is open, show the timestamp; when reconnecting, show
 * "reconnecting…"; when closed, show "—".
 */
function liveIndicatorLabel(
  status: "idle" | "connecting" | "open" | "reconnecting" | "closed",
  nowLabel: string
): string {
  if (status === "open") return nowLabel.replace(/ utc$/i, "");
  if (status === "reconnecting") return "reconnecting…";
  if (status === "connecting") return "connecting…";
  return "—";
}
