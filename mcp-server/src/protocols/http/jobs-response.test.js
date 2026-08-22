import test from "node:test";
import assert from "node:assert/strict";

import { buildPublicJobsResponse } from "./jobs-response.js";

const JOBS = [
  {
    id: `0x${"ab".repeat(32)}`,
    title: "External coding audit",
    description: "Audit and report on the target repository.",
    category: "coding",
    jobType: "work",
    tier: "starter",
    verifierMode: "deterministic",
    claimTtlSeconds: 3600,
    requiresSponsoredGas: true,
    onboardingWaiverEligible: true,
    acceptanceCriteria: ["Return a report with the failing checks and evidence."],
    rewardAsset: "USDC",
    rewardAmount: 1,
    lifecycle: {
      status: "open",
      state: "open",
      createdAt: "2026-07-28T10:00:00.000Z"
    },
    source: {
      type: "external",
      poster: {
        wallet: "0x1111111111111111111111111111111111111111",
        fundedAt: "2026-07-28T10:00:00.000Z",
        txHash: `0x${"cd".repeat(32)}`,
        blockNumber: "1234"
      }
    }
  },
  {
    id: "wiki-en-123-citation-repair-example",
    title: "Audit and report on Wikipedia citations: Example",
    description: "Review the article and return an editor-ready citation repair proposal.",
    category: "wikipedia",
    jobType: "review",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 3,
    lifecycle: {
      status: "open",
      state: "open",
      createdAt: "2026-04-28T10:00:00.000Z"
    },
    source: {
      type: "wikipedia_article",
      project: "wikipedia",
      taskType: "citation_repair",
      language: "en",
      pageTitle: "Example",
      pageUrl: "https://en.wikipedia.org/wiki/Example",
      articleUrl: "https://en.wikipedia.org/wiki/Example",
      revisionId: "123456789",
      pinnedRevisionUrl: "https://en.wikipedia.org/w/index.php?title=Example&oldid=123456789",
      proposalOnly: true,
      attributionPolicy: "Averray proposal only / no direct Wikipedia edit",
      outputSchemaUrl: "/schemas/jobs/wikipedia-citation-repair-output.json"
    }
  },
  {
    id: "openapi-averray-http-api",
    title: "Audit and report on OpenAPI quality: Averray HTTP API",
    description: "Validate the public OpenAPI document.",
    category: "api",
    jobType: "review",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 3,
    lifecycle: {
      status: "open",
      state: "open",
      createdAt: "2026-04-28T11:00:00.000Z"
    },
    source: {
      type: "openapi_spec",
      provider: "averray"
    }
  }
];

test("public jobs response keeps bare array for legacy callers", () => {
  const response = buildPublicJobsResponse(JOBS, new URLSearchParams());

  assert.equal(Array.isArray(response), true);
  assert.equal(response.length, JOBS.length);
  assert.equal(response[0].listedAt, "2026-07-28T10:00:00.000Z");
  assert.equal(Object.hasOwn(JOBS[0], "listedAt"), false, "the read projection must not mutate the catalog");
});

test("compact listJobs preserves listedAt and the public priority window", () => {
  const listedAt = "2026-08-22T12:00:00.000Z";
  const priorityWindow = {
    openAt: "2026-08-22T12:05:00.000Z",
    qualifiesWith: "≥ 1 USDC vested deposit and no outstanding credit draw"
  };
  const response = buildPublicJobsResponse(
    [{ ...JOBS[1], listedAt, priorityWindow }],
    new URLSearchParams({ format: "compact" })
  );
  assert.equal(response.jobs[0].listedAt, listedAt);
  assert.deepEqual(response.jobs[0].priorityWindow, priorityWindow);
});

test("source=external exposes only external rows with poster funding provenance", () => {
  const response = buildPublicJobsResponse(
    JOBS,
    new URLSearchParams("source=external")
  );

  assert.equal(response.total, 1);
  assert.equal(response.jobs[0].source, "external");
  assert.deepEqual(response.jobs[0].poster, JOBS[0].source.poster);
  assert.deepEqual(response.jobs[0].sourceDetails, {
    wallet: "0x1111111111111111111111111111111111111111",
    fundedAt: "2026-07-28T10:00:00.000Z",
    txHash: `0x${"cd".repeat(32)}`,
    blockNumber: "1234"
  });
});

test("compact rows preserve explicit provenance and untrusted-content framing", () => {
  const provenance = {
    posterAddress: JOBS[0].source.poster.wallet,
    posterTier: "external-self-serve",
    postingRoute: "external-x402",
    firstSeenAt: JOBS[0].lifecycle.createdAt,
    specHash: `0x${"ef".repeat(32)}`
  };
  const response = buildPublicJobsResponse(
    [{
      ...JOBS[0],
      listingStatus: "listed",
      contentTrust: "external-unreviewed",
      verificationDepth: "Starter-tier benchmark check: output schema conformance and required reference terms. This is not a content audit.",
      provenance
    }],
    new URLSearchParams("limit=1")
  );

  assert.equal(response.jobs[0].listingStatus, "listed");
  assert.equal(response.jobs[0].contentTrust, "external-unreviewed");
  assert.equal(
    response.jobs[0].verificationDepth,
    "Starter-tier benchmark check: output schema conformance and required reference terms. This is not a content audit."
  );
  assert.deepEqual(response.jobs[0].provenance, provenance);
});

test("public jobs response filters and compacts agent-friendly queries", () => {
  const response = buildPublicJobsResponse(
    JOBS,
    new URLSearchParams("source=wikipedia&state=open&limit=25")
  );

  assert.equal(response.compact, true);
  assert.equal(response.count, 1);
  assert.equal(response.total, 1);
  assert.equal(response.limit, 25);
  assert.equal(response.nextOffset, null);
  assert.deepEqual(response.filters, {
    source: "wikipedia",
    category: undefined,
    state: "open"
  });
  assert.deepEqual(Object.keys(response.jobs[0]), [
    "id",
    "title",
    "state",
    "claimState",
    "effectiveState",
    "claimable",
    "currentWalletCanClaim",
    "fundingState",
    "reason",
    "claimedBy",
    "claimedAt",
    "claimExpiresAt",
    "retryLimit",
    "claimAttemptCount",
    "remainingClaimAttempts",
    "claimNumber",
    "sessionId",
    "source",
    "sourceType",
    "category",
    "jobType",
    "tier",
    "verifierMode",
    "claimTtlSeconds",
    "listedAt",
    "requiresSponsoredGas",
    "onboardingWaiverEligible",
    "disposableProof",
    "stake",
    "reward",
    "createdAt",
    "summary",
    "successCriteria",
    "definitionUrl",
    "sourceDetails"
  ]);
  assert.equal(response.jobs[0].id, "wiki-en-123-citation-repair-example");
  assert.equal(response.jobs[0].state, "open");
  assert.equal(response.jobs[0].claimState, "open");
  assert.equal(response.jobs[0].effectiveState, "claimable");
  assert.equal(response.jobs[0].claimable, true);
  assert.equal(response.jobs[0].source, "wikipedia");
  assert.equal(response.jobs[0].sourceType, "wikipedia_article");
  assert.equal(response.jobs[0].onboardingWaiverEligible, false);
  assert.equal(response.jobs[0].verifierMode, null);
  assert.equal(response.jobs[0].claimTtlSeconds, null);
  assert.equal(response.jobs[0].requiresSponsoredGas, false);
  assert.equal(response.jobs[0].listedAt, "2026-04-28T10:00:00.000Z");
  assert.equal(response.jobs[0].disposableProof, false);
  assert.equal(response.jobs[0].successCriteria, "");
  assert.equal(response.jobs[0].definitionUrl, "/jobs/definition?jobId=wiki-en-123-citation-repair-example");
  assert.deepEqual(response.jobs[0].sourceDetails, {
    taskType: "citation_repair",
    pageTitle: "Example",
    lang: "en",
    revisionId: "123456789",
    articleUrl: "https://en.wikipedia.org/wiki/Example",
    pinnedRevisionUrl: "https://en.wikipedia.org/w/index.php?title=Example&oldid=123456789",
    proposalOnly: true,
    attributionPolicy: "Averray proposal only / no direct Wikipedia edit",
    outputSchemaUrl: "/schemas/jobs/wikipedia-citation-repair-output.json"
  });
});

test("since counts strictly newer jobs without filtering the full listing", () => {
  const boundary = Date.parse("2026-04-28T10:00:00.000Z");
  const atBoundary = buildPublicJobsResponse(
    JOBS,
    new URLSearchParams(`limit=100&since=${boundary}`)
  );
  const oneMillisecondBefore = buildPublicJobsResponse(
    JOBS,
    new URLSearchParams(`limit=100&since=${boundary - 1}`)
  );
  const isoBoundary = buildPublicJobsResponse(
    JOBS,
    new URLSearchParams("limit=100&since=2026-04-28T10%3A00%3A00.000Z")
  );

  assert.equal(atBoundary.jobs.length, JOBS.length, "since annotates and never filters the listing");
  assert.equal(atBoundary.meta.newSince, 2, "a job listed exactly at since is not new");
  assert.equal(oneMillisecondBefore.meta.newSince, 3);
  assert.equal(isoBoundary.meta.newSince, 2);
  assert.ok(atBoundary.jobs.every((job) => Object.hasOwn(job, "listedAt")));
});

test("invalid since is ignored without rejecting or hiding jobs", () => {
  for (const since of ["not-a-date", "2026-04-28", "999999999999999999999999"]) {
    const response = buildPublicJobsResponse(
      JOBS,
      new URLSearchParams({ limit: "100", since })
    );
    assert.equal(response.jobs.length, JOBS.length, since);
    assert.deepEqual(response.meta, { newSince: 0 }, since);
  }
});

test("public jobs response filters compact rows by claim state", () => {
  const response = buildPublicJobsResponse(
    [
      {
        ...JOBS[0],
        claimState: "expired",
        effectiveState: "expired",
        claimable: false,
        currentWalletCanClaim: false,
        reason: "retry_limit_exhausted",
        claimedBy: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        claimedAt: "2026-05-01T11:18:03.973Z",
        claimExpiresAt: "2026-05-01T12:18:03.973Z",
        retryLimit: 1,
        claimAttemptCount: 1,
        remainingClaimAttempts: 0,
        claimNumber: 1,
        sessionId: "wiki-en-123-citation-repair-example:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    ],
    new URLSearchParams("state=expired&limit=25")
  );

  assert.equal(response.count, 1);
  assert.equal(response.jobs[0].state, "expired");
  assert.equal(response.jobs[0].claimState, "expired");
  assert.equal(response.jobs[0].claimable, false);
  assert.equal(response.jobs[0].currentWalletCanClaim, false);
  assert.equal(response.jobs[0].reason, "retry_limit_exhausted");
  assert.equal(response.jobs[0].claimExpiresAt, "2026-05-01T12:18:03.973Z");

  const exhaustedOpenResponse = buildPublicJobsResponse(
    [
      {
        ...JOBS[0],
        claimState: "expired",
        effectiveState: "expired",
        claimable: false
      }
    ],
    new URLSearchParams("state=open&limit=25")
  );
  assert.equal(exhaustedOpenResponse.total, 0);

  const claimableOpenResponse = buildPublicJobsResponse(
    [
      {
        ...JOBS[0],
        claimState: "expired",
        effectiveState: "claimable",
        claimable: true,
        reason: "claim_ttl_expired_reopen_available"
      }
    ],
    new URLSearchParams("state=open&limit=25")
  );
  assert.equal(claimableOpenResponse.total, 1);
  assert.equal(claimableOpenResponse.jobs[0].claimState, "expired");
  assert.equal(claimableOpenResponse.jobs[0].effectiveState, "claimable");

  const claimableResponse = buildPublicJobsResponse(
    [
      {
        ...JOBS[0],
        claimState: "expired",
        effectiveState: "claimable",
        claimable: true,
        reason: "claim_ttl_expired_reopen_available"
      }
    ],
    new URLSearchParams("state=claimable&limit=25")
  );
  assert.equal(claimableResponse.total, 1);
});

test("public jobs response supports category filters and pagination", () => {
  const response = buildPublicJobsResponse(
    JOBS,
    new URLSearchParams("source=open-api&category=api&limit=1&offset=0")
  );

  assert.equal(response.count, 1);
  assert.equal(response.total, 1);
  assert.equal(response.jobs[0].id, "openapi-averray-http-api");
  assert.equal(response.jobs[0].source, "openapi");
  assert.equal(response.jobs[0].summary, "Validate the public OpenAPI document.");
});

test("public jobs response allows explicit full format with query params", () => {
  const response = buildPublicJobsResponse(JOBS, new URLSearchParams("source=wikipedia&format=full"));

  assert.equal(response.length, JOBS.length, "full format keeps the unfiltered legacy listing");
  assert.ok(response.every((job) => Object.hasOwn(job, "listedAt")));
});

test("compact rows expose the human-work listing fields without changing the catalogue", async () => {
  const { normalizeJobInput } = await import("../../core/job-catalog-normalization.js");
  const normalized = normalizeJobInput({
    ...JOBS[0],
    id: "worker-canary-human-listing-fields",
    verifierTerms: ["report"],
    disposableProof: true
  });

  const response = buildPublicJobsResponse(
    [normalized],
    new URLSearchParams("limit=25")
  );

  assert.equal(response.total, 1, "the existing agent listing remains unchanged");
  assert.deepEqual(
    {
      verifierMode: response.jobs[0].verifierMode,
      claimTtlSeconds: response.jobs[0].claimTtlSeconds,
      requiresSponsoredGas: response.jobs[0].requiresSponsoredGas,
      onboardingWaiverEligible: response.jobs[0].onboardingWaiverEligible,
      disposableProof: response.jobs[0].disposableProof,
      successCriteria: response.jobs[0].successCriteria
    },
    {
      verifierMode: "deterministic",
      claimTtlSeconds: 3600,
      requiresSponsoredGas: true,
      onboardingWaiverEligible: true,
      disposableProof: true,
      successCriteria: "Return a report with the failing checks and evidence."
    }
  );
});

// End to end through the REAL normalizer, because the wiring is only worth anything
// if verifierMode actually survives from the stored job document to the listing row.
// Asserting the derivation in isolation would pass happily while the field was being
// dropped somewhere upstream and the block silently never appeared.
test("a normalized job carries its settlement expectation into the public listing", async () => {
  const { normalizeJobInput } = await import("../../core/job-catalog-normalization.js");

  const normalized = normalizeJobInput({
    id: `0x${"cd".repeat(32)}`,
    title: "Audit and report on Wikipedia citations",
    description: "Review the article and return an editor-ready proposal.",
    category: "wikipedia",
    jobType: "review",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: 0.4,
    verifierMode: "human_fallback",
    escalationMessage: "Maintainer review.",
    acceptanceCriteria: ["Every citation is checked."],
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    input: { task: "Review it.", acceptanceCriteria: ["Every citation is checked."] }
  });

  assert.equal(normalized.verifierMode, "human_fallback", "the normalizer must keep the mode");

  const body = buildPublicJobsResponse([normalized], new URLSearchParams({ format: "compact" }));
  const row = body.jobs[0];

  assert.ok(row.settlement, "the listing must carry a settlement block");
  assert.equal(row.settlement.path, "human_review");
  assert.equal(row.settlement.humanReviewWorstCaseSeconds, 604800);
  // Beside the reward, which is the whole point — an agent comparing jobs sees both.
  assert.ok("reward" in row);
});
