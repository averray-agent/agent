import test from "node:test";
import assert from "node:assert/strict";

import {
  DRAFT_MARKER,
  VARIANT_DELIMITER,
  buildPrompt,
  commentBodyFor,
  deployVerifiedFrom,
  findIssuesNeedingDrafts,
  parseVariants,
  publishDraft,
  readObserved
} from "./social-draft-writer.mjs";

const ISSUE_BODY = [
  "<!-- social-signal:shipped-pr-1029 -->",
  "**Merged: Measure both sides of the x402 rail and size the Hub inventory**",
  "",
  "### What the author said it does",
  "> 0.202% moving 10 USDC, ~21% on dust. At a $2 leg: $100 a time, about 95 postings.",
  "",
  "> **Merged is not deployed.** This claim says *merged* on purpose."
].join("\n");

const ISSUE = { number: 1036, title: "Merged: …", body: ISSUE_BODY };

const SNAPSHOT = {
  flow: {
    jobsSettled: { allTime: { value: 254, status: "fresh" } },
    settledToExternalWallets24h: { value: 0, status: "fresh" }
  }
};

/** Fake GitHub + transparency, recording what was posted. */
function fakeNet({ issues = [], comments = {}, listStatus = 200 } = {}) {
  const posted = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/transparency")) {
      return { ok: true, status: 200, json: async () => SNAPSHOT };
    }
    if ((init.method ?? "GET") === "POST") {
      posted.push({ url: u, body: JSON.parse(init.body).body });
      return { ok: true, status: 201, json: async () => ({ id: 1 }) };
    }
    const m = u.match(/\/issues\/(\d+)\/comments/u);
    if (m) return { ok: true, status: 200, json: async () => (comments[m[1]] ?? []).map((b) => ({ body: b })) };
    return { ok: listStatus === 200, status: listStatus, json: async () => issues };
  };
  return { fetchImpl, posted };
}

test("issues that already carry a draft are skipped", async () => {
  const { fetchImpl } = fakeNet({
    issues: [{ number: 1, body: "a" }, { number: 2, body: "b" }],
    comments: { 1: [`${DRAFT_MARKER}\nalready drafted`], 2: ["unrelated chatter"] }
  });

  const needing = await findIssuesNeedingDrafts({ fetchImpl, token: "t", repo: "o/r" });

  assert.deepEqual(needing.map((i) => i.number), [2]);
});

test("pull requests are never drafted for", async () => {
  const { fetchImpl } = fakeNet({
    issues: [{ number: 9, body: "x", pull_request: { url: "p" } }],
    comments: {}
  });

  assert.deepEqual(await findIssuesNeedingDrafts({ fetchImpl, token: "t", repo: "o/r" }), []);
});

test("a failed list throws — zero issues must not mean the API was down", async () => {
  const { fetchImpl } = fakeNet({ listStatus: 503 });

  await assert.rejects(
    () => findIssuesNeedingDrafts({ fetchImpl, token: "t", repo: "o/r" }),
    /responded 503/u
  );
});

test("the prompt carries the issue and forbids the two traps by name", () => {
  const prompt = buildPrompt(ISSUE);

  assert.ok(prompt.includes(ISSUE_BODY), "the material must reach the model");
  assert.match(prompt, /Every number you write must appear in the issue/u);
  assert.match(prompt, /outside or external agents/u);
  assert.match(prompt, /Do not say shipped, launched, released, live/u);
  assert.match(prompt, new RegExp(VARIANT_DELIMITER));
});

test("the merged-is-not-deployed note is read back off the issue", () => {
  assert.equal(deployVerifiedFrom(ISSUE_BODY), false);
  assert.equal(deployVerifiedFrom("a transparency signal with no such note"), null);
});

test("variants are split on the delimiter", () => {
  const raw = `first post\n${VARIANT_DELIMITER}\nsecond post`;

  assert.deepEqual(parseVariants(raw), ["first post", "second post"]);
});

test("a code fence around a variant is stripped", () => {
  const raw = `${VARIANT_DELIMITER}\n\`\`\`text\nthe post\n\`\`\``;

  assert.deepEqual(parseVariants(raw), ["the post"]);
});

test("output with no delimiter is still usable as one variant", () => {
  assert.deepEqual(parseVariants("just one block"), ["just one block"]);
  assert.deepEqual(parseVariants("   "), []);
});

test("the model's reasoning is never published as a variant", () => {
  // Shape copied from a real `hermes chat -q` run on 2026-08-12. The CLI echoes
  // the prompt, thinks aloud, THEN boxes the answer. A parser that only split
  // on the delimiter published "Let me write 2-3 posts following all the rules"
  // as variant one — and the draft check would not have caught it, because
  // narrating your instructions contains no false claim, just no post.
  const raw = [
    "Query: You are drafting short posts for the Averray X account.",
    "",
    "Let me write 2-3 posts following all the rules:",
    "- Use only facts present",
    "- Every number must appear in the issue",
    "",
    "Let me craft the posts:",
    "└──────────────────────────────────────────┘",
    "",
    "╭─ ⚕ Hermes ───────────────────────────────╮",
    "PR #1029 merged. Both sides of the x402 rail are now measured.",
    "",
    VARIANT_DELIMITER,
    "x402 rail measurement now covers both sides. Merged 2026-08-10.",
    "╰──────────────────────────────────────────╯",
    "",
    "Resume this session with:",
    "  hermes --resume 20260812_122120_5d4e0e"
  ].join("\n");

  const variants = parseVariants(raw);

  assert.equal(variants.length, 2, "only the boxed answer counts");
  assert.match(variants[0], /^PR #1029 merged\./u);
  assert.match(variants[1], /^x402 rail measurement/u);
  for (const v of variants) {
    assert.doesNotMatch(v, /Let me write/u, "reasoning must never survive");
    assert.doesNotMatch(v, /Resume this session/u, "the footer must never survive");
    assert.doesNotMatch(v, /[╭╰│└]/u, "no box chrome");
  }
});

test("output without the Hermes box is passed through rather than dropped", () => {
  // A different provider, or a plain-stdout mode, must not silently yield zero
  // variants — that would look exactly like a model that refused to answer.
  const raw = `first post\n${VARIANT_DELIMITER}\nsecond post`;

  assert.deepEqual(parseVariants(raw), ["first post", "second post"]);
});

test("the live reading is what the screen judges against", async () => {
  const { fetchImpl } = fakeNet();

  const observed = await readObserved({ fetchImpl });

  assert.equal(observed["flow.settledToExternalWallets24h"].value, 0);
  assert.equal(observed["flow.jobsSettled.allTime"].value, 254);
});

// --- the whole point: what actually gets posted -----------------------------

test("a clean variant is posted; an invented figure and a deploy claim are not", async () => {
  const { fetchImpl, posted } = fakeNet({ issues: [], comments: {} });

  const raw = [
    "0.202% moving 10 USDC, ~21% on dust — the same absolute cost.",
    "We shipped the x402 rail today.",
    "Averray has now processed 8,412 jobs on the rail."
  ].join(`\n${VARIANT_DELIMITER}\n`);

  const result = await publishDraft({
    fetchImpl,
    env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" },
    issue: ISSUE,
    raw
  });

  assert.equal(result.passed, 1);
  assert.equal(result.rejected, 2);

  const body = posted[0].body;
  assert.ok(body.startsWith(DRAFT_MARKER), "the comment is anchored so it is written once");
  assert.match(body, /0\.202%/u);
  assert.match(body, /Rejected by the draft check/u);
  assert.match(body, /claims-deployed/u);
  assert.match(body, /unsourced-number/u);
  assert.doesNotMatch(body.split("Rejected by the draft check")[0], /8,?412/u);
});

test("when nothing survives, that is said plainly and the issue stays open", () => {
  const body = commentBodyFor({
    passed: [],
    rejected: [{ text: "External agents are earning.", violations: [{ reason: "claims-external-activity", detail: "d" }] }]
  });

  assert.match(body, /Nothing survived the check/u);
  assert.match(body, /finding about the drafting, not about the signal/u);
});

test("rejected variants are always shown — a silent filter is one nobody audits", () => {
  const body = commentBodyFor({
    passed: ["a good one"],
    rejected: [{ text: "bad", violations: [{ reason: "unsourced-number", detail: "9999" }] }]
  });

  assert.match(body, /a good one/u);
  assert.match(body, /9999/u);
});
