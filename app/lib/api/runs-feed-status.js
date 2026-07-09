/**
 * Choose the feed that can truthfully back the runs queue/detail surface.
 * The operator feed is preferred because it includes lifecycle metadata;
 * otherwise the public feed decides whether rows are live, loading, locked,
 * or down. Callers must only adapt payloads when this returns `live`.
 */
export function runsRowsPresence(adminPresence, publicPresence) {
  return adminPresence === "live" ? "live" : publicPresence;
}

export function runsQueueLiveStatus(adminPresence, publicPresence = "live") {
  if (adminPresence === "live") return "live operator feed";
  if (publicPresence === "locked") return "job feed locked for this session";
  if (publicPresence === "down") return "job feed unavailable";
  if (publicPresence === "loading") return "loading live jobs";
  if (adminPresence === "locked") {
    return "public feed · lifecycle metadata locked for this session";
  }
  if (adminPresence === "down") {
    return "public feed · lifecycle metadata unavailable";
  }
  if (adminPresence === "loading") {
    return "public feed · loading lifecycle metadata";
  }
  return "live public feed";
}

/**
 * Recommendation cards join `/jobs/recommendations` to `/jobs`. Both
 * requests must be live or the cards would contain invented fallback titles,
 * rewards, and fit metadata from a missing job record.
 */
export function recommendationsPresence(recommendationPresence, jobsPresence) {
  if (recommendationPresence === "down" || jobsPresence === "down") return "down";
  if (recommendationPresence === "locked" || jobsPresence === "locked") return "locked";
  if (recommendationPresence === "loading" || jobsPresence === "loading") return "loading";
  return "live";
}

/** Aggregate panel presence into the existing topbar freshness vocabulary. */
export function runsPageFreshness(...presences) {
  if (presences.some((presence) => presence === "down")) return "fallback";
  if (presences.some((presence) => presence === "locked")) return "partial";
  if (presences.some((presence) => presence === "loading")) return "loading";
  return "live";
}

export function hiddenLifecycleCopy(adminPresence, closedRowCount, showClosed) {
  if (adminPresence === "locked") {
    return {
      blocked: true,
      message:
        "Lifecycle metadata locked for this session — paused, archived, and stale rows cannot be shown.",
      button: "Show hidden",
    };
  }
  if (adminPresence === "down") {
    return {
      blocked: true,
      message:
        "Lifecycle metadata unavailable — paused, archived, and stale rows cannot be shown right now.",
      button: "Show hidden",
    };
  }
  return {
    blocked: false,
    message: showClosed
      ? `Showing all jobs including ${closedRowCount} paused/archived/stale.`
      : `${closedRowCount} paused/archived/stale ${
          closedRowCount === 1 ? "job is" : "jobs are"
        } hidden.`,
    button: showClosed ? "Hide closed" : "Show closed",
  };
}
