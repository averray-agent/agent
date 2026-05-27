/**
 * Hermes Handoff Monitor — pure cache-patching for live updates.
 *
 * Single pure function `applyEventToBoard(prev, event)` that takes
 * the current board snapshot + a single MonitorEvent and returns a
 * new snapshot with the event applied. Used by the SWR hook to
 * patch the cache without a full refetch when SSE events arrive.
 *
 * Pulled out of the React hook so node:test can cover the patch
 * matrix (every event type × every edge case) without a renderer.
 */

/**
 * @typedef {import("./card-types.js").BoardCard} BoardCard
 */

/**
 * @typedef {Object} MonitorBoard
 * @property {BoardCard[]} cards
 * @property {string} at  — ISO timestamp from the server
 */

/**
 * Apply a single live event to a board snapshot. Returns a NEW
 * board object — never mutates the input. If the event is
 * unrecognized or the cache cannot meaningfully be updated (e.g.
 * an update event for a card we don't have yet), the previous
 * snapshot is returned unchanged so SWR's cache doesn't churn.
 *
 * @param {MonitorBoard | undefined} prev
 * @param {{ type: string } & Record<string, unknown>} event
 * @returns {MonitorBoard | undefined}
 */
export function applyEventToBoard(prev, event) {
  if (!event || typeof event.type !== "string") return prev;
  switch (event.type) {
    case "board.snapshot": {
      const cards = Array.isArray(event.cards) ? /** @type {BoardCard[]} */ (event.cards) : [];
      const at = typeof event.at === "string" ? event.at : new Date().toISOString();
      return { cards, at };
    }
    case "board.card.added": {
      if (!prev) return prev;
      const card = /** @type {BoardCard | undefined} */ (event.card);
      if (!card?.id) return prev;
      const idx = prev.cards.findIndex((c) => c.id === card.id);
      // Idempotent: if the card already exists, treat as update.
      if (idx >= 0) {
        const next = prev.cards.slice();
        next[idx] = card;
        return { cards: next, at: typeof event.at === "string" ? event.at : prev.at };
      }
      return {
        cards: [...prev.cards, card],
        at: typeof event.at === "string" ? event.at : prev.at,
      };
    }
    case "board.card.updated": {
      if (!prev) return prev;
      const id = /** @type {string | undefined} */ (event.id);
      if (!id) return prev;
      const partial = /** @type {Partial<BoardCard>} */ (event.partial ?? {});
      const idx = prev.cards.findIndex((c) => c.id === id);
      if (idx < 0) return prev;
      const next = prev.cards.slice();
      next[idx] = { ...next[idx], ...partial, id };
      return { cards: next, at: typeof event.at === "string" ? event.at : prev.at };
    }
    case "board.card.moved": {
      if (!prev) return prev;
      const id = /** @type {string | undefined} */ (event.id);
      const toLane = /** @type {string | undefined} */ (event.toLane);
      if (!id || !toLane) return prev;
      const idx = prev.cards.findIndex((c) => c.id === id);
      if (idx < 0) return prev;
      const next = prev.cards.slice();
      next[idx] = { ...next[idx], lane: toLane };
      return { cards: next, at: typeof event.at === "string" ? event.at : prev.at };
    }
    case "board.card.archived": {
      if (!prev) return prev;
      const id = /** @type {string | undefined} */ (event.id);
      if (!id) return prev;
      return {
        cards: prev.cards.filter((c) => c.id !== id),
        at: typeof event.at === "string" ? event.at : prev.at,
      };
    }
    case "stream.keepalive":
      // Keepalive doesn't change the cache; UI surfaces it via
      // streamStatus instead.
      return prev;
    default:
      // Unknown event type — log-and-skip would be nicer, but the
      // pure function shouldn't depend on a logger. SWR cache
      // stays untouched, which is the safe default.
      return prev;
  }
}
