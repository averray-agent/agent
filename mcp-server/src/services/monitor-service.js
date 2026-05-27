/**
 * Hermes Handoff Monitor — backend service.
 *
 * Owns the in-memory board state + the SSE event bus that streams
 * card mutations to connected clients. M4 milestone of the monitor
 * redesign (see docs/HERMES_MONITOR_REDESIGN_SPEC.md).
 *
 * For M4, the board state is seeded from `monitor-fixtures.js` —
 * the same 9-card / 11-done mix the operator app's `fixtures.ts`
 * used in M3. M5+ progressively replace the fixture source with
 * real GitHub / Codex / Hermes / deploy reads.
 *
 * Event bus contract (matches §7 of the spec):
 *   - subscribers receive an async iterator of MonitorEvent objects
 *   - on subscribe, the service replays the current board snapshot
 *     as a single `board.snapshot` event so the client starts in
 *     sync
 *   - mutations emit `board.card.{added,updated,moved,archived}`
 *
 * The service is intentionally framework-free: it's a small
 * EventEmitter-shaped class that's owned by the HTTP route layer
 * (monitor-routes.js wraps it as SSE) and the future MCP tool layer
 * could attach in the same way.
 */

import { EventEmitter } from "node:events";
import { FIXTURE_CARDS } from "./monitor-fixtures.js";

/**
 * @typedef {import("../../core/types.js").BoardCard} BoardCard
 */

/**
 * @typedef {(
 *   | { type: "board.snapshot",      cards: BoardCard[],  at: string }
 *   | { type: "board.card.added",    card: BoardCard,     at: string }
 *   | { type: "board.card.updated",  id: string, partial: Partial<BoardCard>, at: string }
 *   | { type: "board.card.moved",    id: string, fromLane: string, toLane: string, at: string }
 *   | { type: "board.card.archived", id: string, reason: string, at: string }
 *   | { type: "stream.keepalive",    at: string }
 * )} MonitorEvent
 */

const KEEPALIVE_INTERVAL_MS = 25_000;

export class MonitorService {
  /**
   * @param {{
   *   logger?: { info: Function, warn: Function, error: Function },
   *   initialCards?: BoardCard[],
   *   now?: () => Date,
   * }} [opts]
   */
  constructor({ logger, initialCards, now } = {}) {
    this.logger = logger ?? { info() {}, warn() {}, error() {} };
    this.now = now ?? (() => new Date());
    /** @type {Map<string, BoardCard>} */
    this.cards = new Map();
    /** @type {EventEmitter} */
    this.bus = new EventEmitter();
    // Lift the listener cap — SSE clients each register one.
    this.bus.setMaxListeners(0);

    for (const card of initialCards ?? FIXTURE_CARDS) {
      this.cards.set(card.id, card);
    }
  }

  /**
   * Return the full board snapshot — every card the service holds.
   * Cheap; just a copy of the in-memory map.
   *
   * @returns {{ cards: BoardCard[], at: string }}
   */
  getBoardSnapshot() {
    return {
      cards: [...this.cards.values()],
      at: this.now().toISOString(),
    };
  }

  /**
   * Resolve a single card by id, or undefined if unknown.
   *
   * @param {string} id
   * @returns {BoardCard | undefined}
   */
  getCard(id) {
    return this.cards.get(id);
  }

  /**
   * Add a new card and emit `board.card.added`.
   *
   * @param {BoardCard} card
   */
  addCard(card) {
    if (this.cards.has(card.id)) {
      // Idempotent — treat as update.
      this.updateCard(card.id, card);
      return;
    }
    this.cards.set(card.id, card);
    this.#emit({ type: "board.card.added", card, at: this.now().toISOString() });
  }

  /**
   * Patch an existing card and emit `board.card.updated`.
   *
   * @param {string} id
   * @param {Partial<BoardCard>} partial
   */
  updateCard(id, partial) {
    const existing = this.cards.get(id);
    if (!existing) return;
    const next = { ...existing, ...partial, id };
    this.cards.set(id, next);
    this.#emit({ type: "board.card.updated", id, partial, at: this.now().toISOString() });
  }

  /**
   * Move a card to a different lane. Emits `board.card.moved` so the
   * client can animate the transition rather than blink-replace.
   *
   * @param {string} id
   * @param {string} toLane
   */
  moveCard(id, toLane) {
    const existing = this.cards.get(id);
    if (!existing) return;
    const fromLane = existing.lane;
    if (fromLane === toLane) return;
    this.cards.set(id, { ...existing, lane: toLane });
    this.#emit({
      type: "board.card.moved",
      id,
      fromLane,
      toLane,
      at: this.now().toISOString(),
    });
  }

  /**
   * Drop a card from the board with a reason string. Emits
   * `board.card.archived` so connected clients animate the removal.
   *
   * @param {string} id
   * @param {string} reason
   */
  archiveCard(id, reason) {
    if (!this.cards.has(id)) return;
    this.cards.delete(id);
    this.#emit({ type: "board.card.archived", id, reason, at: this.now().toISOString() });
  }

  /**
   * Subscribe to monitor events. The handler is invoked each time an
   * event fires; the returned function unsubscribes.
   *
   * The subscriber receives a single `board.snapshot` event on
   * subscribe so it starts in sync with the current state.
   *
   * A subscriber that throws is isolated: the error is logged and
   * other subscribers (plus the rest of subscribe's setup) continue
   * normally. This matters for SSE clients whose request handler
   * might disconnect mid-emit and fail to write.
   *
   * @param {(event: MonitorEvent) => void} handler
   * @returns {() => void} unsubscribe
   */
  subscribe(handler) {
    const safeHandler = (/** @type {MonitorEvent} */ event) => {
      try {
        handler(event);
      } catch (err) {
        this.logger.warn?.(
          { err: err instanceof Error ? err.message : err, type: event.type },
          "monitor_service_subscriber_threw"
        );
      }
    };
    safeHandler({
      type: "board.snapshot",
      cards: [...this.cards.values()],
      at: this.now().toISOString(),
    });
    this.bus.on("event", safeHandler);
    return () => {
      this.bus.off("event", safeHandler);
    };
  }

  /**
   * Number of active subscribers — useful for the route's metrics
   * and for graceful-shutdown logic.
   */
  get subscriberCount() {
    return this.bus.listenerCount("event");
  }

  /**
   * Emit a keepalive event to all subscribers. SSE keepalives stop
   * intermediary proxies from closing the connection during idle
   * periods. Route layer calls this on an interval.
   */
  emitKeepalive() {
    this.#emit({ type: "stream.keepalive", at: this.now().toISOString() });
  }

  /** @param {MonitorEvent} event @returns {void} */
  #emit(event) {
    try {
      this.bus.emit("event", event);
    } catch (err) {
      this.logger.warn?.({ err, type: event.type }, "monitor_service_emit_failed");
    }
  }
}

export const MONITOR_KEEPALIVE_INTERVAL_MS = KEEPALIVE_INTERVAL_MS;
