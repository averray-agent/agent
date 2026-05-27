/**
 * Hermes Handoff Monitor — lane derivation.
 *
 * Single pure function `laneFor(card)` that decides which lane a
 * card belongs in. This is the routing logic for every card on the
 * board; UI components must call this rather than reading
 * `card.lane` directly (the stored lane can lag behind the
 * authoritative classification when, for example, an `isAction`
 * card has been promoted from "operator-review" → "needs-attention").
 *
 * Per the design spec (§6 of docs/HERMES_MONITOR_REDESIGN_SPEC.md):
 *   - isAction always wins (a card needing the operator is its
 *     own lane regardless of what type it is)
 *   - drafts come next (an unfinished draft stays out of the work
 *     queues even if it has, say, failing checks)
 *   - codex tasks live in codex-needed
 *   - deploy verifications live in deploying
 *   - closed cards live in done
 *   - everything else uses its explicit `lane` field, which is set
 *     by Hermes during pre-check
 *
 * Disagreements about classification get litigated in
 * lane-rules.test.mjs, not in components.
 */

/**
 * @typedef {import("./card-types.js").BoardCard} BoardCard
 * @typedef {import("./card-types.js").Lane} Lane
 */

/**
 * @param {BoardCard | undefined | null} card
 * @returns {Lane}
 */
export function laneFor(card) {
  if (!card) return "hermes-checking";

  // isAction is the operator-promoted state: an operator-review card
  // that's actively the next thing the operator should look at gets
  // moved out of operator-review and into needs-attention. The lane
  // graduation happens here, not on the server, because the
  // distinction is monitor-UI affordance — the server doesn't know
  // about "needs-attention" as a lane name.
  if (card.isAction) return "needs-attention";

  // Drafts stay out of the work queues entirely. A draft card can
  // legitimately have failing CI, a stale review request, or any
  // other "interesting" property; none of those move it into
  // operator-review until the author marks it ready.
  if (card.isDraft) return "drafts";

  // Type-based routing for the cards whose lane is intrinsic to
  // their type.
  if (card.type === "task") return "codex-needed";
  if (card.type === "deploy") return "deploying";
  if (card.type === "done") return "done";

  // Everything else: trust the explicit `lane` field. Hermes assigns
  // it on classification; we only override it for the rules above.
  // If a card lacks a lane (shouldn't happen with valid data),
  // default to hermes-checking so it's visible but doesn't claim
  // operator attention.
  return card.lane || "hermes-checking";
}

/**
 * Group an array of cards by lane. Returns an object keyed by lane
 * with an array of cards per lane. Lanes that have no cards still
 * appear in the result with an empty array — UI code can iterate
 * the full LANES list and trust the lookup to return [].
 *
 * @param {BoardCard[]} cards
 * @returns {Record<Lane, BoardCard[]>}
 */
export function groupByLane(cards) {
  /** @type {Record<Lane, BoardCard[]>} */
  const out = {
    "needs-attention": [],
    "drafts": [],
    "codex-needed": [],
    "hermes-checking": [],
    "operator-review": [],
    "release-queue": [],
    "deploying": [],
    "done": [],
  };
  if (!Array.isArray(cards)) return out;
  for (const card of cards) {
    const lane = laneFor(card);
    out[lane].push(card);
  }
  return out;
}

/**
 * Count cards per lane. Convenience for the KPI strip at the top of
 * the board. Returns a flat object — same keys as groupByLane, but
 * the values are counts not arrays.
 *
 * @param {BoardCard[]} cards
 * @returns {Record<Lane, number>}
 */
export function laneCounts(cards) {
  const grouped = groupByLane(cards);
  /** @type {Record<Lane, number>} */
  const out = {
    "needs-attention": grouped["needs-attention"].length,
    "drafts": grouped["drafts"].length,
    "codex-needed": grouped["codex-needed"].length,
    "hermes-checking": grouped["hermes-checking"].length,
    "operator-review": grouped["operator-review"].length,
    "release-queue": grouped["release-queue"].length,
    "deploying": grouped["deploying"].length,
    "done": grouped["done"].length,
  };
  return out;
}
