"use client";

// Hermes Handoff Monitor — SWR hook + SSE wiring.
//
// One hook owns the live board: SWR fetches /api/monitor/board for
// the initial snapshot + refresh-on-focus / refresh-on-reconnect,
// and a LiveStream pushes per-mutation events that patch the SWR
// cache optimistically. The result: the board re-renders within
// ~1 frame of any server-side card change.
//
// Also handles:
//   - localStorage snapshot writes (per §21 decision #4)
//   - LIVE indicator status (idle/connecting/open/reconnecting/closed)
//
// Per §5 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.

import { useEffect, useRef, useState, useCallback } from "react";
import useSWR from "swr";
import type { BoardCard } from "@/lib/monitor/card-types.js";
import { LiveStream } from "@/lib/monitor/live-stream.js";
import { writeSnapshot } from "@/lib/monitor/snapshot-store.js";
import { applyEventToBoard } from "@/lib/monitor/board-cache.js";
import { getStoredToken } from "@/lib/auth/token-store";

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export type MonitorBoard = {
  cards: BoardCard[];
  at: string;
};

export type UseMonitorBoardResult = {
  data: MonitorBoard | undefined;
  isLoading: boolean;
  error: Error | undefined;
  streamStatus: StreamStatus;
  refresh: () => Promise<MonitorBoard | undefined>;
};

const BOARD_ENDPOINT = "/api/monitor/board";

const fetcher = async (url: string): Promise<MonitorBoard> => {
  const token = getStoredToken();
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`monitor board fetch failed: ${res.status} ${detail}`.trim());
  }
  return (await res.json()) as MonitorBoard;
};

export function useMonitorBoard(): UseMonitorBoardResult {
  const { data, error, isLoading, mutate } = useSWR<MonitorBoard>(BOARD_ENDPOINT, fetcher, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    dedupingInterval: 500,
  });

  const [streamStatus, setStreamStatus] = useState<StreamStatus>("idle");
  const streamRef = useRef<LiveStream | undefined>(undefined);

  // ── SSE wiring ───────────────────────────────────────────────────
  useEffect(() => {
    const token = getStoredToken();
    const stream = new LiveStream({ url: "/api/monitor/stream", token });
    streamRef.current = stream;

    const offStatus = stream.onStatus((s) => setStreamStatus(s));
    const offEvent = stream.on((event) => {
      // Each event patches the SWR cache so the UI re-renders
      // without a full HTTP refetch. board.snapshot replaces the
      // entire dataset (happens on every reconnect, keeping the
      // client in sync); per-card events patch in place.
      mutate(
        (prev) => applyEventToBoard(prev, event),
        { revalidate: false }
      );
    });

    stream.start();
    return () => {
      offStatus();
      offEvent();
      stream.stop();
    };
  }, [mutate]);

  // ── Snapshot persistence ─────────────────────────────────────────
  // Every time SWR's `data` updates, write a localStorage snapshot.
  // The writer evicts entries older than 24h on each write, so this
  // never grows unbounded. v1.1 time-travel UI reads from here.
  useEffect(() => {
    if (!data) return;
    writeSnapshot({ at: data.at, cards: data.cards });
  }, [data]);

  const refresh = useCallback(async (): Promise<MonitorBoard | undefined> => {
    return mutate();
  }, [mutate]);

  return {
    data,
    isLoading,
    error: (error as Error | undefined) ?? undefined,
    streamStatus,
    refresh,
  };
}

// `applyEventToBoard` is re-exported here for callers that want the
// hook + the cache patcher in one import. Implementation lives in
// `app/lib/monitor/board-cache.js` so node:test can cover it.
export { applyEventToBoard };
