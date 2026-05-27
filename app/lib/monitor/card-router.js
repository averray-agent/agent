/**
 * Hermes Handoff Monitor — card-render dispatch logic.
 *
 * Pure-logic helper that decides which renderer a given card should
 * use:
 *   - "card"     → the unified `<Card />` component (fresh, stale,
 *                  running, done — anything where the live shape
 *                  is trustworthy)
 *   - "degraded" → the `<DegradedCard />` component (failed-fetch
 *                  or source-offline — the upstream data is suspect)
 *
 * Pulled out of the React component so node:test can lock the
 * dispatch contract without a renderer. The actual JSX wrapping
 * happens in `<CardRouter />` inside the React tree.
 *
 * Per §14 (a11y) of the spec, the dispatch is the gate that
 * enforces "we never silently fall back to a fresh-looking card
 * when the data is broken."
 */

/**
 * @typedef {import("./card-types.js").BoardCard} BoardCard
 */

/**
 * @typedef {"card" | "degraded"} CardRenderer
 */

/**
 * @param {BoardCard | undefined | null} card
 * @returns {CardRenderer}
 */
export function pickRenderer(card) {
  if (!card) return "card";
  if (card.state === "failed-fetch") return "degraded";
  if (card.state === "source-offline") return "degraded";
  return "card";
}

/**
 * Build the default body / pills / action for a degraded card from
 * the card's metadata. The bundle's states.jsx hand-tuned these per
 * card type; here we provide reasonable defaults so live data can
 * still render before the per-type copy lands.
 *
 * Per-type overrides (mission has "Fresh run" as the retry action;
 * deploy has "View raw logs"; etc.) come in later milestones when
 * the API actually returns degraded payloads with reason codes.
 *
 * @param {BoardCard} card
 * @returns {{ body: string, pills: Array<[string, string]>, action: string }}
 */
export function defaultDegradedContent(card) {
  if (card.state === "source-offline") {
    return {
      body: `Upstream unreachable. This card is the last successful read; values may be stale. Hermes is not paging until the upstream returns.`,
      pills: [
        ["hm-pill--offline", "source · offline"],
        ["hm-pill--neutral", "cached"],
      ],
      action: "View last known",
    };
  }
  // failed-fetch
  return {
    body: `Upstream returned an error. The card may have been removed, force-pushed, or the source temporarily unavailable.`,
    pills: [
      ["hm-pill--err", "fetch failed"],
      ["hm-pill--neutral", "retry available"],
    ],
    action: "Retry now",
  };
}
