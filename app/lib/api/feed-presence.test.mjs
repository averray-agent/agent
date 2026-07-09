import test from "node:test";
import assert from "node:assert/strict";
import {
  feedPresence,
  isFeedBlocked,
  summarizePresence,
} from "./feed-presence.js";

test("resolved data is live", () => {
  assert.equal(feedPresence({ data: [], isLoading: false }), "live");
  assert.equal(feedPresence({ data: 0 }), "live");
  assert.equal(feedPresence({ data: null }), "live");
});

test("no data and no error is loading", () => {
  assert.equal(feedPresence({ isLoading: true }), "loading");
  assert.equal(feedPresence({}), "loading");
  assert.equal(feedPresence(undefined), "loading");
  assert.equal(feedPresence(null), "loading");
});

test("401/403 is locked, not down and never live", () => {
  assert.equal(feedPresence({ error: { status: 403 } }), "locked");
  assert.equal(feedPresence({ error: { status: 401 } }), "locked");
});

test("other errors are down", () => {
  assert.equal(feedPresence({ error: { status: 500 } }), "down");
  assert.equal(feedPresence({ error: { status: 503 } }), "down");
  assert.equal(feedPresence({ error: new Error("network") }), "down");
});

test("error outranks stale data — a failing feed must not read as live", () => {
  assert.equal(feedPresence({ data: [1], error: { status: 403 } }), "locked");
  assert.equal(feedPresence({ data: [1], error: { status: 500 } }), "down");
});

test("isFeedBlocked covers locked and down only", () => {
  assert.equal(isFeedBlocked({ error: { status: 403 } }), true);
  assert.equal(isFeedBlocked({ error: { status: 500 } }), true);
  assert.equal(isFeedBlocked({ data: [] }), false);
  assert.equal(isFeedBlocked({ isLoading: true }), false);
});

test("summarizePresence counts each state", () => {
  const summary = summarizePresence([
    { data: [] },
    { error: { status: 403 } },
    { error: { status: 403 } },
    { error: { status: 503 } },
    { isLoading: true },
  ]);
  assert.deepEqual(summary, { live: 1, loading: 1, locked: 2, down: 1, total: 5 });
});

test("summarizePresence tolerates empty input", () => {
  assert.deepEqual(summarizePresence([]), {
    live: 0,
    loading: 0,
    locked: 0,
    down: 0,
    total: 0,
  });
  assert.deepEqual(summarizePresence(undefined), {
    live: 0,
    loading: 0,
    locked: 0,
    down: 0,
    total: 0,
  });
});
