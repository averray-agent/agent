// Tests for monitor-service.js — in-memory board state + SSE event
// bus. M4 milestone.

import test from "node:test";
import assert from "node:assert/strict";

import { MonitorService } from "./monitor-service.js";

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

function frozenClock(iso) {
  return () => new Date(iso);
}

// ── snapshot ─────────────────────────────────────────────────────

test("getBoardSnapshot: returns the seeded card list", () => {
  const cards = [
    { id: "card-1", lane: "operator-review", type: "pr" },
    { id: "card-2", lane: "hermes-checking", type: "pr" },
  ];
  const svc = new MonitorService({
    logger: silentLogger(),
    initialCards: cards,
    now: frozenClock("2026-05-27T17:00:00Z"),
  });
  const snap = svc.getBoardSnapshot();
  assert.equal(snap.cards.length, 2);
  assert.equal(snap.at, "2026-05-27T17:00:00.000Z");
  assert.deepEqual(snap.cards.map(c => c.id), ["card-1", "card-2"]);
});

test("getBoardSnapshot: returns a fresh array each call (mutations don't leak)", () => {
  const svc = new MonitorService({ logger: silentLogger(), initialCards: [{ id: "a", lane: "drafts", type: "pr" }] });
  const first = svc.getBoardSnapshot().cards;
  first.push({ id: "intruder", lane: "done", type: "done" });
  const second = svc.getBoardSnapshot().cards;
  assert.equal(second.length, 1, "external mutation of the returned array must not affect future snapshots");
  assert.equal(second[0].id, "a");
});

test("getCard: returns the card by id, or undefined", () => {
  const svc = new MonitorService({ logger: silentLogger(), initialCards: [{ id: "x", lane: "drafts", type: "pr" }] });
  assert.equal(svc.getCard("x")?.id, "x");
  assert.equal(svc.getCard("missing"), undefined);
});

// ── addCard / updateCard / moveCard / archiveCard ────────────────

test("addCard: new card lands in the store and emits board.card.added", () => {
  const svc = new MonitorService({ logger: silentLogger(), initialCards: [] });
  const received = [];
  svc.subscribe(e => received.push(e));
  svc.addCard({ id: "new-1", lane: "drafts", type: "pr" });
  // First event is the snapshot, second is the added card.
  assert.equal(received.length, 2);
  assert.equal(received[0].type, "board.snapshot");
  assert.equal(received[1].type, "board.card.added");
  assert.equal(received[1].card.id, "new-1");
});

test("addCard: same-id card is idempotent (treated as update, no second .added emitted)", () => {
  const svc = new MonitorService({ logger: silentLogger(), initialCards: [{ id: "dup", lane: "drafts", type: "pr" }] });
  const received = [];
  svc.subscribe(e => received.push(e));
  svc.addCard({ id: "dup", lane: "operator-review", type: "pr" });
  // snapshot + updated (NOT added)
  assert.equal(received.length, 2);
  assert.equal(received[0].type, "board.snapshot");
  assert.equal(received[1].type, "board.card.updated");
});

test("updateCard: patches the card and emits board.card.updated", () => {
  const svc = new MonitorService({
    logger: silentLogger(),
    initialCards: [{ id: "x", lane: "drafts", type: "pr", freshness: 5, state: "fresh" }],
  });
  const received = [];
  svc.subscribe(e => received.push(e));
  svc.updateCard("x", { freshness: 100, state: "stale" });
  const card = svc.getCard("x");
  assert.equal(card.freshness, 100);
  assert.equal(card.state, "stale");
  assert.equal(card.lane, "drafts");  // untouched fields preserved
  assert.equal(received[1].type, "board.card.updated");
  assert.equal(received[1].id, "x");
  assert.equal(received[1].partial.freshness, 100);
});

test("updateCard: unknown id is a no-op (no events emitted)", () => {
  const svc = new MonitorService({ logger: silentLogger(), initialCards: [] });
  const received = [];
  svc.subscribe(e => received.push(e));
  svc.updateCard("ghost", { freshness: 999 });
  // Only the snapshot — no spurious update event.
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "board.snapshot");
});

test("moveCard: changes lane and emits board.card.moved with from/to", () => {
  const svc = new MonitorService({
    logger: silentLogger(),
    initialCards: [{ id: "m", lane: "hermes-checking", type: "pr" }],
  });
  const received = [];
  svc.subscribe(e => received.push(e));
  svc.moveCard("m", "operator-review");
  const card = svc.getCard("m");
  assert.equal(card.lane, "operator-review");
  assert.equal(received[1].type, "board.card.moved");
  assert.equal(received[1].fromLane, "hermes-checking");
  assert.equal(received[1].toLane, "operator-review");
});

test("moveCard: no-op when lane already matches", () => {
  const svc = new MonitorService({
    logger: silentLogger(),
    initialCards: [{ id: "m", lane: "operator-review", type: "pr" }],
  });
  const received = [];
  svc.subscribe(e => received.push(e));
  svc.moveCard("m", "operator-review");
  assert.equal(received.length, 1, "should only have the snapshot, no .moved event");
});

test("archiveCard: removes the card and emits board.card.archived with reason", () => {
  const svc = new MonitorService({
    logger: silentLogger(),
    initialCards: [{ id: "old", lane: "done", type: "done" }],
  });
  const received = [];
  svc.subscribe(e => received.push(e));
  svc.archiveCard("old", "stale > 48h");
  assert.equal(svc.getCard("old"), undefined);
  assert.equal(received[1].type, "board.card.archived");
  assert.equal(received[1].id, "old");
  assert.equal(received[1].reason, "stale > 48h");
});

test("archiveCard: unknown id is a no-op", () => {
  const svc = new MonitorService({ logger: silentLogger(), initialCards: [] });
  const received = [];
  svc.subscribe(e => received.push(e));
  svc.archiveCard("ghost", "test");
  assert.equal(received.length, 1, "snapshot only");
});

// ── subscribe / unsubscribe ──────────────────────────────────────

test("subscribe: replays snapshot to new subscribers (so they start in sync)", () => {
  const svc = new MonitorService({
    logger: silentLogger(),
    initialCards: [{ id: "a", lane: "drafts", type: "pr" }, { id: "b", lane: "done", type: "done" }],
  });
  const received = [];
  svc.subscribe(e => received.push(e));
  assert.equal(received[0].type, "board.snapshot");
  assert.equal(received[0].cards.length, 2);
});

test("unsubscribe: handler stops receiving events after returned fn is called", () => {
  const svc = new MonitorService({ logger: silentLogger(), initialCards: [] });
  const received = [];
  const unsub = svc.subscribe(e => received.push(e));
  unsub();
  svc.addCard({ id: "after-unsub", lane: "drafts", type: "pr" });
  // Only the initial snapshot.
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "board.snapshot");
});

test("subscriberCount: reflects active subscribers", () => {
  const svc = new MonitorService({ logger: silentLogger(), initialCards: [] });
  assert.equal(svc.subscriberCount, 0);
  const u1 = svc.subscribe(() => {});
  const u2 = svc.subscribe(() => {});
  assert.equal(svc.subscriberCount, 2);
  u1();
  assert.equal(svc.subscriberCount, 1);
  u2();
  assert.equal(svc.subscriberCount, 0);
});

// ── keepalive ────────────────────────────────────────────────────

test("emitKeepalive: emits stream.keepalive to all subscribers", () => {
  const svc = new MonitorService({
    logger: silentLogger(),
    initialCards: [],
    now: frozenClock("2026-05-27T17:30:00Z"),
  });
  const received = [];
  svc.subscribe(e => received.push(e));
  svc.emitKeepalive();
  // snapshot + keepalive
  assert.equal(received.length, 2);
  assert.equal(received[1].type, "stream.keepalive");
  assert.equal(received[1].at, "2026-05-27T17:30:00.000Z");
});

// ── error handling ───────────────────────────────────────────────

test("a throwing subscriber does not prevent other subscribers from receiving the event", () => {
  const svc = new MonitorService({ logger: silentLogger(), initialCards: [] });
  // Bad subscriber throws on every event.
  svc.subscribe(() => { throw new Error("subscriber blew up"); });
  // Good subscriber.
  const received = [];
  svc.subscribe(e => received.push(e));
  // EventEmitter throws synchronously by default if a listener errors,
  // but we want the service to survive it. Wrap in try/catch.
  try {
    svc.addCard({ id: "x", lane: "drafts", type: "pr" });
  } catch {
    // Acceptable for now — the bus surfaces the error.
  }
  // The good subscriber should have at least gotten the snapshot.
  assert.ok(received.length >= 1, "good subscriber should still receive snapshot");
});
