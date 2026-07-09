import test from "node:test";
import assert from "node:assert/strict";
import {
  hiddenLifecycleCopy,
  recommendationsPresence,
  runsPageFreshness,
  runsQueueLiveStatus,
  runsRowsPresence,
} from "./runs-feed-status.js";

test("queue status declares locked admin lifecycle metadata", () => {
  assert.equal(
    runsQueueLiveStatus("locked", "live"),
    "public feed · lifecycle metadata locked for this session"
  );
});

test("queue status distinguishes unavailable admin metadata from locked", () => {
  assert.equal(
    runsQueueLiveStatus("down", "live"),
    "public feed · lifecycle metadata unavailable"
  );
});

test("blocked public jobs take precedence over admin degradation copy", () => {
  assert.equal(
    runsQueueLiveStatus("locked", "down"),
    "job feed unavailable"
  );
  assert.equal(
    runsQueueLiveStatus("loading", "locked"),
    "job feed locked for this session"
  );
});

test("operator jobs can back the queue without the public feed", () => {
  assert.equal(runsRowsPresence("live", "down"), "live");
  assert.equal(runsQueueLiveStatus("live", "down"), "live operator feed");
});

test("public jobs decide queue presence when admin jobs are not live", () => {
  assert.equal(runsRowsPresence("locked", "live"), "live");
  assert.equal(runsRowsPresence("down", "loading"), "loading");
  assert.equal(runsRowsPresence("loading", "down"), "down");
});

test("recommendations require both the recommendation and job feeds", () => {
  assert.equal(recommendationsPresence("live", "live"), "live");
  assert.equal(recommendationsPresence("live", "loading"), "loading");
  assert.equal(recommendationsPresence("locked", "live"), "locked");
  assert.equal(recommendationsPresence("live", "down"), "down");
});

test("runs freshness declares mixed loading, locked, and down states", () => {
  assert.equal(runsPageFreshness("live", "loading"), "loading");
  assert.equal(runsPageFreshness("live", "locked"), "partial");
  assert.equal(runsPageFreshness("locked", "down"), "fallback");
  assert.equal(runsPageFreshness("live", "live"), "live");
});

test("hidden lifecycle copy blocks the toggle when admin metadata is locked", () => {
  assert.deepEqual(hiddenLifecycleCopy("locked", 0, false), {
    blocked: true,
    message:
      "Lifecycle metadata locked for this session — paused, archived, and stale rows cannot be shown.",
    button: "Show hidden",
  });
});

test("hidden lifecycle copy keeps privileged operator behavior unchanged", () => {
  assert.deepEqual(hiddenLifecycleCopy("live", 2, false), {
    blocked: false,
    message: "2 paused/archived/stale jobs are hidden.",
    button: "Show closed",
  });
});
