import test from "node:test";
import assert from "node:assert/strict";
import { buildClaimWindowLabel, formatDuration } from "./run-detail-values.js";

test("formats claim TTL as a real window duration", () => {
  assert.equal(buildClaimWindowLabel({ claimTtlSeconds: 7200 }), "02:00:00");
  assert.equal(
    buildClaimWindowLabel({ claimState: "claimable", claimTtlSeconds: 3600 }),
    "01:00:00"
  );
});

test("formats claimed sessions from claimExpiresAt", () => {
  assert.equal(
    buildClaimWindowLabel({
      claimState: "claimed",
      claimExpiresAt: "2026-07-09T12:30:00.000Z",
      nowMs: Date.parse("2026-07-09T11:00:00.000Z"),
    }),
    "01:30:00 remaining"
  );
});

test("omits unavailable or irrelevant window data", () => {
  assert.equal(buildClaimWindowLabel({ claimState: "submitted", claimTtlSeconds: 7200 }), "");
  assert.equal(buildClaimWindowLabel({ claimState: "claimed" }), "");
  assert.equal(buildClaimWindowLabel({ claimTtlSeconds: 0 }), "");
});

test("duration formatter is HH:MM:SS", () => {
  assert.equal(formatDuration(5000), "00:00:05");
  assert.equal(formatDuration(65_000), "00:01:05");
  assert.equal(formatDuration(3_661_000), "01:01:01");
});
