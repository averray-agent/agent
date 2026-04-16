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
  const params = new URLSearchParams();
  if (wallet) params.set("wallet", wallet);
  if (sessionId) params.set("sessionId", sessionId);
  if (jobId) params.set("jobId", jobId);
  if (topics.length) params.set("topics", topics.join(","));

  // EventSource cannot set custom headers, so authentication piggy-backs on a
  // short-lived JWT passed via ?token=. See mcp-server/src/auth/middleware.js
  // which accepts this when the route is opened with `allowQueryToken: true`.
  const token = getAuthToken();
  if (token) params.set("token", token);

  const source = new EventSource(`/api/events?${params.toString()}`);
  let reauthInFlight = false;

  for (const topic of EVENT_TOPICS) {
    source.addEventListener(topic, (event) => {
      const payload = parseEvent(event);
      if (topic === "gap") {
        onGap?.(payload);
        return;
      }
      onEvent?.(payload);
    });
  }

  source.onerror = (event) => {
    // EventSource masks HTTP status (401 shows up as a generic error with the
    // stream in CLOSED state). Best-effort heuristic: if we had a token and the
    // stream is closed, assume the token expired mid-session and kick off a
    // re-auth → caller is expected to restart the stream from its auth-change
    // listener.
    if (source.readyState === EventSource.CLOSED && token && !reauthInFlight) {
      reauthInFlight = true;
      requestReauth("sse_closed").catch((error) => {
        console.warn("[events] re-auth failed after SSE close", error);
      });
    }
    onError?.(event);
  };

  return () => {
    source.close();
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
