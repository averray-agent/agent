import assert from "node:assert/strict";
import test from "node:test";

import { deriveOperatorRoomVerdict } from "./operator-room-verdict.js";

test("operator room verdict names an unreachable alert feed and preserves visible truth", () => {
  assert.deepEqual(
    deriveOperatorRoomVerdict({ alertFeedPresence: "down", visibleAlertCount: 2 }),
    {
      eyebrow: "Live view degraded — some feeds are unreachable right now",
      detail: "The alert feed could not be reached. The 2 visible items and all other available feeds remain live and are shown.",
      tone: "unknown"
    }
  );
});

test("operator room verdict reads the feed reason instead of forking headline logic", () => {
  assert.match(
    deriveOperatorRoomVerdict({ alertFeedPresence: "locked", visibleAlertCount: 0 }).detail,
    /alert feed denied this session/u
  );
  assert.match(
    deriveOperatorRoomVerdict({ alertFeedPresence: "loading", visibleAlertCount: 0 }).detail,
    /alert feed has not answered yet/u
  );
  assert.equal(
    deriveOperatorRoomVerdict({ alertFeedPresence: "live", visibleAlertCount: 1 }).eyebrow,
    "1 visible item needs attention"
  );
});
