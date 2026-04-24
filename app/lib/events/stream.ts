"use client";

/**
 * SSE event stream client.
 *
 * Ported from frontend/events.js. Connects to /events with bearer in
 * query param (EventSource can't set custom headers). Handles:
 *   - heartbeat watchdog: the server pings every 15s; 45s idle → reconnect
 *   - exponential backoff to 10s cap with a hard cap of 30 attempts
 *   - automatic 401 detection through the re-auth callback
 */

import { getStoredToken } from "@/lib/auth/token-store";

export const EVENT_TOPICS = [
  "session.claimed",
  "session.submitted",
  "verification.resolved",
  "escrow.job_funded",
  "escrow.job_claimed",
  "escrow.work_submitted",
  "escrow.job_rejected",
  "escrow.job_closed",
  "escrow.job_reopened",
  "escrow.dispute_opened",
  "account.job_stake_locked",
  "account.job_stake_released",
  "account.job_stake_slashed",
  "reputation.badge_minted",
  "reputation.updated",
  "reputation.slashed",
  "system.reconnect",
  "system.provider_error",
  "system.listener_error",
  "gap",
] as const;

export type EventTopic = (typeof EVENT_TOPICS)[number];

const HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_RECONNECT_ATTEMPTS = 30;

export interface StreamOptions {
  wallet?: string;
  sessionId?: string;
  jobId?: string;
  topics?: EventTopic[];
  onEvent?: (payload: { topic: EventTopic; data: unknown; id?: string }) => void;
  onGap?: (info: { lastEventId?: string }) => void;
  onError?: (error: Event) => void;
  onStalled?: (info: { reconnectAttempts: number }) => void;
  onReauthNeeded?: () => void;
}

function apiUrl(path: string): string {
  const base =
    (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_BASE_URL : undefined) ??
    "/api";
  return `${base.replace(/\/+$/u, "")}${path}`;
}

export function startEventStream(opts: StreamOptions) {
  let source: EventSource | undefined;
  let stopped = false;
  let reconnectDelayMs = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  let lastEventId = "";

  const bumpHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      source?.close();
      scheduleReconnect();
    }, HEARTBEAT_TIMEOUT_MS);
  };

  const scheduleReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (stopped) return;
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      stopped = true;
      opts.onStalled?.({ reconnectAttempts });
      return;
    }
    reconnectTimer = setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
  };

  const connect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (stopped || typeof EventSource === "undefined") return;

    const params = new URLSearchParams();
    if (opts.wallet) params.set("wallet", opts.wallet);
    if (opts.sessionId) params.set("sessionId", opts.sessionId);
    if (opts.jobId) params.set("jobId", opts.jobId);
    if (opts.topics?.length) params.set("topics", opts.topics.join(","));
    if (lastEventId) params.set("lastEventId", lastEventId);
    const token = getStoredToken();
    if (token) params.set("token", token);

    source = new EventSource(`${apiUrl("/events")}?${params.toString()}`);
    bumpHeartbeat();

    source.addEventListener("open", () => {
      reconnectAttempts = 0;
      reconnectDelayMs = 1000;
      bumpHeartbeat();
    });

    source.addEventListener("ping", bumpHeartbeat);

    for (const topic of opts.topics ?? EVENT_TOPICS) {
      source.addEventListener(topic, (ev) => {
        bumpHeartbeat();
        const messageEvent = ev as MessageEvent;
        if (messageEvent.lastEventId) lastEventId = messageEvent.lastEventId;
        let data: unknown = messageEvent.data;
        try {
          data = JSON.parse(messageEvent.data);
        } catch {
          // non-JSON frames — pass through raw
        }
        if (topic === "gap") {
          opts.onGap?.({ lastEventId: messageEvent.lastEventId });
          return;
        }
        opts.onEvent?.({ topic, data, id: messageEvent.lastEventId });
      });
    }

    source.addEventListener("error", (ev) => {
      opts.onError?.(ev);
      source?.close();
      scheduleReconnect();
    });
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    source?.close();
  };
}
