import test from "node:test";
import assert from "node:assert/strict";

import {
  DRAFT_VIOLATIONS,
  checkDraft,
  numbersIn,
  screenVariants,
  unsourcedNumbers
} from "./social-draft-check.mjs";

const OBSERVED = {
  "flow.jobsSettled.allTime": { value: 254, status: "fresh" },
  "flow.settledToExternalWallets24h": { value: 0, status: "fresh" }
};

const SOURCES = [
  "Merged: Measure both sides of the x402 rail and size the Hub inventory",
  "0.202% moving 10 USDC, ~21% on dust. At a $2 leg and 2% tolerated friction: $100 a time, about 95 postings. Hub pool 3.345 USDC liquid."
];

const ctx = (over = {}) => ({ observed: OBSERVED, sources: SOURCES, ...over });

test("a truthful draft passes clean", () => {
  const draft =
    "We measured both sides of the x402 rail. A rebalance costs about the same however much it moves — 0.202% on 10 USDC, ~21% on dust. So the fee sets the minimum move: about $100 a time, 95 postings of runway.";

  assert.deepEqual(checkDraft(draft, ctx()), []);
});

// --- the trap the whole pipeline exists to stop -----------------------------

test("claiming outside agents are earning is rejected while the payload says zero", () => {
  const draft = "We measured the x402 rail. External agents are already earning on Averray.";

  const [violation] = checkDraft(draft, ctx());

  assert.equal(violation.reason, DRAFT_VIOLATIONS.EXTERNAL_ACTIVITY);
  assert.match(violation.detail, /settledToExternalWallets24h is 0/u);
});

test("the softer phrasings are caught too", () => {
  for (const phrase of [
    "outside agents are picking up work",
    "third-party agents have started",
    "other agents are using it",
    "agents are earning real money"
  ]) {
    assert.equal(
      checkDraft(`We shipped the rail. ${phrase}.`, ctx({ deployVerified: null })).some(
        (v) => v.reason === DRAFT_VIOLATIONS.EXTERNAL_ACTIVITY
      ),
      true,
      `"${phrase}" should be rejected`
    );
  }
});

test("a STALE zero accuses nobody — we do not police from a number we distrust", () => {
  const stale = { "flow.settledToExternalWallets24h": { value: 0, status: "stale" } };

  assert.deepEqual(checkDraft("External agents are earning.", { observed: stale, sources: [] }), []);
});

test("once the payload actually shows outsiders, the claim is allowed", () => {
  const live = { "flow.settledToExternalWallets24h": { value: 2, status: "fresh" } };

  assert.deepEqual(
    checkDraft("Two external agents completed work today.", {
      observed: live,
      sources: ["2 external agents completed work"]
    }),
    []
  );
});

// --- merged is not deployed -------------------------------------------------

test("deploy language is rejected when the merge was never verified as deployed", () => {
  const [violation] = checkDraft("We shipped the x402 rail today.", ctx({ deployVerified: false }));

  assert.equal(violation.reason, DRAFT_VIOLATIONS.UNVERIFIED_DEPLOY);
  assert.match(violation.detail, /merged is not shipped/u);
});

test("every deploy phrasing is covered", () => {
  for (const phrase of ["shipped", "launched", "released", "now live", "is live", "went live", "in production", "now available"]) {
    assert.equal(
      checkDraft(`The rail ${phrase}.`, ctx({ deployVerified: false })).some(
        (v) => v.reason === DRAFT_VIOLATIONS.UNVERIFIED_DEPLOY
      ),
      true,
      `"${phrase}" should be rejected`
    );
  }
});

test("deploy language is fine when nothing claims otherwise", () => {
  assert.deepEqual(checkDraft("The rail is live.", ctx({ deployVerified: null })), []);
});

// --- invented figures -------------------------------------------------------

test("a number that appears nowhere in the source is rejected", () => {
  const [violation] = checkDraft("We have processed 4,812 jobs on the rail.", ctx());

  assert.equal(violation.reason, DRAFT_VIOLATIONS.UNSOURCED_NUMBER);
  assert.match(violation.detail, /4812/u);
});

test("figures drawn from the source material pass", () => {
  assert.deepEqual(checkDraft("0.202% at scale, ~21% on dust, 95 postings.", ctx()), []);
});

test("a figure from the observed reading passes", () => {
  assert.deepEqual(checkDraft("254 jobs have settled.", ctx()), []);
});

test("thousands separators do not create false positives", () => {
  const observed = { "flow.chain.head": { value: 19290804, status: "fresh" } };

  assert.deepEqual(checkDraft("block 19,290,804", { observed, sources: [] }), []);
});

test("small integers are exempt — prose is full of them", () => {
  assert.deepEqual(checkDraft("Both sides of the rail, measured 2 ways.", ctx()), []);
});

test("a decimal is never exempt, however small", () => {
  const violations = checkDraft("friction was 0.94%", ctx());

  assert.equal(violations[0].reason, DRAFT_VIOLATIONS.UNSOURCED_NUMBER);
});

test("numbersIn normalises separators and trailing stops", () => {
  assert.deepEqual(numbersIn("19,290,804 and 0.202."), ["19290804", "0.202"]);
});

test("unsourcedNumbers reports only what is genuinely absent", () => {
  assert.deepEqual(unsourcedNumbers("95 and 4812", ["about 95 postings"]), ["4812"]);
});

// --- screening a set --------------------------------------------------------

test("screening keeps the clean variants and reports why the others died", () => {
  const { passed, rejected } = screenVariants(
    [
      "0.202% at scale versus ~21% on dust — the same absolute cost.",
      "External agents are earning on Averray.",
      { text: "We shipped it and processed 9,999 jobs." }
    ],
    ctx({ deployVerified: false })
  );

  assert.equal(passed.length, 1);
  assert.match(passed[0], /0\.202%/u);
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].violations[0].reason, DRAFT_VIOLATIONS.EXTERNAL_ACTIVITY);
  assert.deepEqual(
    rejected[1].violations.map((v) => v.reason).sort(),
    [DRAFT_VIOLATIONS.UNSOURCED_NUMBER, DRAFT_VIOLATIONS.UNVERIFIED_DEPLOY].sort()
  );
});

test("blank variants are dropped rather than counted as passing", () => {
  const { passed, rejected } = screenVariants(["", "   ", null], ctx());

  assert.deepEqual(passed, []);
  assert.deepEqual(rejected, []);
});
