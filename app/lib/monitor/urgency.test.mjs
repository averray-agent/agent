// Tests for urgency.js — freshness math + urgency sorting for the
// Hermes Handoff Monitor. M1 milestone.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FRESH_THRESHOLD_MINUTES,
  WARM_THRESHOLD_MINUTES,
  SETTLING_THRESHOLD_MINUTES,
  STALE_THRESHOLD_MINUTES,
  ARCHIVE_HINT_THRESHOLD_MINUTES,
  freshnessTier,
  shouldSuggestArchive,
  formatFreshness,
  sortByUrgency,
  urgencyRank,
} from "./urgency.js";

// ── freshnessTier ───────────────────────────────────────────────────

test("freshnessTier: 0 minutes is fresh", () => {
  assert.equal(freshnessTier(0), "fresh");
});

test("freshnessTier: just below FRESH_THRESHOLD is still fresh", () => {
  assert.equal(freshnessTier(FRESH_THRESHOLD_MINUTES - 0.1), "fresh");
});

test("freshnessTier: exactly FRESH_THRESHOLD is warm", () => {
  // The boundary belongs to the next tier — "< 5" is fresh, "5" is warm.
  assert.equal(freshnessTier(FRESH_THRESHOLD_MINUTES), "warm");
});

test("freshnessTier: warm range (5–29 min)", () => {
  assert.equal(freshnessTier(5), "warm");
  assert.equal(freshnessTier(15), "warm");
  assert.equal(freshnessTier(29.9), "warm");
});

test("freshnessTier: settling range (30 min – 4 h)", () => {
  assert.equal(freshnessTier(WARM_THRESHOLD_MINUTES), "settling");
  assert.equal(freshnessTier(120), "settling");
  assert.equal(freshnessTier(SETTLING_THRESHOLD_MINUTES - 0.1), "settling");
});

test("freshnessTier: stale range (4 h – 24 h)", () => {
  assert.equal(freshnessTier(SETTLING_THRESHOLD_MINUTES), "stale");
  assert.equal(freshnessTier(600), "stale");
  assert.equal(freshnessTier(STALE_THRESHOLD_MINUTES - 0.1), "stale");
});

test("freshnessTier: ancient (>= 24 h)", () => {
  assert.equal(freshnessTier(STALE_THRESHOLD_MINUTES), "ancient");
  assert.equal(freshnessTier(48 * 60), "ancient");
  assert.equal(freshnessTier(10000), "ancient");
});

test("freshnessTier: defensive on garbage input", () => {
  assert.equal(freshnessTier(undefined), "settling");
  assert.equal(freshnessTier(null), "settling");
  // @ts-expect-error — exercising non-number path
  assert.equal(freshnessTier("not a number"), "settling");
  assert.equal(freshnessTier(NaN), "settling");
  assert.equal(freshnessTier(Infinity), "settling");
  assert.equal(freshnessTier(-5), "settling");
});

// ── formatFreshness ─────────────────────────────────────────────────

test("formatFreshness: minutes < 60 → integer + M", () => {
  assert.equal(formatFreshness(0), "0M");
  assert.equal(formatFreshness(3), "3M");
  assert.equal(formatFreshness(12.4), "12M");
  assert.equal(formatFreshness(59), "59M");
});

test("formatFreshness: hours range — 60 to 48 h → H suffix with optional decimal", () => {
  assert.equal(formatFreshness(60), "1H");
  assert.equal(formatFreshness(90), "1.5H");
  assert.equal(formatFreshness(600), "10H");          // ≥10h → no decimal
  assert.equal(formatFreshness(2880 - 60), "47H");
});

test("formatFreshness: days range — 48h+ → D suffix", () => {
  assert.equal(formatFreshness(2880), "2D");
  assert.equal(formatFreshness(60 * 24 * 7), "7D");
  assert.equal(formatFreshness(60 * 24 * 30), "30D");
});

test("formatFreshness: null/undefined/non-number returns null", () => {
  assert.equal(formatFreshness(null), null);
  assert.equal(formatFreshness(undefined), null);
  // @ts-expect-error — exercising non-number path
  assert.equal(formatFreshness("abc"), null);
  assert.equal(formatFreshness(NaN), null);
  assert.equal(formatFreshness(-1), null);
});

// ── shouldSuggestArchive ────────────────────────────────────────────

test("shouldSuggestArchive: ancient card returns true", () => {
  const card = { freshness: ARCHIVE_HINT_THRESHOLD_MINUTES + 1, lane: "operator-review" };
  assert.equal(shouldSuggestArchive(card), true);
});

test("shouldSuggestArchive: stale-but-not-ancient card returns false", () => {
  const card = { freshness: 1000, lane: "operator-review" };  // ~17h
  assert.equal(shouldSuggestArchive(card), false);
});

test("shouldSuggestArchive: done lane never suggests archive (already archived)", () => {
  const card = { freshness: 9999, lane: "done" };
  assert.equal(shouldSuggestArchive(card), false);
});

test("shouldSuggestArchive: drafts never suggest archive (different lifecycle)", () => {
  const card = { freshness: 9999, lane: "drafts", isDraft: true };
  assert.equal(shouldSuggestArchive(card), false);
});

test("shouldSuggestArchive: action items never suggest archive", () => {
  const card = { freshness: 9999, lane: "needs-attention", isAction: true };
  assert.equal(shouldSuggestArchive(card), false);
});

test("shouldSuggestArchive: server-set hint always wins", () => {
  const card = { freshness: 5, lane: "operator-review", archiveHint: true };
  assert.equal(shouldSuggestArchive(card), true);
});

test("shouldSuggestArchive: null/undefined card returns false (defensive)", () => {
  assert.equal(shouldSuggestArchive(null), false);
  assert.equal(shouldSuggestArchive(undefined), false);
});

// ── urgencyRank ─────────────────────────────────────────────────────

test("urgencyRank: isAction outranks everything", () => {
  assert.equal(urgencyRank({ isAction: true, freshness: 9999 }), 0);
  assert.equal(urgencyRank({ isAction: true, checks: { fail: 5 } }), 0);
});

test("urgencyRank: failing checks rank ahead of fresh non-action work", () => {
  assert.ok(
    urgencyRank({ checks: { fail: 1, pass: 0, running: 0, pending: 0, total: 1 } }) <
    urgencyRank({ freshness: 1 })
  );
});

test("urgencyRank: waiting-on-operator with warn tone outranks fresh non-action", () => {
  const opWarn = urgencyRank({ waitingOn: { actor: "operator", tone: "warn" }, freshness: 100 });
  const fresh = urgencyRank({ freshness: 1 });
  assert.ok(opWarn < fresh, `expected opWarn (${opWarn}) < fresh (${fresh})`);
});

test("urgencyRank: tier order — fresh < warm < settling < stale < ancient", () => {
  const fresh = urgencyRank({ freshness: 1 });
  const warm = urgencyRank({ freshness: 10 });
  const settling = urgencyRank({ freshness: 60 });
  const stale = urgencyRank({ freshness: 600 });
  const ancient = urgencyRank({ freshness: 9999 });
  assert.ok(fresh < warm);
  assert.ok(warm < settling);
  assert.ok(settling < stale);
  assert.ok(stale < ancient);
});

test("urgencyRank: null card returns 100 (lowest priority)", () => {
  assert.equal(urgencyRank(null), 100);
  assert.equal(urgencyRank(undefined), 100);
});

// ── sortByUrgency ───────────────────────────────────────────────────

test("sortByUrgency: action card first, then failing, then operator-warn, then fresh, then older", () => {
  const action = { id: "act", isAction: true, freshness: 200 };
  const failing = { id: "fail", checks: { fail: 1, pass: 0, running: 0, pending: 0, total: 1 }, freshness: 30 };
  const opWarn = { id: "opwarn", waitingOn: { actor: "operator", tone: "warn" }, freshness: 100 };
  const fresh = { id: "fresh", freshness: 1 };
  const stale = { id: "stale", freshness: 1000 };

  const sorted = sortByUrgency([stale, fresh, opWarn, failing, action]);
  assert.deepEqual(sorted.map(c => c.id), ["act", "fail", "opwarn", "fresh", "stale"]);
});

test("sortByUrgency: within a tier, more recent (lower freshness) wins", () => {
  const a = { id: "a", freshness: 1 };
  const b = { id: "b", freshness: 3 };
  const c = { id: "c", freshness: 0.5 };
  const sorted = sortByUrgency([a, b, c]);
  assert.deepEqual(sorted.map(card => card.id), ["c", "a", "b"]);
});

test("sortByUrgency: does not mutate the input", () => {
  const input = [{ id: "a", freshness: 5 }, { id: "b", freshness: 2 }];
  const inputCopy = input.map(card => ({ ...card }));
  const sorted = sortByUrgency(input);
  assert.deepEqual(input, inputCopy, "input should be untouched");
  // and the sort actually ran
  assert.deepEqual(sorted.map(c => c.id), ["b", "a"]);
});

test("sortByUrgency: handles non-array input defensively", () => {
  // @ts-expect-error — intentional
  assert.deepEqual(sortByUrgency(undefined), []);
  // @ts-expect-error — intentional
  assert.deepEqual(sortByUrgency(null), []);
});
