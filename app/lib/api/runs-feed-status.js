export function runsQueueLiveStatus(adminPresence, publicPresence = "live") {
  if (adminPresence === "locked") {
    return "public feed · lifecycle metadata locked for this session";
  }
  if (adminPresence === "down") {
    return "public feed · lifecycle metadata unavailable";
  }
  if (adminPresence === "loading" && publicPresence === "live") {
    return "public feed · loading lifecycle metadata";
  }
  if (publicPresence === "down") return "live API unavailable";
  if (publicPresence === "loading") return "loading live jobs";
  return "live API";
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
