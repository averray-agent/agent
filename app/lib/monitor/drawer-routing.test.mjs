// Tests for drawer-routing.js — URL-param encode/decode + j/k
// traversal for the detail drawer. M5 milestone.

import test from "node:test";
import assert from "node:assert/strict";

import {
  encodeCardParam,
  decodeCardParam,
  indexOfCard,
  traverseDrawerCard,
} from "./drawer-routing.js";

// ── encodeCardParam ─────────────────────────────────────────────────

test("encodeCardParam: returns URL-encoded form for normal ids", () => {
  assert.equal(encodeCardParam("agent #548"), "agent%20%23548");
  assert.equal(encodeCardParam("mission browser-onboard-04"), "mission%20browser-onboard-04");
  assert.equal(encodeCardParam("task starter-coding-014"), "task%20starter-coding-014");
});

test("encodeCardParam: returns null for empty/undefined/non-string", () => {
  assert.equal(encodeCardParam(""), null);
  assert.equal(encodeCardParam("   "), null);
  assert.equal(encodeCardParam(undefined), null);
  assert.equal(encodeCardParam(null), null);
  // @ts-expect-error — intentional non-string
  assert.equal(encodeCardParam(42), null);
});

test("encodeCardParam: trims leading/trailing whitespace", () => {
  assert.equal(encodeCardParam("  agent #1  "), "agent%20%231");
});

// ── decodeCardParam ─────────────────────────────────────────────────

test("decodeCardParam: returns trimmed string for non-empty input", () => {
  // Note: URLSearchParams.get() already URL-decodes for us, so the
  // decoder just trims + validates.
  assert.equal(decodeCardParam("agent #548"), "agent #548");
  assert.equal(decodeCardParam("  agent #1  "), "agent #1");
});

test("decodeCardParam: returns null for empty/whitespace/missing", () => {
  assert.equal(decodeCardParam(""), null);
  assert.equal(decodeCardParam("   "), null);
  assert.equal(decodeCardParam(null), null);
  assert.equal(decodeCardParam(undefined), null);
});

// ── indexOfCard ─────────────────────────────────────────────────────

test("indexOfCard: finds the card by id", () => {
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(indexOfCard(cards, "a"), 0);
  assert.equal(indexOfCard(cards, "b"), 1);
  assert.equal(indexOfCard(cards, "c"), 2);
});

test("indexOfCard: returns -1 for unknown id", () => {
  const cards = [{ id: "a" }];
  assert.equal(indexOfCard(cards, "ghost"), -1);
});

test("indexOfCard: returns -1 for empty/non-array/null id", () => {
  assert.equal(indexOfCard([], "a"), -1);
  // @ts-expect-error — intentional bad input
  assert.equal(indexOfCard(undefined, "a"), -1);
  assert.equal(indexOfCard([{ id: "a" }], null), -1);
  assert.equal(indexOfCard([{ id: "a" }], undefined), -1);
});

// ── traverseDrawerCard ─────────────────────────────────────────────

test("traverseDrawerCard: 'next' advances forward by one", () => {
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(traverseDrawerCard(cards, "a", "next"), "b");
  assert.equal(traverseDrawerCard(cards, "b", "next"), "c");
});

test("traverseDrawerCard: 'prev' moves backward by one", () => {
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(traverseDrawerCard(cards, "c", "prev"), "b");
  assert.equal(traverseDrawerCard(cards, "b", "prev"), "a");
});

test("traverseDrawerCard: 'next' on the last card stays put (no wrap-around)", () => {
  const cards = [{ id: "a" }, { id: "b" }];
  // Wrapping back to "a" would be disorienting — better to indicate
  // "you're at the end" by not moving.
  assert.equal(traverseDrawerCard(cards, "b", "next"), "b");
});

test("traverseDrawerCard: 'prev' on the first card stays put", () => {
  const cards = [{ id: "a" }, { id: "b" }];
  assert.equal(traverseDrawerCard(cards, "a", "prev"), "a");
});

test("traverseDrawerCard: focusing an unknown id jumps to the first card", () => {
  // If the URL has ?card=ghost (e.g., the card was archived
  // between page-loads), drawer traversal should bring the
  // operator back to a real card rather than silently break.
  const cards = [{ id: "a" }, { id: "b" }];
  assert.equal(traverseDrawerCard(cards, "ghost", "next"), "a");
  assert.equal(traverseDrawerCard(cards, "ghost", "prev"), "a");
});

test("traverseDrawerCard: empty card list returns null", () => {
  assert.equal(traverseDrawerCard([], "anything", "next"), null);
  assert.equal(traverseDrawerCard([], "anything", "prev"), null);
});

test("traverseDrawerCard: non-array input is defensively handled", () => {
  // @ts-expect-error — intentional bad input
  assert.equal(traverseDrawerCard(undefined, "a", "next"), null);
  // @ts-expect-error — intentional bad input
  assert.equal(traverseDrawerCard(null, "a", "next"), null);
});

test("traverseDrawerCard: roundtrip — j/k cancel each other out", () => {
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const next = traverseDrawerCard(cards, "a", "next");
  const back = traverseDrawerCard(cards, next, "prev");
  assert.equal(back, "a");
});
