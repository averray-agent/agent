/**
 * Hermes Handoff Monitor — drawer URL-routing helpers.
 *
 * Pure functions for encoding/decoding the focused-card id in the
 * URL query string. The board page reads `?card=<id>` to decide
 * whether to mount the detail drawer; clicking a card sets it;
 * pressing esc clears it.
 *
 * Card ids include spaces and hash characters (e.g. "agent #548",
 * "mission browser-onboard-04"), so encoding has to be URL-safe.
 *
 * Per §11 of docs/HERMES_MONITOR_REDESIGN_SPEC.md — view state
 * lives in URL params so reload + share-link work without extra
 * state plumbing.
 */

/**
 * Encode a card id into a URL-safe value suitable for the
 * `?card=` query param. Returns null for empty/non-string input
 * so the caller can decide whether to drop the param entirely.
 *
 * @param {string | undefined | null} id
 * @returns {string | null}
 */
export function encodeCardParam(id) {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return encodeURIComponent(trimmed);
}

/**
 * Decode a card id read from the URL query string. Returns null
 * if the value is missing or empty after trimming.
 *
 * @param {string | null | undefined} raw  the value of `?card=`
 *   from URLSearchParams (already URL-decoded by the search-params
 *   accessor — we just trim + validate)
 * @returns {string | null}
 */
export function decodeCardParam(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Find the index of a card id in an ordered list of cards. Returns
 * -1 if absent. Used by j/k traversal inside the drawer to find
 * the next/previous card.
 *
 * @param {{ id: string }[]} cards
 * @param {string | null | undefined} focusedId
 * @returns {number}
 */
export function indexOfCard(cards, focusedId) {
  if (!Array.isArray(cards) || !focusedId) return -1;
  for (let i = 0; i < cards.length; i += 1) {
    if (cards[i]?.id === focusedId) return i;
  }
  return -1;
}

/**
 * Pick the next card id for j/k traversal. Direction can be:
 *   - "next" (j or ArrowDown — advance forward)
 *   - "prev" (k or ArrowUp — move backward)
 *
 * Wraps at the ends: pressing "next" on the last card stays on it
 * (no wrap-around to the start; that would be disorienting). Same
 * for "prev" at index 0.
 *
 * @param {{ id: string }[]} cards
 * @param {string | null | undefined} focusedId
 * @param {"next" | "prev"} direction
 * @returns {string | null}
 */
export function traverseDrawerCard(cards, focusedId, direction) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const idx = indexOfCard(cards, focusedId);
  if (idx < 0) {
    // No current focus — start at the first card.
    return cards[0]?.id ?? null;
  }
  if (direction === "next") {
    const nextIdx = Math.min(idx + 1, cards.length - 1);
    return cards[nextIdx]?.id ?? null;
  }
  if (direction === "prev") {
    const prevIdx = Math.max(idx - 1, 0);
    return cards[prevIdx]?.id ?? null;
  }
  return focusedId ?? null;
}
