import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildClaimTerms,
  filterHumanWorkListings,
  jobDefinitionFailureKind,
  isJobNewSince,
  jobDefinitionRawUrl,
  priorityWindowDisplay,
  publicReceiptUrl,
  parseWorkLastVisit,
  routeAfterSignIn,
  serializeJobDefinition,
  workCatalogueIsPending,
  workJobIdFromPath,
  workSessionIdFromPath
} from "./human-work.js";

test("job definition 404 is missing while outages remain retryable read failures", () => {
  assert.equal(jobDefinitionFailureKind({ status: 404 }), "not_found");
  assert.equal(jobDefinitionFailureKind({ status: 500 }), "unreadable");
  assert.equal(jobDefinitionFailureKind(new TypeError("Failed to fetch")), "unreadable");
  assert.equal(jobDefinitionFailureKind(null), null);
});

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

test("returner freshness parses local visit time and keeps the listedAt boundary strict", () => {
  const previous = Date.parse("2026-08-21T12:00:00.000Z");
  assert.equal(parseWorkLastVisit(String(previous)), previous);
  assert.equal(parseWorkLastVisit("2026-08-21T12:00:00.000Z"), previous);
  assert.equal(parseWorkLastVisit("invalid"), null);
  assert.equal(isJobNewSince({ listedAt: "2026-08-21T12:00:00.001Z" }, previous), true);
  assert.equal(isJobNewSince({ listedAt: "2026-08-21T12:00:00.000Z" }, previous), false);
  assert.equal(isJobNewSince({ listedAt: "2026-08-21T11:59:59.999Z" }, previous), false);
  assert.equal(isJobNewSince({ listedAt: "invalid" }, previous), false);
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

test("work board priority window shows the honest countdown and qualifying condition", async () => {
  assert.deepEqual(
    priorityWindowDisplay(
      {
        openAt: "2026-08-22T12:05:00.000Z",
        qualifiesWith: "≥ 1 USDC vested deposit and no outstanding credit draw"
      },
      Date.parse("2026-08-22T12:02:00.000Z")
    ),
    {
      countdown: "opens to everyone in 3m",
      qualifiesWith: "≥ 1 USDC vested deposit and no outstanding credit draw"
    }
  );
  assert.equal(
    priorityWindowDisplay(
      { openAt: "2026-08-22T12:05:00.000Z", qualifiesWith: "vested deposit" },
      Date.parse("2026-08-22T12:05:00.000Z")
    ),
    null
  );

  const source = await readFile(
    new URL("../../components/work/WorkJobList.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /Priority window/u);
  assert.match(source, /priority\.countdown/u);
  assert.match(source, /Qualifies with \{priority\.qualifiesWith\}/u);
  assert.doesNotMatch(source, /exclusive|premium/iu);
});

test("static-shell pretty paths recover job/session ids and canonical receipt links", () => {
  assert.equal(workJobIdFromPath("/work/job%3A1"), "job:1");
  assert.equal(workSessionIdFromPath("/work/session/session%3A1"), "session:1");
  const receiptId = `0x${"a".repeat(64)}`;
  assert.equal(publicReceiptUrl(receiptId), `https://averray.com/receipts/${receiptId}`);
  assert.equal(publicReceiptUrl("session-1"), null);
});

test("job detail exposes the canonical raw definition URL and exact fetched JSON", () => {
  assert.equal(
    jobDefinitionRawUrl("job/with spaces"),
    "https://api.averray.com/jobs/job%2Fwith%20spaces"
  );
  assert.equal(jobDefinitionRawUrl("  "), null);
  assert.equal(
    serializeJobDefinition({ id: "job-1", acceptanceCriteria: ["done"] }),
    '{\n  "id": "job-1",\n  "acceptanceCriteria": [\n    "done"\n  ]\n}'
  );
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
