export const PROCESS_REJECTION_WARNING_MS = 24 * 60 * 60 * 1000;

/** Request failures must remain observable without dropping unrelated requests. */
export function createProcessRejectionMonitor({ logger, metrics, now = Date.now }) {
  const counter = metrics.counter("process_unhandled_rejections_total", "Unhandled promise rejections observed by the HTTP process.");
  counter.inc({}, 0);
  let count = 0;
  let lastAtMs;
  let lastMessage;

  function onUnhandledRejection(reason) {
    const err = serializeRejection(reason);
    count += 1;
    lastAtMs = now();
    lastMessage = err.message;
    // Keep diagnostics independent: a broken sink must not disable the warning.
    try { counter.inc(); } catch { /* The in-memory health warning remains. */ }
    try { logger.error({ err }, "process.unhandled_rejection"); } catch {
      // Do not throw from the last-resort rejection listener.
      try { process.stderr.write(`${JSON.stringify({ level: "error", msg: "process.unhandled_rejection", err })}\n`); } catch { /* No usable log sink. */ }
    }
  }

  function getWarnings() {
    if (lastAtMs === undefined || now() - lastAtMs >= PROCESS_REJECTION_WARNING_MS) return [];
    return [{
      code: "process_unhandled_rejection",
      severity: "critical",
      message: "The HTTP process observed an unhandled promise rejection within the last 24 hours.",
      count,
      lastAt: new Date(lastAtMs).toISOString(),
      lastMessage
    }];
  }
  return { onUnhandledRejection, getWarnings };
}

function serializeRejection(reason) {
  const field = (key) => {
    try {
      const value = reason?.[key];
      return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
    } catch { return undefined; }
  };
  let fallback;
  try { fallback = String(reason); } catch { fallback = "Unserializable rejection reason"; }
  return {
    name: field("name") ?? "UnhandledRejection",
    message: field("message") ?? fallback,
    code: field("code") ?? null,
    stack: field("stack") ?? null
  };
}
