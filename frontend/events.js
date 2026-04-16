import { getAuthToken, requestReauth } from "./auth.js";
import { debug } from "./ui-helpers.js";

const EVENT_TOPICS = [
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
  "gap"
];

// Server pings every 15s (see mcp-server/src/protocols/http/server.js). A 45s
// idle window accounts for a skipped heartbeat without triggering spurious
// reconnects on slow networks.
const HEARTBEAT_TIMEOUT_MS = 45_000;
// Hard cap on sequential reconnect attempts before we stop trying. Prevents a
// wedged backend from burning battery on infinite reconnect loops.
const MAX_RECONNECT_ATTEMPTS = 30;

export function startEventStream({ wallet, sessionId, jobId, topics = [], onEvent, onGap, onError, onStalled }) {
  let source = undefined;
  let stopped = false;
  let reconnectDelayMs = 1000;
  let reconnectTimer = undefined;
  let heartbeatTimer = undefined;
  let reconnectAttempts = 0;
  let lastEventId = "";
  let reauthInFlight = false;

  const bumpHeartbeat = () => {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      debug.warn("[events] no traffic within heartbeat window, forcing reconnect");
      source?.close();
      scheduleReconnect();
    }, HEARTBEAT_TIMEOUT_MS);
  };

  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    if (stopped) {
      return;
    }
    reconnectAttempts += 1;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      debug.error("[events] reconnect cap reached; giving up");
      stopped = true;
      onStalled?.({ reconnectAttempts });
      return;
    }
    reconnectTimer = setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
  };

  const connect = () => {
    clearTimeout(reconnectTimer);
    if (stopped) {
      return;
    }

    const params = new URLSearchParams();
    if (wallet) params.set("wallet", wallet);
    if (sessionId) params.set("sessionId", sessionId);
    if (jobId) params.set("jobId", jobId);
    if (topics.length) params.set("topics", topics.join(","));
    if (lastEventId) params.set("lastEventId", lastEventId);

    // EventSource cannot set custom headers, so authentication piggy-backs on
    // a short-lived JWT passed via ?token=. See mcp-server/src/auth/middleware.js
    // which accepts this when the route is opened with `allowQueryToken: true`.
    // Read the token at each connect() so a reconnect after requestReauth()
    // picks up the freshly-issued JWT.
    const token = getAuthToken();
    if (token) params.set("token", token);

    source = new EventSource(`/api/events?${params.toString()}`);

    source.onopen = () => {
      reconnectAttempts = 0;
      reconnectDelayMs = 1000;
      bumpHeartbeat();
    };

    // Raw `message` handler catches server comments/heartbeats too. Server
    // pings are `: ping` lines which the browser doesn't surface as message
    // events, so we also bump the watchdog on every named event below.
    source.onmessage = () => {
      bumpHeartbeat();
    };

    for (const topic of EVENT_TOPICS) {
      source.addEventListener(topic, (event) => {
        bumpHeartbeat();
        if (event.lastEventId) {
          lastEventId = event.lastEventId;
        }
        reconnectDelayMs = 1000;
        reconnectAttempts = 0;
        const payload = parseEvent(event);
        if (topic === "gap") {
          onGap?.(payload);
          return;
        }
        onEvent?.(payload);
      });
    }

    source.onerror = (event) => {
      onError?.(event);
      // EventSource masks HTTP status (401 shows up as a generic error with
      // the stream in CLOSED state). Best-effort heuristic: if we were sending
      // a token and the stream closed, assume the token expired and kick off
      // a re-auth. The backoff reconnect below will pick up the new token on
      // its next pass.
      const wasAuthed = Boolean(token);
      if (source?.readyState === EventSource.CLOSED && wasAuthed && !reauthInFlight) {
        reauthInFlight = true;
        requestReauth("sse_closed")
          .catch((error) => {
            debug.warn("[events] re-auth failed after SSE close", error);
          })
          .finally(() => {
            reauthInFlight = false;
          });
      }
      source?.close();
      clearTimeout(heartbeatTimer);
      scheduleReconnect();
    };
  };

  connect();

  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(heartbeatTimer);
    source?.close();
  };
}

function parseEvent(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return {
      topic: event.type,
      raw: event.data
    };
  }
}
