// Tests for card-router.js — dispatch logic between Card and
// DegradedCard renderers. M3 milestone.

import test from "node:test";
import assert from "node:assert/strict";

import { pickRenderer, defaultDegradedContent } from "./card-router.js";

function baseCard(overrides = {}) {
  return {
    id: "test-1",
    lane: "hermes-checking",
    type: "pr",
    agentType: "codex",
    title: "Test",
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

// ── pickRenderer ────────────────────────────────────────────────────

test("pickRenderer: fresh card → 'card'", () => {
  assert.equal(pickRenderer(baseCard({ state: "fresh" })), "card");
});

test("pickRenderer: stale card → 'card' (stale is a visual variant of the live shape)", () => {
  // A stale card still has real data we trust; it just hasn't
  // been refreshed recently. The Card component handles the
  // desaturated styling. Degraded is for when we DON'T trust
  // the data, which is a different thing.
  assert.equal(pickRenderer(baseCard({ state: "stale" })), "card");
});

test("pickRenderer: running card → 'card'", () => {
  assert.equal(pickRenderer(baseCard({ state: "running" })), "card");
});

test("pickRenderer: failed-fetch → 'degraded'", () => {
  // Upstream returned an error. We can't trust ANY field on
  // the card. Render the hand-built degraded variant so the
  // operator sees "the data is broken" not "everything is
  // fine and there's nothing to do."
  assert.equal(pickRenderer(baseCard({ state: "failed-fetch" })), "degraded");
});

test("pickRenderer: source-offline → 'degraded'", () => {
  assert.equal(pickRenderer(baseCard({ state: "source-offline" })), "degraded");
});

test("pickRenderer: done card → 'card' (closed-history renders compressed but is still trustworthy)", () => {
  const done = { ...baseCard(), type: "done", lane: "done", state: "fresh", closedAt: "2026-05-27T14:28:00Z", mergeStatus: "MERGED" };
  // @ts-expect-error — extending the base with done-specific fields for the test
  assert.equal(pickRenderer(done), "card");
});

test("pickRenderer: undefined/null card → 'card' (safe default; nothing to render but no crash)", () => {
  assert.equal(pickRenderer(undefined), "card");
  assert.equal(pickRenderer(null), "card");
});

test("pickRenderer: card with no `state` field → 'card' (settling default)", () => {
  // Defensively handle cards that lack a state field (shouldn't
  // happen with valid data, but the dispatch shouldn't crash).
  const card = baseCard({});
  delete card.state;
  assert.equal(pickRenderer(card), "card");
});

// ── defaultDegradedContent ──────────────────────────────────────────

test("defaultDegradedContent: failed-fetch returns retry copy + err pill", () => {
  const content = defaultDegradedContent(baseCard({ state: "failed-fetch" }));
  assert.match(content.body, /Upstream returned an error/);
  assert.equal(content.action, "Retry now");
  const pillClasses = content.pills.map(([cls]) => cls);
  assert.ok(pillClasses.includes("hm-pill--err"), "should have an err pill");
  assert.ok(pillClasses.includes("hm-pill--neutral"), "should have a neutral status pill");
});

test("defaultDegradedContent: source-offline returns cached-view copy + offline pill", () => {
  const content = defaultDegradedContent(baseCard({ state: "source-offline" }));
  assert.match(content.body, /Upstream unreachable/);
  assert.match(content.body, /not paging until the upstream returns/);
  assert.equal(content.action, "View last known");
  const pillClasses = content.pills.map(([cls]) => cls);
  assert.ok(pillClasses.includes("hm-pill--offline"), "should have an offline pill");
  // Critically: NO err pill on source-offline. Offline is a
  // neutral "we don't know" state, not an error state.
  assert.ok(!pillClasses.includes("hm-pill--err"), "source-offline must NOT carry an err pill");
});

test("defaultDegradedContent: both variants return 2 pills", () => {
  // Two pills is the bundle's pattern: one for the state label,
  // one for the status / next action. More than two starts looking
  // like a normal card; fewer than two loses the status signal.
  const failed = defaultDegradedContent(baseCard({ state: "failed-fetch" }));
  const offline = defaultDegradedContent(baseCard({ state: "source-offline" }));
  assert.equal(failed.pills.length, 2);
  assert.equal(offline.pills.length, 2);
});

test("defaultDegradedContent: returns non-empty action label (operator always has a next step)", () => {
  const failed = defaultDegradedContent(baseCard({ state: "failed-fetch" }));
  const offline = defaultDegradedContent(baseCard({ state: "source-offline" }));
  assert.ok(failed.action.length > 0);
  assert.ok(offline.action.length > 0);
});
