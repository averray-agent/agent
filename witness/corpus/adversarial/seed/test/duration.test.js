import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDuration, formatDuration } from "../src/duration.js";

test("parses a single unit", () => {
  assert.equal(parseDuration("90s"), 90_000);
});

test("parses combined units", () => {
  assert.equal(parseDuration("1h30m"), 5_400_000);
});

test("formats milliseconds back to a compact string", () => {
  assert.equal(formatDuration(5_400_000), "1h30m");
});

test("round-trips a combined duration", () => {
  assert.equal(formatDuration(parseDuration("2h15m30s")), "2h15m30s");
});
