const DEGRADED_HEADLINE = "Live view degraded — some feeds are unreachable right now";

export function deriveOperatorRoomVerdict({ alertFeedPresence, visibleAlertCount } = {}) {
  const count = Number.isFinite(visibleAlertCount) ? Math.max(0, visibleAlertCount) : 0;
  if (alertFeedPresence !== "live") {
    return {
      eyebrow: DEGRADED_HEADLINE,
      detail: `${alertFeedReason(alertFeedPresence)} ${visibleTruth(count)}`,
      tone: "unknown"
    };
  }
  if (count > 0) {
    return {
      eyebrow: `${count} visible item${count === 1 ? " needs" : "s need"} attention`,
      detail: "Open the affected capability to inspect the live evidence and next action.",
      tone: "attention"
    };
  }
  return {
    eyebrow: "No visible action items",
    detail: "The live operator feeds report no action queue.",
    tone: "clear"
  };
}

function alertFeedReason(presence) {
  if (presence === "locked") return "The alert feed denied this session.";
  if (presence === "loading") return "The alert feed has not answered yet.";
  return "The alert feed could not be reached.";
}

function visibleTruth(count) {
  return `The ${count} visible item${count === 1 ? "" : "s"} and all other available feeds remain live and are shown.`;
}

export { DEGRADED_HEADLINE as OPERATOR_ROOM_DEGRADED_HEADLINE };
