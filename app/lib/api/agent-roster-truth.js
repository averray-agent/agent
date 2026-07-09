/**
 * Resolve the roster tier once from the API tier label, falling back to the
 * score only when the API omitted its authoritative tier field.
 *
 * @param {unknown} value
 * @param {number} score
 * @returns {"T1" | "T2" | "T3"}
 */
export function tierFrom(value, score) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "t3" || raw === "expert" || raw === "master") return "T3";
  if (raw === "t2" || raw === "journeyman") return "T2";
  if (raw === "t1" || raw === "apprentice") return "T1";
  if (score < 300) return "T1";
  if (score < 800) return "T2";
  return "T3";
}

/**
 * A completed-job count is historical evidence, not current liveness.
 * Only an explicit in-flight session earns a live lifecycle state.
 *
 * @param {{ slashEventCount: number, activeStatus?: string, totalJobs?: number }} input
 * @returns {"idle" | "claimed" | "working" | "submitted" | "disputed" | "slashed"}
 */
export function stateFor({ slashEventCount, activeStatus }) {
  if (slashEventCount > 0) return "slashed";
  if (
    activeStatus === "claimed" ||
    activeStatus === "working" ||
    activeStatus === "submitted" ||
    activeStatus === "disputed"
  ) {
    return activeStatus;
  }
  return "idle";
}

/**
 * UI status filters group the three in-flight production states under the
 * honest “Working” label. Legacy `active` fixture rows are historical and
 * therefore belong with idle rows, never the live group.
 *
 * @param {string} state
 * @param {string} filter
 */
export function matchesAgentStatusFilter(state, filter) {
  if (filter === "all") return true;
  if (filter === "working") {
    return state === "claimed" || state === "working" || state === "submitted";
  }
  if (filter === "idle") return state === "idle" || state === "active";
  return state === filter;
}
