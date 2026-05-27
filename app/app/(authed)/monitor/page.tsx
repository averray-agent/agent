"use client";

// Hermes Handoff Monitor — board page (M5)
//
// Drawer wiring lands. Clicking a card sets `?card=<id>` on the
// URL; the page reads the param and mounts <DetailDrawer/> when
// present. Esc closes (drops the param), scrim click closes,
// the drawer's own close button closes. j/k inside the drawer
// traverse cards in the same visible order the board renders.
//
// What changed from M4:
//   - URL-param routing via Next.js useSearchParams + useRouter
//   - CardRouter onClick wires to setFocusedCard
//   - DetailDrawer mounts when ?card= is set
//   - j/k traversal scoped to the drawer when open; M9 wires the
//     board-level j/k
//
// Still M5-level for keyboard nav across the board itself (M9).

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { deriveBoardState } from "@/lib/monitor/board-state.js";
import type { BoardCard } from "@/lib/monitor/card-types.js";
import {
  decodeCardParam,
  encodeCardParam,
  traverseDrawerCard,
} from "@/lib/monitor/drawer-routing.js";
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
import { DetailDrawer } from "@/components/monitor/drawer/DetailDrawer";

export default function MonitorPage() {
  const { data, isLoading, streamStatus, refresh } = useMonitorBoard();
  const router = useRouter();
  const pathname = usePathname() ?? "/monitor";
  const searchParams = useSearchParams();

  const cards: BoardCard[] = useMemo(() => data?.cards ?? [], [data]);
  const nowLabel = useMemo(() => buildNowLabel(data?.at), [data?.at]);

  const state = useMemo(
    () =>
      deriveBoardState(cards, {
        nowLabel,
        streamOnline: streamStatus === "open",
      }),
    [cards, nowLabel, streamStatus]
  );

  // Focused card id from the URL param. Resolve to the actual
  // BoardCard object; if the param points at an id we no longer
  // have (archived between paint cycles), drop the focus.
  const focusedCardId = decodeCardParam(searchParams?.get("card"));
  const focusedCard = useMemo(
    () =>
      focusedCardId
        ? cards.find((c) => c.id === focusedCardId)
        : undefined,
    [cards, focusedCardId]
  );

  const setFocusedCard = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      if (id) {
        const encoded = encodeCardParam(id);
        if (encoded) next.set("card", id);
      } else {
        next.delete("card");
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [router, pathname, searchParams]
  );

  const onCardClick = useCallback(
    (card: BoardCard) => setFocusedCard(card.id),
    [setFocusedCard]
  );
  const onCloseDrawer = useCallback(() => setFocusedCard(null), [setFocusedCard]);
  const onDrawerNext = useCallback(() => {
    const nextId = traverseDrawerCard(cards, focusedCardId, "next");
    if (nextId && nextId !== focusedCardId) setFocusedCard(nextId);
  }, [cards, focusedCardId, setFocusedCard]);
  const onDrawerPrev = useCallback(() => {
    const prevId = traverseDrawerCard(cards, focusedCardId, "prev");
    if (prevId && prevId !== focusedCardId) setFocusedCard(prevId);
  }, [cards, focusedCardId, setFocusedCard]);

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
            // refresh button doesn't need its own toast for M5.
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
                <CardRouter key={card.id} card={card} onClick={onCardClick} />
              )}
            />
          )}
        </div>
        {/* M7 mounts <CoPilotRail /> here. */}
      </div>

      {focusedCard ? (
        <DetailDrawer
          card={focusedCard}
          onClose={onCloseDrawer}
          onNext={onDrawerNext}
          onPrev={onDrawerPrev}
        />
      ) : null}
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
