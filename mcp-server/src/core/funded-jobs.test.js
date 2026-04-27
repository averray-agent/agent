import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFundedJobFromClaim,
  summarizeFundedJobs,
  updateFundedJobFromSession
} from "./funded-jobs.js";

const githubJob = {
  id: "oss-example-42",
  rewardAsset: "DOT",
  rewardAmount: 5,
  source: {
    type: "github_issue",
    repo: "example/project",
    issueNumber: 42,
    issueUrl: "https://github.com/example/project/issues/42"
  }
};

test("buildFundedJobFromClaim captures funded job economics and deadline", () => {
  const record = buildFundedJobFromClaim({
    job: githubJob,
    session: {
      sessionId: "oss-example-42:0xabc",
      jobId: "oss-example-42",
      chainJobId: "0xjob",
      wallet: "0xabc",
      claimStake: 0.5,
      claimedAt: "2026-01-01T00:00:00.000Z"
    }
  });

  assert.equal(record.jobId, "oss-example-42");
  assert.equal(record.sourceType, "github_issue");
  assert.equal(record.rewardAmount, 5);
  assert.equal(record.claimStake, 0.5);
  assert.equal(record.finalStatus, "open");
  assert.equal(record.deadlineAt, "2026-01-31T00:00:00.000Z");
});

test("updateFundedJobFromSession extracts GitHub PR evidence from structured submission", () => {
  const initial = buildFundedJobFromClaim({
    job: githubJob,
    session: {
      sessionId: "oss-example-42:0xabc",
      jobId: "oss-example-42",
      wallet: "0xabc",
      claimedAt: "2026-01-01T00:00:00.000Z"
    }
  });
  const updated = updateFundedJobFromSession(initial, {
    job: githubJob,
    session: {
      ...initial,
      submittedAt: "2026-01-02T00:00:00.000Z",
      submission: {
        kind: "structured",
        structured: {
          prUrl: "https://github.com/example/project/pull/77",
          summary: "Fixed issue"
        }
      }
    }
  });

  assert.equal(updated.upstream.kind, "github_pull_request");
  assert.equal(updated.upstream.repo, "example/project");
  assert.equal(updated.upstream.pullNumber, 77);
  assert.equal(updated.upstreamStatus, "submitted");
});

test("summarizeFundedJobs reports merge rate, spend, receipts, and close reasons", () => {
  const report = summarizeFundedJobs([
    {
      jobId: "a",
      fundedAt: "2026-01-01T00:00:00.000Z",
      finalStatus: "merged",
      rewardAmount: 5,
      receiptCount: 1,
      sourceType: "github_issue"
    },
    {
      jobId: "b",
      fundedAt: "2026-01-02T00:00:00.000Z",
      finalStatus: "closed_unmerged",
      closeReason: "wrong_fix",
      rewardAmount: 1,
      receiptCount: 1,
      sourceType: "github_issue"
    },
    {
      jobId: "c",
      fundedAt: "2026-01-03T00:00:00.000Z",
      finalStatus: "open",
      rewardAmount: 1,
      receiptCount: 0,
      sourceType: "wikipedia_article"
    }
  ], {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-08T00:00:00.000Z",
    now: new Date("2026-01-08T00:00:00.000Z")
  });

  assert.equal(report.totalFundedJobs, 3);
  assert.equal(report.finalJobs, 2);
  assert.equal(report.successfulJobs, 1);
  assert.equal(report.mergeRate, 0.5);
  assert.equal(report.totalReserved, 7);
  assert.equal(report.confirmedPayout, 5);
  assert.equal(report.totalReceipts, 2);
  assert.deepEqual(report.topCloseReasons, [{ reason: "wrong_fix", count: 1 }]);
});
