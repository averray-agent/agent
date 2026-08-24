import { matchesFilter } from "./event-bus.js";

export function listEventLogFromRecords(records, filter = {}) {
  // Durable operator reads may need a complete 48-hour lifecycle window.
  // Public routes still apply their own lower request caps before reaching
  // this store helper.
  const limit = normalizeListLimit(filter.limit, 100, 5_000);
  const lastEventId = String(filter.lastEventId ?? "").trim();
  const cursorIndex = lastEventId
    ? records.findIndex((event) => event.id === lastEventId)
    : -1;
  const scoped = cursorIndex >= 0
    ? records.slice(cursorIndex + 1)
    : records;
  const filtered = scoped.filter((event) => matchesFilter(event, filter));
  return {
    events: lastEventId ? filtered.slice(0, limit) : filtered.slice(-limit),
    gap: Boolean(lastEventId && cursorIndex === -1 && records.length > 0)
  };
}

export function normalizeListLimit(value, fallback, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}
