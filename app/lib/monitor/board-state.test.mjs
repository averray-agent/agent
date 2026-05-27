// Tests for board-state.js — selectors and derived state for the
// Hermes Handoff Monitor. M1 milestone.

import test from "node:test";
import assert from "node:assert/strict";

import {
  kpiCounts,
  mostUrgentCard,
  boardMode,
  boardNowBanner,
  deriveBoardState,
} from "./board-state.js";

// Reused fixture factory — keep card shapes minimal but realistic.
function card(overrides) {
  return {
    id: "test-1",
    lane: "hermes-checking",
    type: "pr",
    agentType: "codex",
    title: "Test card",
    summary: "summary",
    repo: "test/repo",
    freshness: 5,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "CI", tone: "info" },
    files: [],
    ...overrides,
  };
}

// ── kpiCounts ───────────────────────────────────────────────────────

test("kpiCounts: empty list returns zeros across the board", () => {
  const result = kpiCounts([]);
  assert.deepEqual(result, {
    action: 0,
    review: 0,
    checking: 0,
    queue: 0,
    deploying: 0,
    blocked: 0,
    done: 0,
    total: 0,
  });
});

test("kpiCounts: realistic mix counts each KPI correctly", () => {
  const cards = [
    card({ id: "act-1", isAction: true }),
    card({ id: "rev-1", lane: "operator-review" }),
    card({ id: "rev-2", lane: "operator-review" }),
    card({ id: "chk-1", lane: "hermes-checking" }),
    card({ id: "queue-1", lane: "release-queue" }),
    card({ id: "deploy-1", type: "deploy", deployId: "#1", verification: { current: 0, total: 1, label: "" } }),
    card({ id: "done-1", type: "done", lane: "done", closedAt: "2026-05-27", mergeStatus: "MERGED" }),
    card({ id: "done-2", type: "done", lane: "done", closedAt: "2026-05-27", mergeStatus: "MERGED" }),
  ];
  const result = kpiCounts(cards);
  assert.equal(result.action, 1);
  assert.equal(result.review, 2);
  assert.equal(result.checking, 1);
  assert.equal(result.queue, 1);
  assert.equal(result.deploying, 1);
  assert.equal(result.done, 2);
  // total = all live lanes (1+2+1+1+1) = 6
  assert.equal(result.total, 6);
  assert.equal(result.blocked, 0);
});

test("kpiCounts: blocked count includes failed-fetch + source-offline states", () => {
  const cards = [
    card({ id: "failed", state: "failed-fetch" }),
    card({ id: "offline", state: "source-offline" }),
    card({ id: "fresh", state: "fresh" }),
  ];
  const result = kpiCounts(cards);
  assert.equal(result.blocked, 2);
});

// ── mostUrgentCard ──────────────────────────────────────────────────

test("mostUrgentCard: returns undefined for empty board", () => {
  assert.equal(mostUrgentCard([]), undefined);
  assert.equal(mostUrgentCard(undefined), undefined);
});

test("mostUrgentCard: skips done-lane cards (only live work counts)", () => {
  const cards = [
    card({ id: "done-1", type: "done", lane: "done", freshness: 1, closedAt: "2026-05-27", mergeStatus: "MERGED" }),
    card({ id: "live-1", freshness: 100 }),
  ];
  const urgent = mostUrgentCard(cards);
  assert.equal(urgent.id, "live-1");
});

test("mostUrgentCard: picks the action card when one exists", () => {
  const cards = [
    card({ id: "fresh-1", freshness: 1 }),
    card({ id: "action-1", isAction: true, freshness: 200 }),
    card({ id: "fresh-2", freshness: 2 }),
  ];
  const urgent = mostUrgentCard(cards);
  assert.equal(urgent.id, "action-1");
});

test("mostUrgentCard: falls back to freshest non-action card when nothing needs the operator", () => {
  const cards = [
    card({ id: "older", freshness: 60 }),
    card({ id: "newer", freshness: 2 }),
    card({ id: "middle", freshness: 10 }),
  ];
  const urgent = mostUrgentCard(cards);
  assert.equal(urgent.id, "newer");
});

// ── boardMode ───────────────────────────────────────────────────────

test("boardMode: empty board is calm", () => {
  assert.equal(boardMode([]), "calm");
  assert.equal(boardMode(undefined), "calm");
});

test("boardMode: a single action card → action mode", () => {
  const cards = [card({ id: "a", isAction: true })];
  assert.equal(boardMode(cards), "action");
});

test("boardMode: blocked cards force degraded mode (overrides action)", () => {
  // A failed-fetch card means we can't trust the data — even if
  // something looks like it needs action, the truthful UI mode is
  // "the data is broken."
  const cards = [
    card({ id: "broken", state: "failed-fetch" }),
    card({ id: "act", isAction: true }),
  ];
  assert.equal(boardMode(cards), "degraded");
});

test("boardMode: streamOnline=false forces degraded regardless of cards", () => {
  // If the live stream is down, the whole board is untrustworthy
  // even if every card claims state=fresh.
  const cards = [card({ id: "a", freshness: 1, state: "fresh" })];
  assert.equal(boardMode(cards, { streamOnline: false }), "degraded");
});

test("boardMode: streamOnline=true is a no-op (calm/action driven by cards)", () => {
  assert.equal(boardMode([card({ isAction: true })], { streamOnline: true }), "action");
});

// ── boardNowBanner ──────────────────────────────────────────────────

test("boardNowBanner: action mode produces an action-toned banner with the most urgent card cited", () => {
  const cards = [
    card({ id: "act-1", isAction: true, title: "Approve the thing" }),
  ];
  const banner = boardNowBanner(cards, { nowLabel: "14:32:08 utc" });
  assert.equal(banner.tone, "action");
  assert.match(banner.eyebrow, /1 action needed/);
  assert.match(banner.headline, /1 card needs your review decision/);
  assert.match(banner.sub, /Approve the thing/);
  assert.equal(banner.primaryActionId, "act-1");
});

test("boardNowBanner: multiple action cards pluralize correctly", () => {
  const cards = [
    card({ id: "a1", isAction: true, title: "A" }),
    card({ id: "a2", isAction: true, title: "B" }),
  ];
  const banner = boardNowBanner(cards);
  assert.match(banner.eyebrow, /2 action needed/);
  assert.match(banner.headline, /2 cards need your review decision/);
});

test("boardNowBanner: calm board with nothing in flight reads 'nothing waits on you'", () => {
  const banner = boardNowBanner([], { nowLabel: "17:48:02 utc" });
  assert.equal(banner.tone, "calm");
  assert.match(banner.eyebrow, /you're done for now/);
  assert.match(banner.headline, /Nothing waits on you/);
});

test("boardNowBanner: calm board with in-flight automation reads correctly", () => {
  const cards = [
    card({ id: "check-1", lane: "hermes-checking" }),
    card({ id: "deploy-1", type: "deploy", deployId: "#1", verification: { current: 1, total: 3, label: "" } }),
  ];
  const banner = boardNowBanner(cards);
  assert.equal(banner.tone, "calm");
  assert.match(banner.headline, /automation in flight/);
  // 1 checking + 1 deploying = 2
  assert.match(banner.headline, /2 card/);
});

test("boardNowBanner: degraded mode (stream offline)", () => {
  const banner = boardNowBanner([], {
    streamOnline: false,
    nowLabel: "14:36:20 utc",
    lastGoodLabel: "14:32:08 utc",
  });
  assert.equal(banner.tone, "degraded");
  assert.match(banner.eyebrow, /degraded/);
  assert.match(banner.headline, /Live stream disconnected/);
  assert.match(banner.sub, /Last known good read: 14:32:08 utc/);
  assert.equal(banner.primaryActionId, undefined);
});

test("boardNowBanner: degraded mode (cards reporting failed-fetch but stream up)", () => {
  const cards = [
    card({ id: "broken-1", state: "failed-fetch" }),
    card({ id: "broken-2", state: "failed-fetch" }),
  ];
  const banner = boardNowBanner(cards);
  assert.equal(banner.tone, "degraded");
  assert.match(banner.headline, /2 card\(s\) report stale or offline upstream data/);
});

// ── deriveBoardState ───────────────────────────────────────────────

test("deriveBoardState: bundles every selector together", () => {
  const cards = [
    card({ id: "act", isAction: true, title: "Action card" }),
    card({ id: "rev", lane: "operator-review" }),
    card({ id: "done-1", type: "done", lane: "done", closedAt: "2026-05-27", mergeStatus: "MERGED" }),
  ];
  const state = deriveBoardState(cards, { nowLabel: "14:32:08 utc" });
  assert.equal(state.mode, "action");
  assert.equal(state.counts.action, 1);
  assert.equal(state.counts.review, 1);
  assert.equal(state.counts.done, 1);
  assert.equal(state.banner.tone, "action");
  assert.equal(state.banner.primaryActionId, "act");
  assert.equal(state.mostUrgent.id, "act");
  assert.equal(state.grouped["needs-attention"].length, 1);
  assert.equal(state.grouped["operator-review"].length, 1);
  assert.equal(state.grouped["done"].length, 1);
});
