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
  assert.equal(job.verifierMode, "github_pr");
  assert.equal(job.outputSchemaRef, "schema://jobs/github-pr-evidence-output");
  assert.ok(job.agentInstructions.some((entry) => entry.includes("Averray disclosure footer")));
  assert.ok(job.disclosureFooterTemplate.includes("Averray platform"));
  assert.equal(job.source.maintainerPolicy.openPrCap, 3);
  assert.deepEqual(job.verification.signals, [
    "attempted",
    "pr_opened",
    "issue_referenced",
    "tests_submitted",
    "ci_passed",
    "maintainer_approved",
    "merged"
  ]);
});

test("ingestGithubIssues skips denylisted repos", async () => {
  const payload = await ingestGithubIssues({
    query: "is:issue is:open label:good-first-issue",
    limit: 5,
    minScore: 55,
    maintainerPolicy: {
      denylistRepos: ["example/project"]
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { items: [GOOD_ISSUE] };
      }
    })
  });

  assert.equal(payload.count, 0);
  assert.equal(payload.jobs.length, 0);
  assert.equal(payload.skippedDetails[0].reason, "repo_denylisted");
});

test("ingestGithubIssues scans repository policy files when enabled", async () => {
  const payload = await ingestGithubIssues({
    query: "is:issue is:open label:good-first-issue",
    limit: 5,
    minScore: 55,
    maintainerPolicy: {
      denylistRepos: [],
      scanRepoPolicies: true
    },
    fetchImpl: async (url) => {
      if (String(url).includes("/search/issues")) {
        return {
          ok: true,
          async json() {
            return { items: [GOOD_ISSUE] };
          }
        };
      }
      return {
        status: String(url).includes("CONTRIBUTING.md") ? 200 : 404,
        ok: String(url).includes("CONTRIBUTING.md"),
        async text() {
          return "Please do not submit AI generated pull requests.";
        }
      };
    }
  });

  assert.equal(payload.count, 0);
  assert.equal(payload.skippedDetails[0].reason, "repo_ai_policy_denies_agent_contributions");
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
