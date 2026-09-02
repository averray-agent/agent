import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_REFRESH_CHECK_INTERVAL_MS,
  AUTH_REFRESH_THRESHOLD_MS,
  AUTH_REFRESH_MIN_SCHEDULE_DELAY_MS,
  scheduleDelayMs,
  shouldClearSession,
  shouldRefreshNow,
} from "./auth-refresh-decisions.js";

const NOW = Date.parse("2026-05-17T12:00:00.000Z");

function snapshot(expiresInMs, opts = {}) {
  return {
    authenticated: opts.authenticated ?? true,
    expiresAt: new Date(NOW + expiresInMs).toISOString(),
  };
}

test("shouldRefreshNow: true when remaining lifetime is below threshold", () => {
  // 5 minutes left — below 10-minute threshold.
  assert.equal(shouldRefreshNow(snapshot(5 * 60_000), NOW), true);
});

test("shouldRefreshNow: false when there is plenty of lifetime left", () => {
  // 1h left.
  assert.equal(shouldRefreshNow(snapshot(60 * 60_000), NOW), false);
});

test("shouldRefreshNow: true at the boundary (exactly THRESHOLD remaining)", () => {
  assert.equal(shouldRefreshNow(snapshot(AUTH_REFRESH_THRESHOLD_MS), NOW), true);
});

test("shouldRefreshNow: true when already expired (defensive — we will refresh and 401 will clear)", () => {
  assert.equal(shouldRefreshNow(snapshot(-30_000), NOW), true);
});

test("shouldRefreshNow: false when not authenticated", () => {
  assert.equal(shouldRefreshNow({ authenticated: false }, NOW), false);
});

test("shouldRefreshNow: false when expiresAt is missing or unparseable", () => {
  assert.equal(shouldRefreshNow({ authenticated: true }, NOW), false);
  assert.equal(shouldRefreshNow({ authenticated: true, expiresAt: "not-a-date" }, NOW), false);
});

test("scheduleDelayMs: schedules ~ (lifetime - threshold) when ample time remains", () => {
  // 30 min remaining, 10 min threshold -> 20 min delay.
  const delay = scheduleDelayMs(snapshot(30 * 60_000), NOW);
  assert.equal(delay, 20 * 60_000);
});

test("scheduleDelayMs: clamps to MIN_SCHEDULE_DELAY_MS when target is in the past", () => {
  // 5 minutes remaining, threshold = 10 min, target is 5 min in the past.
  const delay = scheduleDelayMs(snapshot(5 * 60_000), NOW);
  assert.equal(delay, AUTH_REFRESH_MIN_SCHEDULE_DELAY_MS);
});

test("scheduleDelayMs: returns undefined when there is no session", () => {
  assert.equal(scheduleDelayMs({ authenticated: false }, NOW), undefined);
  assert.equal(scheduleDelayMs({ authenticated: true }, NOW), undefined);
  assert.equal(scheduleDelayMs({ authenticated: true, expiresAt: "garbage" }, NOW), undefined);
});

test("shouldClearSession: only 'unauthorized' clears", () => {
  assert.equal(shouldClearSession("unauthorized"), true);
  assert.equal(shouldClearSession("endpoint_missing"), false);
  assert.equal(shouldClearSession("network"), false);
  assert.equal(shouldClearSession("shape"), false);
  assert.equal(shouldClearSession("no_session"), false);
});

test("constants are sensible — threshold < typical 24h TTL, check < threshold", () => {
  assert.ok(AUTH_REFRESH_THRESHOLD_MS < 24 * 60 * 60_000, "threshold must fit inside a 24h TTL");
  assert.ok(AUTH_REFRESH_CHECK_INTERVAL_MS < AUTH_REFRESH_THRESHOLD_MS, "poll must run more often than the threshold");
  assert.ok(AUTH_REFRESH_MIN_SCHEDULE_DELAY_MS > 0, "min schedule must be positive");
});
