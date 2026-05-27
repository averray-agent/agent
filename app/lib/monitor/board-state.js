/**
 * Hermes Handoff Monitor — board-level selectors and derived state.
 *
 * Pure functions that turn a raw card list into the things the
 * board UI renders directly: KPI counts for the top strip, the
 * single most urgent action, the boardNowBanner sentence, and the
 * board's overall mode (calm / action / degraded).
 *
 * Per §6 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.
 */

import { groupByLane, laneCounts } from "./lane-rules.js";
import { sortByUrgency } from "./urgency.js";

/**
 * @typedef {import("./card-types.js").BoardCard} BoardCard
 * @typedef {import("./card-types.js").Lane} Lane
 */

/**
 * Top-strip KPI counts. Matches the bundle's `counts` object shape
 * passed to `<TopStrip>`. Lane names map to friendly KPI keys.
 *
 * @typedef {Object} KPICounts
 * @property {number} action      — needs-attention count
 * @property {number} review      — operator-review count
 * @property {number} checking    — hermes-checking count
 * @property {number} queue       — release-queue count
 * @property {number} deploying   — deploying count
 * @property {number} blocked     — cards in a failed-fetch / source-offline state
 * @property {number} done        — done lane count (release history visible today)
 * @property {number} total       — all live cards (excludes done)
 */

/**
 * @typedef {"calm" | "action" | "degraded"} BoardMode
 */

/**
 * Compute the KPI strip counts from a card list. Live counts exclude
 * the done lane; total is "everything that's live right now."
 *
 * @param {BoardCard[]} cards
 * @returns {KPICounts}
 */
export function kpiCounts(cards) {
  const counts = laneCounts(cards);
  const blocked = Array.isArray(cards)
    ? cards.filter((c) => c && (c.state === "failed-fetch" || c.state === "source-offline")).length
    : 0;
  const liveLanes = (
    counts["needs-attention"] +
    counts["drafts"] +
    counts["codex-needed"] +
    counts["hermes-checking"] +
    counts["operator-review"] +
    counts["release-queue"] +
    counts["deploying"]
  );
  return {
    action: counts["needs-attention"],
    review: counts["operator-review"],
    checking: counts["hermes-checking"],
    queue: counts["release-queue"],
    deploying: counts["deploying"],
    blocked,
    done: counts["done"],
    total: liveLanes,
  };
}

/**
 * Pick the single most urgent card on the board, or undefined if the
 * board is calm. Used by `boardNowBanner()` to anchor the hero
 * sentence on a specific work item.
 *
 * @param {BoardCard[]} cards
 * @returns {BoardCard | undefined}
 */
export function mostUrgentCard(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return undefined;
  // Only consider live lanes (skip done).
  const live = cards.filter((c) => c && c.lane !== "done" && c.type !== "done");
  if (live.length === 0) return undefined;
  const [first] = sortByUrgency(live);
  return first;
}

/**
 * Decide the board's overall mode. Drives the TopStrip variant (calm
 * vs degraded) and the BoardNowBanner tone (sage vs amber).
 *
 *   "degraded" — at least one card is in failed-fetch / source-offline
 *                OR the live stream has been told it's offline (the
 *                caller passes streamOnline=false to force this)
 *   "action"   — at least one card is in needs-attention
 *   "calm"     — nothing needs the operator right now
 *
 * @param {BoardCard[]} cards
 * @param {{ streamOnline?: boolean }} [opts]
 * @returns {BoardMode}
 */
export function boardMode(cards, opts = {}) {
  if (opts.streamOnline === false) return "degraded";
  if (!Array.isArray(cards) || cards.length === 0) return "calm";
  const counts = kpiCounts(cards);
  if (counts.blocked > 0) return "degraded";
  if (counts.action > 0) return "action";
  return "calm";
}

/**
 * Compose the BoardNow banner sentence. Returns a structured shape
 * (tone + eyebrow + headline + sub) so the React component can render
 * without re-deriving the prose. Mirrors the bundle's `makeBanner()`
 * shape with `tone: 'action' | 'calm' | 'degraded'`.
 *
 * @param {BoardCard[]} cards
 * @param {{ streamOnline?: boolean, nowLabel?: string, lastGoodLabel?: string }} [opts]
 * @returns {{
 *   tone: BoardMode,
 *   eyebrow: string,
 *   headline: string,
 *   sub: string,
 *   primaryActionId: string | undefined,
 * }}
 */
export function boardNowBanner(cards, opts = {}) {
  const mode = boardMode(cards, opts);
  const now = opts.nowLabel ?? "";
  const counts = kpiCounts(cards);

  if (mode === "degraded") {
    return {
      tone: "degraded",
      eyebrow: now ? `Board now · ${now} · degraded` : "Board now · degraded",
      headline:
        opts.streamOnline === false
          ? "Live stream disconnected. Card data may be stale; the operator should reconnect before acting."
          : `${counts.blocked} card(s) report stale or offline upstream data; freshness on those is not trustworthy.`,
      sub:
        opts.lastGoodLabel
          ? `Last known good read: ${opts.lastGoodLabel}. Hermes is auto-reconnecting; ` +
            `the operator can keep working but should not approve based on potentially stale state.`
          : `Hermes is auto-reconnecting; the operator can keep working but should not approve based on potentially stale state.`,
      primaryActionId: undefined,
    };
  }

  if (mode === "action") {
    const urgent = mostUrgentCard(cards);
    const actionCount = counts.action;
    const headline =
      actionCount === 1
        ? `1 card needs your review decision; automation has gone as far as it safely can.`
        : `${actionCount} cards need your review decision; automation has gone as far as it safely can.`;
    return {
      tone: "action",
      eyebrow: now
        ? `Board now · ${now} · ${actionCount} action needed`
        : `Board now · ${actionCount} action needed`,
      headline,
      sub: urgent
        ? `Most urgent: ${urgent.title}. Approve only if the risk and intent are clear.`
        : `Approve only if the risk and intent are clear.`,
      primaryActionId: urgent?.id,
    };
  }

  // calm
  return {
    tone: "calm",
    eyebrow: now ? `Board now · ${now} · you're done for now` : `Board now · you're done for now`,
    headline:
      counts.total === 0
        ? `Nothing waits on you. Everything in flight is automation; the day's release history is below.`
        : `Nothing in your queue right now. ${counts.checking + counts.queue + counts.deploying} card(s) are still automation in flight; Hermes is watching.`,
    sub:
      counts.done > 0
        ? `${counts.done} card(s) shipped today; you can step away.`
        : `No releases yet today; you can step away.`,
    primaryActionId: undefined,
  };
}

/**
 * Aggregate selector: everything the board page needs in one call.
 * Components can either consume this whole object or pull individual
 * pieces. Centralizes the memoization boundary — if the cards array
 * is reference-equal across renders, every derived value is too.
 *
 * @param {BoardCard[]} cards
 * @param {{ streamOnline?: boolean, nowLabel?: string, lastGoodLabel?: string }} [opts]
 */
export function deriveBoardState(cards, opts = {}) {
  return {
    grouped: groupByLane(cards),
    counts: kpiCounts(cards),
    mode: boardMode(cards, opts),
    banner: boardNowBanner(cards, opts),
    mostUrgent: mostUrgentCard(cards),
  };
}
