// Tests for live-stream.js — pure-logic helpers for the monitor
// SSE client (backoff math, status state machine). The LiveStream
// class itself is exercised by the M4 frontend smoke test;
// pure-logic invariants live here.

import test from "node:test";
import assert from "node:assert/strict";

import { backoffDelayMs, nextStatus, RECONNECT_CAP_MS } from "./live-stream.js";

// ── backoffDelayMs ──────────────────────────────────────────────────

test("backoffDelayMs: attempt 0 returns 0 (immediate first connect)", () => {
  assert.equal(backoffDelayMs(0), 0);
});

test("backoffDelayMs: exponential doubling — 1000 / 2000 / 4000 / 8000 / 16000", () => {
  assert.equal(backoffDelayMs(1), 1000);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(3), 4000);
  assert.equal(backoffDelayMs(4), 8000);
  assert.equal(backoffDelayMs(5), 16000);
});

test("backoffDelayMs: caps at RECONNECT_CAP_MS (30s)", () => {
  assert.equal(backoffDelayMs(6), RECONNECT_CAP_MS);
  assert.equal(backoffDelayMs(10), RECONNECT_CAP_MS);
  assert.equal(backoffDelayMs(99), RECONNECT_CAP_MS);
});

test("backoffDelayMs: defensive — non-number / negative attempt returns 0", () => {
  // @ts-expect-error — intentional non-number
  assert.equal(backoffDelayMs("not a number"), 0);
  assert.equal(backoffDelayMs(-1), 0);
  assert.equal(backoffDelayMs(NaN), 0);
  assert.equal(backoffDelayMs(undefined), 0);
});

test("backoffDelayMs: cap is exactly 30000ms (matches RECONNECT_CAP_MS export)", () => {
  // Locking the cap value in case the constant gets accidentally bumped
  // without updating the spec / docs.
  assert.equal(RECONNECT_CAP_MS, 30_000);
});

// ── nextStatus state machine ────────────────────────────────────────

test("nextStatus: idle + connect → connecting", () => {
  assert.equal(nextStatus("connect", "idle"), "connecting");
});

test("nextStatus: connecting + open → open", () => {
  assert.equal(nextStatus("open", "connecting"), "open");
});

test("nextStatus: open + error → reconnecting (the connection dropped)", () => {
  assert.equal(nextStatus("error", "open"), "reconnecting");
});

test("nextStatus: connecting + error → reconnecting (connect attempt failed)", () => {
  assert.equal(nextStatus("error", "connecting"), "reconnecting");
});

test("nextStatus: any state + close → closed (terminal)", () => {
  assert.equal(nextStatus("close", "idle"), "closed");
  assert.equal(nextStatus("close", "connecting"), "closed");
  assert.equal(nextStatus("close", "open"), "closed");
  assert.equal(nextStatus("close", "reconnecting"), "closed");
  assert.equal(nextStatus("close", "closed"), "closed");
});

test("nextStatus: idempotent re-open (already open) stays open", () => {
  assert.equal(nextStatus("connect", "open"), "open");
  assert.equal(nextStatus("open", "open"), "open");
});

test("nextStatus: unknown event type leaves status unchanged (defensive)", () => {
  // @ts-expect-error — intentional unknown event
  assert.equal(nextStatus("kaboom", "open"), "open");
  // @ts-expect-error — intentional unknown event
  assert.equal(nextStatus("kaboom", "idle"), "idle");
});

// ── Backoff progression in a realistic reconnect storm ─────────────

test("backoff progression: total wait through attempt 1..6 is bounded", () => {
  // This is the contract that says "we won't burn excessive cycles
  // retrying a dead server" — even after 6 attempts we've waited
  // < 65 seconds total, which is the right order of magnitude
  // for a transient outage.
  let total = 0;
  for (let i = 1; i <= 6; i++) total += backoffDelayMs(i);
  assert.ok(
    total < 65_000,
    `total backoff through attempt 6 should be < 65s; was ${total}ms`
  );
});

test("backoff progression: attempt N steady-state matches the cap", () => {
  // After the cap kicks in, every subsequent attempt waits exactly
  // 30s. This is the "we'll keep trying forever but won't escalate"
  // shape from the spec.
  assert.equal(backoffDelayMs(10), backoffDelayMs(20));
  assert.equal(backoffDelayMs(20), backoffDelayMs(99));
});
