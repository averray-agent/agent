// Tests for lane-rules.js — pure-function lane classification for the
// Hermes Handoff Monitor. M1 milestone.

import test from "node:test";
import assert from "node:assert/strict";

import { laneFor, groupByLane, laneCounts } from "./lane-rules.js";
import { LANES } from "./card-types.js";

// ── Test fixtures ───────────────────────────────────────────────────

function prCard(overrides = {}) {
  return {
    id: "agent #1",
    lane: "operator-review",
    type: "pr",
    agentType: "codex",
    title: "Test PR",
    summary: "test",
    repo: "test/repo",
    freshness: 5,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "warn" },
    files: [],
    ...overrides,
  };
}

function missionCard(overrides = {}) {
  return {
    id: "mission test-01",
    lane: "hermes-checking",
    type: "mission",
    agentType: "hermes",
    title: "Test mission",
    summary: "test",
    repo: "test/repo",
    freshness: 5,
    state: "fresh",
    risk: ["testbed"],
    waitingOn: { actor: "agent", tone: "info" },
    mission: { verdict: "OK", verdictTone: "ok", confidence: 1, latency: "1s", target: "x", seed: "fresh", runs: 1, successScore: 10, clarityScore: 10, latencyScore: 10, path: [], blockers: [], evidence: [], mutationBoundary: "", recommendations: [] },
    ...overrides,
  };
}

function taskCard(overrides = {}) {
  return {
    id: "task #1",
    lane: "codex-needed",
    type: "task",
    agentType: "hermes",
    title: "Test task",
    summary: "test",
    repo: "test/repo",
    freshness: 5,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "info" },
    prompt: "do the thing",
    ...overrides,
  };
}

function deployCard(overrides = {}) {
  return {
    id: "ext #246",
    lane: "deploying",
    type: "deploy",
    agentType: "ext",
    title: "Post-merge verify",
    summary: "verifying",
    repo: "test/repo",
    freshness: 2,
    state: "fresh",
    risk: ["indexer"],
    waitingOn: { actor: "relay", tone: "info" },
    deployId: "#246",
    verification: { current: 3, total: 5, label: "indexer settle" },
    ...overrides,
  };
}

function draftCard(overrides = {}) {
  return {
    id: "agent #99",
    lane: "drafts",
    type: "pr",  // a draft can still be a PR-shaped card
    agentType: "claude",
    title: "WIP",
    summary: "draft",
    repo: "test/repo",
    freshness: 27,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "author", tone: "neutral" },
    isDraft: true,
    files: [],
    ...overrides,
  };
}

function doneCard(overrides = {}) {
  return {
    id: "agent #538",
    lane: "done",
    type: "done",
    agentType: "claude",
    title: "Closed",
    summary: "merged",
    repo: "test/repo",
    freshness: 600,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "neutral" },
    closedAt: "2026-05-27T14:28:00Z",
    mergeStatus: "MERGED",
    ...overrides,
  };
}

// ── laneFor: priority order ─────────────────────────────────────────

test("laneFor: isAction always wins over explicit lane", () => {
  // Even if the stored lane says operator-review, an action-promoted
  // card belongs in needs-attention. This is the visual graduation
  // that makes the operator notice.
  const card = prCard({ lane: "operator-review", isAction: true });
  assert.equal(laneFor(card), "needs-attention");
});

test("laneFor: isAction wins over isDraft (paranoia — shouldn't co-occur, but if they do, action ranks higher)", () => {
  const card = prCard({ isAction: true, isDraft: true });
  assert.equal(laneFor(card), "needs-attention");
});

test("laneFor: isDraft wins over the stored lane (drafts never enter the work queues)", () => {
  const card = draftCard({ lane: "operator-review", isDraft: true });
  assert.equal(laneFor(card), "drafts");
});

test("laneFor: type=task always routes to codex-needed", () => {
  const card = taskCard({ lane: "hermes-checking" });
  assert.equal(laneFor(card), "codex-needed");
});

test("laneFor: type=deploy always routes to deploying", () => {
  const card = deployCard({ lane: "hermes-checking" });
  assert.equal(laneFor(card), "deploying");
});

test("laneFor: type=done always routes to done", () => {
  const card = doneCard({ lane: "operator-review" });
  assert.equal(laneFor(card), "done");
});

// ── laneFor: trust the explicit lane for general PRs and missions ──

test("laneFor: PR card with no overrides uses the stored lane", () => {
  assert.equal(laneFor(prCard({ lane: "operator-review" })), "operator-review");
  assert.equal(laneFor(prCard({ lane: "hermes-checking" })), "hermes-checking");
  assert.equal(laneFor(prCard({ lane: "release-queue" })), "release-queue");
});

test("laneFor: mission card uses the stored lane (hermes-checking by default)", () => {
  assert.equal(laneFor(missionCard({ lane: "hermes-checking" })), "hermes-checking");
});

// ── laneFor: defensive paths ────────────────────────────────────────

test("laneFor: undefined/null card returns hermes-checking (visible but doesn't claim attention)", () => {
  assert.equal(laneFor(undefined), "hermes-checking");
  assert.equal(laneFor(null), "hermes-checking");
});

test("laneFor: card with no lane field defaults to hermes-checking", () => {
  const card = prCard({});
  delete card.lane;
  assert.equal(laneFor(card), "hermes-checking");
});

// ── groupByLane ────────────────────────────────────────────────────

test("groupByLane: empty input returns all 8 lanes with empty arrays", () => {
  const result = groupByLane([]);
  for (const lane of LANES) {
    assert.deepEqual(result[lane], [], `expected lane ${lane} to be empty`);
  }
});

test("groupByLane: realistic mix sorts each card into its computed lane", () => {
  const action = prCard({ id: "action-1", isAction: true });
  const review = prCard({ id: "review-1", lane: "operator-review" });
  const checking = prCard({ id: "check-1", lane: "hermes-checking" });
  const task = taskCard({ id: "task-1" });
  const draft = draftCard({ id: "draft-1" });
  const deploy = deployCard({ id: "deploy-1" });
  const done = doneCard({ id: "done-1" });

  const result = groupByLane([action, review, checking, task, draft, deploy, done]);
  assert.deepEqual(result["needs-attention"].map(c => c.id), ["action-1"]);
  assert.deepEqual(result["operator-review"].map(c => c.id), ["review-1"]);
  assert.deepEqual(result["hermes-checking"].map(c => c.id), ["check-1"]);
  assert.deepEqual(result["codex-needed"].map(c => c.id), ["task-1"]);
  assert.deepEqual(result["drafts"].map(c => c.id), ["draft-1"]);
  assert.deepEqual(result["deploying"].map(c => c.id), ["deploy-1"]);
  assert.deepEqual(result["done"].map(c => c.id), ["done-1"]);
  assert.deepEqual(result["release-queue"], []);
});

test("groupByLane: preserves input order within each lane (stable)", () => {
  const a = prCard({ id: "a", lane: "operator-review" });
  const b = prCard({ id: "b", lane: "operator-review" });
  const c = prCard({ id: "c", lane: "operator-review" });
  const result = groupByLane([a, b, c]);
  assert.deepEqual(result["operator-review"].map(card => card.id), ["a", "b", "c"]);
});

test("groupByLane: handles non-array input defensively", () => {
  // @ts-expect-error — intentionally passing a non-array
  const result = groupByLane(undefined);
  for (const lane of LANES) {
    assert.deepEqual(result[lane], []);
  }
});

// ── laneCounts ──────────────────────────────────────────────────────

test("laneCounts: empty input returns 0 for every lane", () => {
  const result = laneCounts([]);
  for (const lane of LANES) {
    assert.equal(result[lane], 0, `expected count for ${lane} to be 0`);
  }
});

test("laneCounts: mixed input returns correct per-lane totals", () => {
  const cards = [
    prCard({ id: "a", isAction: true }),
    prCard({ id: "b", lane: "operator-review" }),
    prCard({ id: "c", lane: "operator-review" }),
    taskCard({ id: "d" }),
    doneCard({ id: "e" }),
    doneCard({ id: "f" }),
    doneCard({ id: "g" }),
  ];
  const result = laneCounts(cards);
  assert.equal(result["needs-attention"], 1);
  assert.equal(result["operator-review"], 2);
  assert.equal(result["codex-needed"], 1);
  assert.equal(result["done"], 3);
  assert.equal(result["drafts"], 0);
  assert.equal(result["hermes-checking"], 0);
  assert.equal(result["release-queue"], 0);
  assert.equal(result["deploying"], 0);
});
