import { isTerminalSessionStatus } from "./human-work.js";

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 90_000;
export const DEFAULT_VERIFICATION_POLL_MS = 3_000;

export async function watchSessionToTerminal({
  sessionId,
  fetcher,
  timeoutMs = DEFAULT_VERIFICATION_TIMEOUT_MS,
  pollMs = DEFAULT_VERIFICATION_POLL_MS,
  now = () => Date.now(),
  sleep = delay,
  signal,
  onUpdate = (_update) => {}
}) {
  const startedAt = now();
  let lastSession = null;
  let lastError = null;
  while (now() - startedAt < timeoutMs) {
    if (signal?.aborted) return { status: "aborted", session: lastSession };
    try {
      lastSession = await fetcher(`/session?sessionId=${encodeURIComponent(sessionId)}`);
      lastError = null;
      onUpdate({ status: "polling", session: lastSession });
      if (isTerminalSessionStatus(lastSession?.status ?? lastSession?.state)) {
        return { status: "terminal", session: lastSession };
      }
    } catch (error) {
      lastError = error;
      onUpdate({ status: "retrying", session: lastSession, error });
    }
    await sleep(pollMs, signal);
  }
  return {
    status: "stalled",
    session: lastSession,
    error: lastError,
    message: "Verification is taking longer than expected. Nothing has been marked complete. Retry the status check."
  };
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
