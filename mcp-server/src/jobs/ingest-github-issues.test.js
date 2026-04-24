import test from "node:test";
import assert from "node:assert/strict";

import {
  ingestGithubIssues,
  scoreIssue,
  toPlatformJob
} from "./ingest-github-issues.js";

const GOOD_ISSUE = {
  title: "Add tests for parser validation error",
  body: "The parser currently accepts an invalid edge case. Add a regression test and improve the validation error.",
  number: 42,
  html_url: "https://github.com/example/project/issues/42",
  repository_url: "https://api.github.com/repos/example/project",
  labels: [
    { name: "good first issue" },
    { name: "help wanted" },
    { name: "tests" }
  ],
  comments: 2,
  locked: false
};

test("scoreIssue prefers clear, testable starter issues", () => {
  const score = scoreIssue(GOOD_ISSUE);
  assert.ok(score >= 80);
});

test("scoreIssue penalizes risky or unclear issues", () => {
  const score = scoreIssue({
    title: "Security architecture migration for OAuth subsystem",
    body: "Long-running design discussion.",
    number: 7,
    html_url: "https://github.com/example/project/issues/7",
    repository_url: "https://api.github.com/repos/example/project",
    labels: [{ name: "security" }, { name: "architecture" }],
    comments: 31,
    locked: true
  });
  assert.equal(score, 0);
});

test("toPlatformJob preserves GitHub issue context as job metadata", () => {
  const job = toPlatformJob(GOOD_ISSUE, 92);

  assert.equal(job.id, "oss-example-project-42-add-tests-for-parser-validation-error");
  assert.equal(job.title, GOOD_ISSUE.title);
  assert.equal(job.jobType, "work");
  assert.equal(job.requiredRole, "worker");
  assert.equal(job.category, "testing");
  assert.equal(job.source.type, "github_issue");
  assert.equal(job.source.repo, "example/project");
  assert.equal(job.source.issueNumber, 42);
  assert.equal(job.source.score, 92);
  assert.ok(job.acceptanceCriteria.some((entry) => entry.includes("issue #42")));
  assert.ok(job.agentInstructions.some((entry) => entry.includes(GOOD_ISSUE.html_url)));
  assert.deepEqual(job.verification.signals, ["patch_submitted", "tests_passed", "pr_opened", "ci_passed", "merged"]);
});

test("ingestGithubIssues returns dry-run shaped jobs and filters pull requests", async () => {
  const payload = await ingestGithubIssues({
    query: "is:issue is:open label:good-first-issue",
    limit: 5,
    minScore: 55,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          items: [
            GOOD_ISSUE,
            { ...GOOD_ISSUE, number: 99, pull_request: { url: "https://api.github.com/repos/example/project/pulls/99" } }
          ]
        };
      }
    })
  });

  assert.equal(payload.count, 1);
  assert.equal(payload.jobs.length, 1);
  assert.equal(payload.jobs[0].source.issueNumber, 42);
  assert.equal(payload.jobs[0].verification.method, "github_pr");
});
