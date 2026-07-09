import test from "node:test";
import assert from "node:assert/strict";
import {
  hiddenLifecycleCopy,
  runsQueueLiveStatus,
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
