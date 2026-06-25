import test from "node:test";
import assert from "node:assert/strict";

import { buildPublicJobsResponse } from "./jobs-response.js";

const JOBS = [
  {
    id: "wiki-en-123-citation-repair-example",
    title: "Repair Wikipedia citations: Example",
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
    title: "Audit OpenAPI quality: Averray HTTP API",
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

  assert.equal(response, JOBS);
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
    "onboardingWaiverEligible",
    "stake",
    "reward",
    "createdAt",
    "summary",
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

  assert.equal(response, JOBS);
});
