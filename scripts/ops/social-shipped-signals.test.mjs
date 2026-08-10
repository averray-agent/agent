import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_SHIPPED_LABEL,
  assessGitHub,
  buildShippedCandidates,
  fetchShippedPullRequests,
  summariseBody
} from "./social-shipped-signals.mjs";

const NOW_ISO = "2026-08-10T12:00:00.000Z";

function pull(number, mergedAt, title = `change ${number}`) {
  return {
    number,
    title,
    url: `https://github.com/averray-agent/agent/pull/${number}`,
    mergedAt
  };
}

test("an unconfigured source is skipped, not degraded — off is not broken", () => {
  assert.deepEqual(assessGitHub({ env: {} }), {
    state: "skipped",
    reason: "GITHUB_TOKEN not set"
  });
  assert.equal(assessGitHub({ env: { GITHUB_TOKEN: "t" } }).state, "skipped");
  assert.equal(
    assessGitHub({ env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" } }).state,
    "live"
  );
});

test("the label defaults to the repo's plain-word convention", () => {
  assert.equal(DEFAULT_SHIPPED_LABEL, "social");
});

test("a failed search throws — an empty list must only ever mean 'nothing is labelled'", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });

  await assert.rejects(
    () => fetchShippedPullRequests({ fetchImpl, token: "t", repo: "o/r" }),
    /GitHub search responded 403/u
  );
});

test("a 200 without an items array throws rather than reading as 'nothing shipped'", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });

  await assert.rejects(
    () => fetchShippedPullRequests({ fetchImpl, token: "t", repo: "o/r" }),
    /refusing to read it as 'nothing shipped'/u
  );
});

test("the search is scoped to merged PRs carrying the label", async () => {
  let seen = "";
  const fetchImpl = async (url) => {
    seen = url;
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };

  await fetchShippedPullRequests({ fetchImpl, token: "t", repo: "averray-agent/agent" });

  const query = decodeURIComponent(seen);
  assert.match(query, /repo:averray-agent\/agent/u);
  assert.match(query, /is:pr/u);
  assert.match(query, /is:merged/u);
  assert.match(query, /label:social/u);
});

test("the first encounter seeds and announces nothing", () => {
  const { candidates, nextShippedSeededAt, seeding } = buildShippedCandidates({
    pulls: [pull(10, "2026-08-01T00:00:00Z"), pull(11, "2026-08-05T00:00:00Z")],
    state: {},
    nowIso: NOW_ISO
  });

  assert.equal(seeding, true);
  assert.equal(candidates.length, 2);
  assert.ok(
    candidates.every((c) => c.seedOnly),
    "a backlog of already-labelled PRs must never open as today's news"
  );
  assert.equal(nextShippedSeededAt, NOW_ISO);
});

test("labelling an OLD merged PR still fires — the label is the decision, not the merge date", () => {
  // An earlier draft watermarked on merge time, so labelling last week's PR did
  // nothing at all. A decision that silently does nothing is worse than one
  // that fires late.
  const { candidates, seeding } = buildShippedCandidates({
    pulls: [pull(10, "2026-06-01T00:00:00Z", "something from June")],
    state: { shippedSeededAt: "2026-08-05T00:00:00Z" },
    nowIso: NOW_ISO
  });

  assert.equal(seeding, false);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].signalId, "shipped-pr-10");
  assert.equal(candidates[0].seedOnly, false);
});

test("the seeded marker is set once and never moves", () => {
  const { nextShippedSeededAt } = buildShippedCandidates({
    pulls: [pull(12, "2026-08-09T00:00:00Z")],
    state: { shippedSeededAt: "2026-08-05T00:00:00Z" },
    nowIso: NOW_ISO
  });

  assert.equal(nextShippedSeededAt, "2026-08-05T00:00:00Z");
});

test("a PR that already fired never fires again", () => {
  const { candidates } = buildShippedCandidates({
    pulls: [pull(12, "2026-08-09T00:00:00Z")],
    state: {
      shippedSeededAt: "2026-08-05T00:00:00Z",
      firedSignals: { "shipped-pr-12": { firedAt: NOW_ISO } }
    },
    nowIso: NOW_ISO
  });

  assert.deepEqual(candidates, []);
});

test("the claim says MERGED — never shipped, live or launched", () => {
  const { candidates } = buildShippedCandidates({
    pulls: [pull(12, "2026-08-09T00:00:00Z", "Arm the x402 poster ramp")],
    state: { shippedSeededAt: "2026-08-05T00:00:00Z" },
    nowIso: NOW_ISO
  });

  // merged ≠ deployed. A claim of "shipped" about something not yet on
  // production is exactly the "more live than it is" failure.
  assert.equal(candidates[0].claim, "Merged: Arm the x402 poster ramp");
  assert.doesNotMatch(candidates[0].claim, /\b(shipped|live|launched|released)\b/iu);
  assert.equal(candidates[0].deployVerified, false);
});

test("the receipt is the pull request itself", () => {
  const { candidates } = buildShippedCandidates({
    pulls: [pull(12, "2026-08-09T00:00:00Z")],
    state: { shippedSeededAt: "2026-08-05T00:00:00Z" },
    nowIso: NOW_ISO
  });

  assert.equal(candidates[0].receipt.kind, "pull-request");
  assert.equal(candidates[0].receipt.url, "https://github.com/averray-agent/agent/pull/12");
  assert.equal(candidates[0].receipt.mergedAt, "2026-08-09T00:00:00Z");
});

test("candidates are ordered oldest merge first", () => {
  const { candidates } = buildShippedCandidates({
    pulls: [pull(14, "2026-08-09T00:00:00Z"), pull(13, "2026-08-07T00:00:00Z")],
    state: { shippedSeededAt: "2026-08-05T00:00:00Z" },
    nowIso: NOW_ISO
  });

  assert.deepEqual(
    candidates.map((c) => c.signalId),
    ["shipped-pr-13", "shipped-pr-14"]
  );
});

test("the COMMITTED state carries the seeded marker — without it the source is silently inert", async () => {
  // Not a unit test of logic; a guard on an operational precondition that has
  // already bitten once.
  //
  // The runner writes state to its ephemeral checkout, so nothing it seeds
  // survives the job. If the committed marker is missing, every run reads it as
  // absent, treats itself as the first encounter, and records a labelled pull
  // request as SEEDED — announced to nobody — forever. The feature would look
  // wired and do nothing.
  const committed = JSON.parse(
    await readFile(new URL("./social-signal-state.json", import.meta.url), "utf8")
  );

  assert.ok(
    committed.shippedSeededAt,
    "scripts/ops/social-signal-state.json must carry shippedSeededAt, or labelled PRs are seeded instead of fired"
  );

  // And prove the consequence: with that marker, a labelled PR actually fires.
  const { candidates } = buildShippedCandidates({
    pulls: [pull(99, "2026-08-09T00:00:00Z", "something worth saying")],
    state: committed,
    nowIso: NOW_ISO
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].seedOnly, false, "a labelled PR must fire, not seed");
});

test("an empty result produces nothing and changes nothing", () => {
  const { candidates, nextShippedSeededAt } = buildShippedCandidates({
    pulls: [],
    state: { shippedSeededAt: "2026-08-05T00:00:00Z" },
    nowIso: NOW_ISO
  });

  assert.deepEqual(candidates, []);
  assert.equal(nextShippedSeededAt, "2026-08-05T00:00:00Z");
});

test("the author's summary is carried, never paraphrased", () => {
  const body = "We measured the leg cost at $2.\n\nThat sets the minimum move.";

  assert.equal(summariseBody(body), "We measured the leg cost at $2.\n\nThat sets the minimum move.");
});

test("PR furniture is dropped — headings, HTML comments, the tooling trailer", () => {
  const body = [
    "<!-- a hidden marker -->",
    "",
    "## What this does",
    "",
    "The real content.",
    "",
    "---",
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
  ].join("\n");

  const summary = summariseBody(body);

  assert.equal(summary, "The real content.");
  assert.doesNotMatch(summary, /hidden marker/u);
  assert.doesNotMatch(summary, /Claude Code/u);
});

test("an overlong body is truncated rather than dropped", () => {
  const summary = summariseBody("x".repeat(4000));

  assert.ok(summary.length <= 1201, "kept within the issue-readable budget");
  assert.ok(summary.endsWith("…"));
});

test("an empty body yields an empty summary, not a crash", () => {
  assert.equal(summariseBody(), "");
  assert.equal(summariseBody(null), "");
});

test("a candidate carries the material to write from", () => {
  const { candidates } = buildShippedCandidates({
    pulls: [{ ...pull(12, "2026-08-09T00:00:00Z"), body: "We measured 0.202% friction." }],
    state: { shippedSeededAt: "2026-08-05T00:00:00Z" },
    nowIso: NOW_ISO
  });

  assert.equal(candidates[0].context, "We measured 0.202% friction.");
});
