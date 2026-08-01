import assert from "node:assert/strict";
import test from "node:test";

import {
  ExternalPosterReviewEscalatorService,
  loadExternalPosterReviewEscalatorConfig
} from "./external-poster-review-escalator.js";

test("poster review escalator selects only expired submitted external jobs", async () => {
  const calls = [];
  const sessions = new Map([
    ["external-expired", { sessionId: "s1", status: "submitted", submittedAt: "2026-08-01T00:00:00.000Z" }],
    ["external-fresh", { sessionId: "s2", status: "submitted", submittedAt: "2026-08-08T12:00:00.000Z" }],
    ["external-resolved", { sessionId: "s3", status: "resolved", submittedAt: "2026-08-01T00:00:00.000Z" }]
  ]);
  const service = new ExternalPosterReviewEscalatorService(
    {
      listJobs() {
        return [
          { id: "external-expired", source: { type: "external" } },
          { id: "external-fresh", source: { type: "external" } },
          { id: "external-resolved", source: { type: "external" } },
          { id: "internal-old", source: { type: "github_issue" } }
        ];
      }
    },
    {
      findSessionByJobId(jobId) {
        return sessions.get(jobId);
      }
    },
    {
      reviewWindowSeconds: 7 * 24 * 60 * 60,
      async escalateExpiredSubmission(jobId, { now }) {
        calls.push({ jobId, now: now.toISOString() });
        return { decision: "escalated", status: "escalated" };
      }
    },
    undefined,
    { enabled: true, logger: { warn() {} } }
  );

  const result = await service.runOnce(new Date("2026-08-09T00:00:00.000Z"));
  assert.equal(result.scanned, 3);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.escalatedCount, 1);
  assert.deepEqual(calls, [{
    jobId: "external-expired",
    now: "2026-08-09T00:00:00.000Z"
  }]);
});

test("poster review escalator defaults on only when a chain gateway is live", () => {
  assert.equal(loadExternalPosterReviewEscalatorConfig({}, { gatewayEnabled: true }).enabled, true);
  assert.equal(loadExternalPosterReviewEscalatorConfig({}, { gatewayEnabled: false }).enabled, false);
  assert.equal(loadExternalPosterReviewEscalatorConfig({
    EXTERNAL_POSTER_REVIEW_ESCALATOR_ENABLED: "false"
  }, { gatewayEnabled: true }).enabled, false);
});
