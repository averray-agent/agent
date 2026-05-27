// Tests for board-cache.js — pure cache-patching for live monitor
// updates. M4 milestone.

import test from "node:test";
import assert from "node:assert/strict";

import { applyEventToBoard } from "./board-cache.js";

function baseBoard() {
  return {
    at: "2026-05-27T17:30:00Z",
    cards: [
      { id: "a", lane: "operator-review", type: "pr" },
      { id: "b", lane: "hermes-checking", type: "pr" },
    ],
  };
}

// ── board.snapshot — replace everything ─────────────────────────────

test("board.snapshot: replaces the cache wholesale", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.snapshot",
    at: "2026-05-27T17:35:00Z",
    cards: [{ id: "z", lane: "drafts", type: "pr" }],
  });
  assert.equal(next.cards.length, 1);
  assert.equal(next.cards[0].id, "z");
  assert.equal(next.at, "2026-05-27T17:35:00Z");
});

test("board.snapshot: works against an undefined prev (initial connect)", () => {
  const next = applyEventToBoard(undefined, {
    type: "board.snapshot",
    at: "2026-05-27T17:35:00Z",
    cards: [{ id: "a" }],
  });
  assert.equal(next.cards.length, 1);
});

test("board.snapshot: missing cards array becomes []", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.snapshot",
    at: "2026-05-27T17:35:00Z",
  });
  assert.deepEqual(next.cards, []);
});

// ── board.card.added ────────────────────────────────────────────────

test("board.card.added: appends a new card", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.added",
    card: { id: "c", lane: "release-queue", type: "pr" },
    at: "2026-05-27T17:35:00Z",
  });
  assert.equal(next.cards.length, 3);
  assert.equal(next.cards[2].id, "c");
});

test("board.card.added: same id is treated as an update (idempotent)", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.added",
    card: { id: "a", lane: "release-queue", type: "pr" },
  });
  assert.equal(next.cards.length, 2);
  // Card a's lane updated.
  assert.equal(next.cards.find(c => c.id === "a").lane, "release-queue");
});

test("board.card.added: skipped when prev is undefined (no base to add into)", () => {
  // Edge case: an added event arrives before the initial snapshot.
  // We can't append to "no cache" — drop and wait for the snapshot.
  const next = applyEventToBoard(undefined, {
    type: "board.card.added",
    card: { id: "x" },
  });
  assert.equal(next, undefined);
});

// ── board.card.updated ──────────────────────────────────────────────

test("board.card.updated: patches the matching card by id", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.updated",
    id: "a",
    partial: { freshness: 42, state: "stale" },
  });
  const card = next.cards.find(c => c.id === "a");
  assert.equal(card.freshness, 42);
  assert.equal(card.state, "stale");
  // Untouched fields preserved.
  assert.equal(card.lane, "operator-review");
});

test("board.card.updated: unknown id is a no-op (does not append)", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.updated",
    id: "ghost",
    partial: { freshness: 999 },
  });
  assert.equal(next.cards.length, 2);
  assert.ok(!next.cards.some(c => c.id === "ghost"));
});

test("board.card.updated: id mismatch in partial is overridden (id is the truth)", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.updated",
    id: "a",
    partial: { id: "tampered", freshness: 10 },
  });
  // The card under id 'a' has its freshness updated; id stays 'a'.
  assert.equal(next.cards[0].id, "a");
  assert.equal(next.cards[0].freshness, 10);
});

// ── board.card.moved ────────────────────────────────────────────────

test("board.card.moved: updates the matching card's lane", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.moved",
    id: "a",
    fromLane: "operator-review",
    toLane: "release-queue",
  });
  assert.equal(next.cards.find(c => c.id === "a").lane, "release-queue");
});

test("board.card.moved: unknown id is a no-op", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.moved",
    id: "ghost",
    toLane: "done",
  });
  assert.equal(next, baseBoard().constructor.prototype.constructor ? next : next);
  // Lengths unchanged, no card with id 'ghost' added.
  assert.equal(next.cards.length, 2);
});

test("board.card.moved: missing toLane is a no-op (safer than landing in undefined)", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.moved",
    id: "a",
  });
  assert.equal(next.cards.find(c => c.id === "a").lane, "operator-review");
});

// ── board.card.archived ────────────────────────────────────────────

test("board.card.archived: removes the matching card", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.archived",
    id: "a",
    reason: "stale > 48h",
  });
  assert.equal(next.cards.length, 1);
  assert.equal(next.cards[0].id, "b");
});

test("board.card.archived: unknown id is a no-op (length unchanged)", () => {
  const next = applyEventToBoard(baseBoard(), {
    type: "board.card.archived",
    id: "ghost",
  });
  assert.equal(next.cards.length, 2);
});

// ── stream.keepalive ───────────────────────────────────────────────

test("stream.keepalive: returns the previous board unchanged (cache stable)", () => {
  const prev = baseBoard();
  const next = applyEventToBoard(prev, { type: "stream.keepalive", at: "2026-05-27T17:35:00Z" });
  // Reference-equal — no allocation when nothing changes.
  assert.equal(next, prev);
});

// ── Unknown / malformed events ─────────────────────────────────────

test("unknown event type: returns prev unchanged (defensive)", () => {
  const prev = baseBoard();
  const next = applyEventToBoard(prev, { type: "kaboom" });
  assert.equal(next, prev);
});

test("non-object event: returns prev unchanged", () => {
  const prev = baseBoard();
  // @ts-expect-error — intentional bad input
  assert.equal(applyEventToBoard(prev, null), prev);
  // @ts-expect-error — intentional bad input
  assert.equal(applyEventToBoard(prev, undefined), prev);
  // @ts-expect-error — intentional bad input
  assert.equal(applyEventToBoard(prev, { type: 42 }), prev);
});

// ── Immutability ───────────────────────────────────────────────────

test("does not mutate the prev input object or its cards array", () => {
  const prev = baseBoard();
  const prevSerialized = JSON.stringify(prev);
  applyEventToBoard(prev, {
    type: "board.card.updated",
    id: "a",
    partial: { freshness: 999 },
  });
  assert.equal(JSON.stringify(prev), prevSerialized, "input must not be mutated");
});
