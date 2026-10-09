import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MemoryStateStore } from "../core/state-store.js";
import { PlatformService } from "../core/platform-service.js";
import { boundGithubAuthor, createGithubAuthorsProvider, readGithubAuthors } from "./github-author-visibility.js";

const now = new Date("2026-10-08T12:00:00Z");
const wallet = (n) => "0x" + n.toString(16).padStart(40, "0");
const lookup = (author, extra = {}) => ({ status: "verified", author: { login: author },
  claimantBinding: { status: "matched", walletMatches: true }, merged: false, ...extra });
async function add(store, id, author, status = "submitted", extra = {}) {
  const session = { sessionId: String(id), wallet: wallet(id), status,
    jobSnapshot: { definition: { verifierMode: "github_pr" } }, ...extra };
  await store.upsertSession(session);
  if (author) await store.upsertMutationReceipt("github_pr_author", session.sessionId, {
    githubLookup: lookup(author), previewOutcome: "approved"
  });
  return session;
}

test("one PR author across fourteen wallets is one author; concentration is strictly more than half", async () => {
  const store = new MemoryStateStore();
  for (let i = 1; i <= 14; i++) await add(store, i, i % 2 ? "Worker" : "worker");
  await add(store, 15, "other");
  await add(store, 16, null, "claimed", { submission: { author: "invented" } });
  let result = await readGithubAuthors(store, { now });
  assert.equal(result.distinctAuthors, 2);
  assert.equal(result.distinctWallets, 16);
  assert.equal(result.openClaims, 16);
  assert.equal(result.unattributedClaims, 1);
  assert.deepEqual(result.authors[0], { author: "worker", openClaims: 14, submitted: 14,
    awaitingHumanReview: 14, settled7d: 0, settled30d: 0, distinctWallets: 14,
    usdcPaid: { raw: "0", amount: "0", missingPayoutEvidence: 0 } });
  assert.equal(result.warnings[0].code, "github_author_concentration");
  assert.deepEqual(Object.keys(result.warnings[0]).sort(), ["code", "severity", "openClaims", "totalOpenClaims", "distinctWallets"].sort());
  for (let i = 17; i <= 28; i++) await add(store, i, null, "claimed");
  result = await readGithubAuthors(store, { now });
  assert.equal(result.openClaims, 28);
  assert.deepEqual(result.warnings, [], "exactly half is not a concentration warning");
});

test("settled windows and USDC totals use receipt evidence, not rewards; merged approval is not human review", async () => {
  const store = new MemoryStateStore();
  for (const [id, age, amount] of [[1, 2, "1200000"], [2, 8, "200000"], [3, 31, "100000"]]) {
    await add(store, id, "worker", "resolved", { resolvedAt: new Date(+now - age * 86_400_000).toISOString(),
      verificationSummary: { outcome: "approved" },
      payoutTx: { status: 1, settlement: { assetSymbol: "USDC", workerAmountRaw: amount } } });
  }
  await add(store, 4, "worker");
  await store.upsertMutationReceipt("github_pr_author", "4", { githubLookup: lookup("worker", { merged: true }), previewOutcome: "approved" });
  let result = await readGithubAuthors(store, { now });
  assert.equal(result.authors[0].settled7d, 1);
  assert.equal(result.authors[0].settled30d, 2);
  assert.equal(result.authors[0].usdcPaid.raw, "1500000");
  assert.equal(result.authors[0].awaitingHumanReview, 0);
  await add(store, 5, "worker", "resolved", { rewardAmount: 9999 });
  result = await readGithubAuthors(store, { now });
  assert.equal(result.authors[0].usdcPaid.amount, null);
  assert.equal(result.authors[0].usdcPaid.missingPayoutEvidence, 1);
});

test("concentration needs at least three open claims and does not leak an author", async () => {
  const store = new MemoryStateStore();
  for (let id = 1; id <= 3; id++) {
    await add(store, id, "private-author");
    const result = await readGithubAuthors(store, { now });
    assert.equal(result.warnings.length, id >= 3 ? 1 : 0);
    assert.ok(!JSON.stringify(result.warnings).includes("private-author"));
  }
});

test("unavailable settlement lookup cannot shadow a bound observation; bound settlement wins", async () => {
  const store = new MemoryStateStore();
  await add(store, 1, "observed");
  await store.upsertVerificationResult("1", { githubLookup: lookup("unavailable", { status: "unavailable" }) });
  assert.equal((await readGithubAuthors(store, { now })).authors[0].author, "observed");
  await store.upsertVerificationResult("1", { githubLookup: lookup("settled") });
  assert.equal((await readGithubAuthors(store, { now })).authors[0].author, "settled");
});

test("unverified or unbound authors are unknown; settlement verification author is retained without an observation", async () => {
  for (const value of [lookup("worker", { status: "unavailable" }), lookup("worker", { claimantBinding: { status: "missing" } }),
    { author: { login: "worker" } }]) assert.equal(boundGithubAuthor(value), null);
  const store = new MemoryStateStore();
  await add(store, 1, null, "resolved");
  await store.upsertVerificationResult("1", { githubLookup: lookup("ActualAuthor") });
  assert.equal((await readGithubAuthors(store, { now })).authors[0].author, "actualauthor");
});

test("author visibility pages retained sessions once per 60-second window and reaches authenticated admin status", async () => {
  const store = new MemoryStateStore();
  for (let i = 1; i <= 101; i++) await add(store, i, "worker");
  let reads = 0, time = now;
  const list = store.listRecentSessions.bind(store);
  store.listRecentSessions = (...args) => { reads++; return list(...args); };
  const provider = createGithubAuthorsProvider(store, { now: () => time });
  const [a, b] = await Promise.all([provider(), provider()]);
  assert.equal(a, b);
  assert.equal(a.openClaims, 101);
  assert.equal(reads, 2);
  await provider();
  assert.equal(reads, 2);
  time = new Date(+now + 60_000);
  await provider();
  assert.equal(reads, 4);
  const platform = new PlatformService([], new Map(), new Map(), new Map(), undefined, store);
  const status = await platform.getAdminStatus({ auth: { wallet: wallet(99), roles: ["admin"] } });
  assert.equal(status.githubAuthors.distinctAuthors, 1);
  assert.equal(status.githubAuthors.distinctWallets, 101);
});

test("author scan fails closed at the 10000-session paging bound instead of publishing partial counts", async () => {
  let calls = 0;
  const store = { listRecentSessions: async (limit, offset) => {
    assert.equal(limit, 100);
    assert.equal(offset, calls * 100);
    calls++;
    if (calls > 100) throw new Error("unbounded scan");
    return Array.from({ length: limit }, (_, i) => ({ sessionId: String(offset + i) }));
  }, getVerificationResult: () => assert.fail("must not attribute an incomplete scan") };
  await assert.rejects(readGithubAuthors(store, { now }), /exceeded the 10000 record bound/u);
  assert.equal(calls, 100);
  await assert.rejects(readGithubAuthors({ listRecentSessions: async () => ({}) }, { now }), /non-array page/u);
});

test("operator board presents author counts, windows, payout uncertainty and coverage outside desktop-only layout", () => {
  const page = readFileSync(new URL("../../../app/app/(authed)/overview/page.tsx", import.meta.url), "utf8");
  for (const field of ["distinctAuthors", "distinctWallets", "unattributedClaims", "openClaims", "submitted",
    "awaitingHumanReview", "settled7d", "settled30d", "usdcPaid"]) assert.ok(page.includes(field), field);
  assert.ok(page.indexOf('aria-label="GitHub author visibility"') < page.indexOf('className="hidden w-full'));
  assert.match(page, /accounts are not unique humans/);
  assert.match(page, /paid\?\.amount == null \? "Unavailable"/);
});
