"use client";

/**
 * Shared snapshot of the SSE event stream: connection state plus a small
 * ring buffer of the most recent events. LiveDataBridge (the single
 * stream owner) writes; surfaces like PlatformPulse read via
 * useSyncExternalStore.
 *
 * Exists so the overview can tell the truth about the stream: before
 * this, the pulse card rendered a hardcoded empty list as "No live
 * events" even while the underlying connection was failing (503) —
 * conflating "quiet" with "down".
 */

export type StreamState = "off" | "connecting" | "open" | "reconnecting" | "stalled";

export interface StreamEventRecord {
  topic: string;
  data: unknown;
  id?: string;
  /** Client receive time (ms epoch) — display only. */
  at: number;
}

export interface StreamSnapshot {
  state: StreamState;
  events: StreamEventRecord[];
}

const MAX_EVENTS = 30;

const INITIAL: StreamSnapshot = { state: "off", events: [] };

let snapshot: StreamSnapshot = INITIAL;
const listeners = new Set<() => void>();

function emit(next: StreamSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function reportStreamState(state: StreamState) {
  if (snapshot.state === state) return;
  emit({ ...snapshot, state });
}

export function recordStreamEvent(event: Omit<StreamEventRecord, "at">) {
  emit({
    // Receiving an event proves the stream is open regardless of the
    // last reported transition.
    state: "open",
    events: [{ ...event, at: Date.now() }, ...snapshot.events].slice(0, MAX_EVENTS),
  });
}

export function resetStream() {
  emit(INITIAL);
}

export function subscribeStream(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStreamSnapshot(): StreamSnapshot {
  return snapshot;
}

/** Stable server-render snapshot for useSyncExternalStore. */
export function getStreamServerSnapshot(): StreamSnapshot {
  return INITIAL;
}
