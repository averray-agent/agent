import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildClaimTerms,
  filterHumanWorkListings,
  publicReceiptUrl,
  routeAfterSignIn,
  workCatalogueIsPending,
  workJobIdFromPath,
  workSessionIdFromPath
} from "./human-work.js";

test("work catalogue loading banner clears for loaded and empty results", () => {
  assert.equal(workCatalogueIsPending({ isLoading: true, data: undefined }), true);
  assert.equal(workCatalogueIsPending({ isLoading: true, data: { jobs: [] } }), false);
  assert.equal(workCatalogueIsPending({ isLoading: false, data: { jobs: [{ id: "ready" }] } }), false);
  assert.equal(workCatalogueIsPending({ isLoading: true, error: new Error("down") }), false);
});

test("human listing filters canary, witness, and disposable proof jobs only on the human surface", () => {
  const agentListing = {
    jobs: [
      { id: "starter-real", verifierMode: "deterministic" },
      { id: "worker-canary-proof", verifierMode: "benchmark" },
      { id: "witness-job", verifierMode: "witness" },
      { id: "disposable", verifierMode: "benchmark", disposableProof: true }
    ]
  };

  assert.equal(agentListing.jobs.length, 4, "the agent listing is unchanged");
  assert.deepEqual(filterHumanWorkListings(agentListing).map((job) => job.id), ["starter-real"]);
});

test("sign-in forks operator allowlists to the operator room and roleless wallets to work", () => {
  assert.equal(routeAfterSignIn(["admin"]), "/overview");
  assert.equal(routeAfterSignIn(["verifier"], "/runs"), "/runs");
  assert.equal(routeAfterSignIn(["admin"], "/poster/"), "/poster/");
  assert.equal(routeAfterSignIn([], "/overview"), "/work");
  assert.equal(routeAfterSignIn([], "https://example.com"), "/work");
});

test("fresh unfunded wallet sees the real waiver and brokered-gas path before claim", () => {
  const terms = buildClaimTerms({
    listing: {
      reward: { amount: 0.4, asset: "USDC" },
      onboardingWaiverEligible: true,
      requiresSponsoredGas: true,
      claimTtlSeconds: 3600
    },
    preflight: {
      eligible: true,
      netReward: 0.4,
      totalClaimLock: 0,
      claimEconomicsWaived: true,
      gasRetentionSupported: true
    },
    eligibility: { eligible: true }
  });

  assert.equal(terms.eligible, true);
  assert.equal(terms.waiverApplied, true);
  assert.equal(terms.stake, 0);
  assert.equal(terms.gasBrokered, true);
  assert.equal(terms.netReward, 0.4);
});

test("claim refusal is named before the claim action", () => {
  const terms = buildClaimTerms({
    listing: { reward: { amount: 1, asset: "USDC" } },
    preflight: { eligible: false, reason: "insufficient_liquidity" }
  });
  assert.equal(terms.eligible, false);
  assert.equal(terms.refusalReason, "insufficient_liquidity");
});

test("static-shell pretty paths recover job/session ids and canonical receipt links", () => {
  assert.equal(workJobIdFromPath("/work/job%3A1"), "job:1");
  assert.equal(workSessionIdFromPath("/work/session/session%3A1"), "session:1");
  const receiptId = `0x${"a".repeat(64)}`;
  assert.equal(publicReceiptUrl(receiptId), `https://averray.com/receipts/${receiptId}`);
  assert.equal(publicReceiptUrl("session-1"), null);
});

test("static deployment serves pretty job and session URLs through the worker shells", async () => {
  const caddy = await readFile(new URL("../../../deploy/Caddyfile.averray", import.meta.url), "utf8");
  const nextConfig = await readFile(new URL("../../next.config.ts", import.meta.url), "utf8");
  assert.ok(caddy.includes("^/work/session/[^/]+/?$"));
  assert.match(caddy, /rewrite @workerSession \/work\/session\/index\.html/u);
  assert.ok(caddy.includes("^/work/[^/]+/?$"));
  assert.match(caddy, /rewrite @workerJob \/work\/job\/index\.html/u);
  assert.match(nextConfig, /source: "\/work\/session\/:sessionId"/u);
  assert.match(nextConfig, /source: "\/work\/:jobId"/u);
});
