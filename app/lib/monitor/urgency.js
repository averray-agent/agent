/**
 * Hermes Handoff Monitor — freshness / staleness math.
 *
 * Pure functions for turning a raw freshness value (minutes since the
 * card entered its current lane) into the visual variants the cards
 * render: fresh, warm, stale, ancient, archive-suggest.
 *
 * Thresholds match the bundle's `data.jsx` / `states.jsx` cards:
 *   <  5 min  → fresh    (full saturation; "this just happened")
 *   <  30 min → warm     (still actionable, no urgency decoration)
 *   <  4 h    → settling (default appearance)
 *   <  24 h   → stale    (desaturated, "stale Xh" badge)
 *   ≥ 48 h    → ancient  (archive-suggestion eligible)
 *
 * The card's stored `state` field can override these — a stored
 * "failed-fetch" beats any freshness math because the data we'd
 * compute freshness against is itself untrustworthy.
 *
 * Per §13 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.
 */

/**
 * @typedef {import("./card-types.js").BoardCard} BoardCard
 * @typedef {import("./card-types.js").CardState} CardState
 */

/**
 * Visual freshness tiers. Distinct from the stored `state` field
 * (fresh / stale / failed-fetch / source-offline / running) — those
 * are sourced from the server. This enum is derived purely from the
 * `freshness` number and is what the card-shell CSS variants pick up.
 *
 * @typedef {"fresh" | "warm" | "settling" | "stale" | "ancient"} FreshnessTier
 */

export const FRESH_THRESHOLD_MINUTES = 5;
export const WARM_THRESHOLD_MINUTES = 30;
export const SETTLING_THRESHOLD_MINUTES = 4 * 60;
export const STALE_THRESHOLD_MINUTES = 24 * 60;
export const ARCHIVE_HINT_THRESHOLD_MINUTES = 48 * 60;

/**
 * Classify a numeric freshness (minutes since lane entry) into a tier.
 *
 * @param {number | null | undefined} minutes
 * @returns {FreshnessTier}
 */
export function freshnessTier(minutes) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    // Unknown / negative — default to settling so the card renders
    // calmly rather than claiming "fresh" or "stale" we can't prove.
    return "settling";
  }
  if (minutes < FRESH_THRESHOLD_MINUTES) return "fresh";
  if (minutes < WARM_THRESHOLD_MINUTES) return "warm";
  if (minutes < SETTLING_THRESHOLD_MINUTES) return "settling";
  if (minutes < STALE_THRESHOLD_MINUTES) return "stale";
  return "ancient";
}

/**
 * Should the card show an "archive?" suggestion? True for cards that
 * have been sitting in their lane >= 48h and aren't already in done.
 * The actual archive operation is server-side; this is just the UI
 * hint.
 *
 * @param {BoardCard | undefined | null} card
 * @returns {boolean}
 */
export function shouldSuggestArchive(card) {
  if (!card) return false;
  if (card.lane === "done") return false;          // already archived
  if (card.isDraft) return false;                  // drafts age differently
  if (card.isAction) return false;                 // action items don't archive
  if (card.archiveHint === true) return true;      // server-set hint always wins
  const tier = freshnessTier(card.freshness);
  return tier === "ancient";
}

/**
 * Compact human-readable freshness label, matching the bundle's
 * `fmtFresh` helper.
 *
 *   3       → "3M"
 *   59      → "59M"
 *   60      → "1H"
 *   90      → "1.5H"
 *   600     → "10H"
 *   2880    → "2D"
 *   10080   → "7D"
 *
 * @param {number | null | undefined} minutes
 * @returns {string | null}
 */
export function formatFreshness(minutes) {
  if (minutes === null || minutes === undefined) return null;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    return null;
  }
  if (minutes < 60) return `${Math.round(minutes)}M`;
  const hours = minutes / 60;
  if (hours < 48) {
    const formatted = hours < 10 ? hours.toFixed(1) : `${Math.round(hours)}`;
    return `${formatted.replace(/\.0$/, "")}H`;
  }
  const days = hours / 24;
  const formatted = days < 10 ? days.toFixed(1) : `${Math.round(days)}`;
  return `${formatted.replace(/\.0$/, "")}D`;
}

/**
 * Sort cards by next-action urgency. Lower index = should-look-at-this-first.
 *
 * Priority order (most urgent first):
 *   1. action cards (isAction true) — operator must look
 *   2. fail-state cards (CI failed, deploy failed, mission FAILED)
 *   3. waiting-on-operator with warn tone
 *   4. fresh > warm > settling
 *   5. stale + ancient last (deprioritized; these would normally be archived)
 *
 * Within a tier, fall back to the freshness number ascending (more
 * recent first).
 *
 * @param {BoardCard[]} cards
 * @returns {BoardCard[]} a new array, sorted (does not mutate input)
 */
export function sortByUrgency(cards) {
  if (!Array.isArray(cards)) return [];
  return [...cards].sort((a, b) => urgencyRank(a) - urgencyRank(b) || compareFreshness(a, b));
}

/**
 * Numeric urgency rank — lower = more urgent. Exposed so tests and
 * higher-level selectors can reason about the order.
 *
 * @param {BoardCard | undefined | null} card
 * @returns {number}
 */
export function urgencyRank(card) {
  if (!card) return 100;
  if (card.isAction) return 0;
  if (card.checks && card.checks.fail > 0) return 1;
  if (card.waitingOn?.actor === "operator" && card.waitingOn?.tone === "warn") return 2;
  const tier = freshnessTier(card.freshness);
  if (tier === "fresh") return 10;
  if (tier === "warm") return 20;
  if (tier === "settling") return 30;
  if (tier === "stale") return 40;
  return 50;  // ancient
}

/**
 * @param {BoardCard} a
 * @param {BoardCard} b
 * @returns {number}
 */
function compareFreshness(a, b) {
  const af = typeof a.freshness === "number" ? a.freshness : Infinity;
  const bf = typeof b.freshness === "number" ? b.freshness : Infinity;
  return af - bf;
}
