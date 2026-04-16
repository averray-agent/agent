import { getAuthToken, requestReauth } from "./auth.js";

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

export function startEventStream({ wallet, sessionId, jobId, topics = [], onEvent, onGap, onError }) {
  let source = undefined;
  let stopped = false;
  let reconnectDelayMs = 1000;
  let reconnectTimer = undefined;
  let lastEventId = "";
  let reauthInFlight = false;

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

    for (const topic of EVENT_TOPICS) {
      source.addEventListener(topic, (event) => {
        if (event.lastEventId) {
          lastEventId = event.lastEventId;
        }
        reconnectDelayMs = 1000;
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
            console.warn("[events] re-auth failed after SSE close", error);
          })
          .finally(() => {
            reauthInFlight = false;
          });
      }
      source?.close();
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
    };
  };

  connect();

  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
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
