import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldShowOverviewOrientation,
  OVERVIEW_ORIENTATION_DISMISSED_KEY,
} from "./overview-orientation.js";

const base = {
  dismissed: false,
  authenticated: true,
  activityResolved: true,
  roomActivityCount: 0,
};

test("shows for a signed-in operator with a resolved, empty room", () => {
  assert.equal(shouldShowOverviewOrientation(base), true);
});

test("hidden once the room has any activity", () => {
  assert.equal(
    shouldShowOverviewOrientation({ ...base, roomActivityCount: 1 }),
    false,
  );
  assert.equal(
    shouldShowOverviewOrientation({ ...base, roomActivityCount: 48 }),
    false,
  );
});

test("hidden while activity is still loading (loading is not empty)", () => {
  assert.equal(
    shouldShowOverviewOrientation({ ...base, activityResolved: false }),
    false,
  );
  // Even with a zero count, an unresolved request must not show the card.
  assert.equal(
    shouldShowOverviewOrientation({
      ...base,
      activityResolved: false,
      roomActivityCount: 0,
    }),
    false,
  );
});

test("hidden once dismissed (persisted), regardless of emptiness", () => {
  assert.equal(shouldShowOverviewOrientation({ ...base, dismissed: true }), false);
});

test("hidden when not authenticated", () => {
  assert.equal(
    shouldShowOverviewOrientation({ ...base, authenticated: false }),
    false,
  );
});

test("defensive: null/undefined input does not throw and returns false", () => {
  assert.equal(shouldShowOverviewOrientation(undefined), false);
  assert.equal(shouldShowOverviewOrientation(null), false);
});

test("exports a stable, namespaced dismissal key", () => {
  assert.equal(
    OVERVIEW_ORIENTATION_DISMISSED_KEY,
    "averray:overview-orientation-dismissed",
  );
});
