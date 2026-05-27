/**
 * Hermes Handoff Monitor — SSE client + reconnect strategy.
 *
 * Browser-side `EventSource` wrapper that:
 *   - opens a connection to /api/monitor/stream
 *   - emits MonitorEvent objects on .on(handler)
 *   - reconnects with exponential backoff on close/error
 *   - on reconnect, the subscriber receives a fresh `board.snapshot`
 *     from the server (the service replays state on subscribe)
 *
 * Per §5 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.
 *
 * Pure-logic decisions (backoff math, status enum) live here as
 * exported helpers so node:test can lock the contract without a
 * DOM. The actual `EventSource` instantiation is owned by the
 * `LiveStream` class below — that side is exercised by the M4 smoke
 * test, not the unit tests.
 */

/**
 * @typedef {"idle" | "connecting" | "open" | "reconnecting" | "closed"} StreamStatus
 */

/**
 * @typedef {(
 *   | { type: "board.snapshot",      cards: unknown[], at: string }
 *   | { type: "board.card.added",    card: unknown, at: string }
 *   | { type: "board.card.updated",  id: string, partial: unknown, at: string }
 *   | { type: "board.card.moved",    id: string, fromLane: string, toLane: string, at: string }
 *   | { type: "board.card.archived", id: string, reason: string, at: string }
 *   | { type: "stream.keepalive",    at: string }
 * )} MonitorEvent
 */

/**
 * Exponential-backoff schedule for SSE reconnect attempts. Doubles
 * each step, capped at 30s. Per §5 of the spec.
 *
 *   attempt 0 → 0     (immediate first connect)
 *   attempt 1 → 1000
 *   attempt 2 → 2000
 *   attempt 3 → 4000
 *   attempt 4 → 8000
 *   attempt 5+ → 30000  (cap)
 *
 * @param {number} attempt 0-based attempt number
 * @returns {number} delay in ms
 */
export function backoffDelayMs(attempt) {
  if (!Number.isFinite(attempt) || attempt <= 0) return 0;
  const ms = 500 * Math.pow(2, attempt);
  return Math.min(ms, 30_000);
}

export const RECONNECT_CAP_MS = 30_000;

/**
 * The state machine that drives the LIVE indicator. UI reads this
 * to color the indicator (green=open, amber=connecting, rose=closed
 * with retry pending).
 *
 * @param {"connect" | "open" | "error" | "close"} event
 * @param {StreamStatus} current
 * @returns {StreamStatus}
 */
export function nextStatus(event, current) {
  if (event === "connect") {
    return current === "open" ? "open" : "connecting";
  }
  if (event === "open") {
    return "open";
  }
  if (event === "error") {
    // An error in `open` state means the connection dropped and
    // we're going to reconnect. From any other state, the error
    // means the connect attempt failed — same reconnect plan.
    return "reconnecting";
  }
  if (event === "close") {
    return "closed";
  }
  return current;
}

/**
 * @typedef {Object} LiveStreamOptions
 * @property {string} [url] full URL (or path) of the SSE endpoint.
 *   Default "/api/monitor/stream".
 * @property {string} [token] auth token; appended as ?token= query
 *   param (EventSource cannot send Authorization headers).
 * @property {() => number} [now] clock injection for tests.
 * @property {{ info: Function, warn: Function, error: Function }} [logger]
 * @property {typeof EventSource} [EventSourceCtor] dependency-inject
 *   for tests / non-browser environments.
 */

/**
 * Connect to the monitor SSE stream and dispatch events to
 * registered handlers. Subscribers receive every event the server
 * sends, including the initial `board.snapshot` on each new
 * connection (so a reconnect catches the client up automatically).
 *
 * This class is browser-side only; the unit tests cover the pure
 * helpers above (backoffDelayMs, nextStatus). The class itself is
 * covered by the M4 frontend smoke test.
 */
export class LiveStream {
  /**
   * @param {LiveStreamOptions} [opts]
   */
  constructor(opts = {}) {
    this.url = opts.url ?? "/api/monitor/stream";
    this.token = opts.token;
    this.logger = opts.logger ?? { info() {}, warn() {}, error() {} };
    this.EventSourceCtor =
      opts.EventSourceCtor ??
      (typeof globalThis !== "undefined" ? globalThis.EventSource : undefined);
    /** @type {StreamStatus} */
    this.status = "idle";
    this.attempt = 0;
    /** @type {Set<(event: MonitorEvent) => void>} */
    this.handlers = new Set();
    /** @type {Set<(status: StreamStatus) => void>} */
    this.statusHandlers = new Set();
    /** @type {EventSource | undefined} */
    this.source = undefined;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.reconnectTimer = undefined;
    this.stopped = false;
  }

  /** Open the connection (or schedule a reconnect if already open). */
  start() {
    this.stopped = false;
    this.#openConnection();
  }

  /** Close the connection and stop reconnecting. */
  stop() {
    this.stopped = true;
    this.#setStatus("closed");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.source) {
      try {
        this.source.close();
      } catch {
        /* already closed */
      }
      this.source = undefined;
    }
  }

  /**
   * Register an event handler. Returns an unsubscribe function.
   * @param {(event: MonitorEvent) => void} handler
   */
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Register a status-change handler. Useful for the LIVE indicator.
   * @param {(status: StreamStatus) => void} handler
   */
  onStatus(handler) {
    this.statusHandlers.add(handler);
    handler(this.status);  // fire immediately so the UI starts in sync
    return () => this.statusHandlers.delete(handler);
  }

  // ── internals ──────────────────────────────────────────────────

  #openConnection() {
    if (!this.EventSourceCtor) {
      this.logger.warn?.("LiveStream: no EventSource constructor available; running in no-op mode");
      this.#setStatus("closed");
      return;
    }
    if (this.source) {
      try {
        this.source.close();
      } catch {
        /* ignore */
      }
    }
    this.#setStatus("connecting");
    const url = this.token ? `${this.url}?token=${encodeURIComponent(this.token)}` : this.url;
    const src = new this.EventSourceCtor(url);
    this.source = src;

    src.onopen = () => {
      this.attempt = 0;
      this.#setStatus("open");
    };

    src.onerror = () => {
      // EventSource will auto-reconnect by default, but its built-in
      // backoff is not transparent and doesn't expose status. We
      // close it and reconnect manually so the LIVE indicator and
      // backoff are observable.
      try {
        src.close();
      } catch {
        /* ignore */
      }
      this.source = undefined;
      if (this.stopped) return;
      this.#setStatus("reconnecting");
      const delay = backoffDelayMs(++this.attempt);
      this.logger.warn?.(`LiveStream: reconnect in ${delay}ms (attempt ${this.attempt})`);
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped) this.#openConnection();
      }, delay);
    };

    src.onmessage = (e) => {
      this.#dispatchRaw(e);
    };

    // Named SSE events come through addEventListener, not onmessage.
    // We attach a generic listener that forwards by topic.
    const NAMED_EVENTS = [
      "board.snapshot",
      "board.card.added",
      "board.card.updated",
      "board.card.moved",
      "board.card.archived",
      "stream.keepalive",
    ];
    for (const name of NAMED_EVENTS) {
      src.addEventListener(name, (e) => this.#dispatchRaw(e));
    }
  }

  /** @param {MessageEvent} e */
  #dispatchRaw(e) {
    if (!e || typeof e.data !== "string") return;
    let parsed;
    try {
      parsed = JSON.parse(e.data);
    } catch (err) {
      this.logger.warn?.({ err }, "LiveStream: failed to parse SSE event payload");
      return;
    }
    for (const h of this.handlers) {
      try {
        h(parsed);
      } catch (err) {
        this.logger.warn?.({ err }, "LiveStream: subscriber threw");
      }
    }
  }

  /** @param {StreamStatus} status */
  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    for (const h of this.statusHandlers) {
      try {
        h(status);
      } catch (err) {
        this.logger.warn?.({ err }, "LiveStream: status subscriber threw");
      }
    }
  }
}
