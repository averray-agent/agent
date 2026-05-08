import test from "node:test";
import assert from "node:assert/strict";

import {
  collectGithubOperatorStatus,
  normalizeGithubHelperLimit,
  parseGithubHelperRepos
} from "./github-operator-helper.js";

test("parseGithubHelperRepos accepts repo names and GitHub URLs", () => {
  assert.deepEqual(
    parseGithubHelperRepos("averray-agent/agent, https://github.com/depre-dev/averray-reference-agent.git, bad"),
    ["averray-agent/agent", "depre-dev/averray-reference-agent"]
  );
});

test("normalizeGithubHelperLimit clamps unsafe values", () => {
  assert.equal(normalizeGithubHelperLimit("0"), 5);
  assert.equal(normalizeGithubHelperLimit("3"), 3);
  assert.equal(normalizeGithubHelperLimit("999"), 20);
});

test("collectGithubOperatorStatus reports unconfigured helper without mutating", async () => {
  const status = await collectGithubOperatorStatus({
    repos: "",
    githubToken: undefined,
    now: new Date("2026-05-08T10:00:00.000Z"),
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    }
  });

  assert.equal(status.configured, false);
  assert.equal(status.mutates, false);
  assert.equal(status.health, "ok");
  assert.equal(status.repoCount, 0);
  assert.equal(status.warnings[0].code, "github_helper_not_configured");
});

test("collectGithubOperatorStatus summarizes PRs, issues, and failing workflows", async () => {
  const fetchImpl = fakeGithubFetch({
    "https://api.github.com/repos/acme/widgets": {
      default_branch: "main",
      private: false,
      archived: false,
      html_url: "https://github.com/acme/widgets"
    },
    "https://api.github.com/repos/acme/widgets/pulls?state=open&sort=updated&direction=desc&per_page=2": [
      {
        number: 7,
        title: "Fix flaky widget test",
        html_url: "https://github.com/acme/widgets/pull/7",
        draft: true,
        user: { login: "alice" },
        head: { ref: "fix-flake" },
        base: { ref: "main" },
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-05-07T00:00:00.000Z"
      }
    ],
    "https://api.github.com/repos/acme/widgets/issues?state=open&sort=updated&direction=desc&per_page=4": [
      {
        number: 9,
        title: "Document widget retries",
        html_url: "https://github.com/acme/widgets/issues/9",
        user: { login: "bob" },
        labels: [{ name: "docs" }],
        comments: 0,
        created_at: "2026-04-15T00:00:00.000Z",
        updated_at: "2026-05-06T00:00:00.000Z"
      },
      {
        number: 7,
        title: "Fix flaky widget test",
        pull_request: {},
        html_url: "https://github.com/acme/widgets/pull/7"
      }
    ],
    "https://api.github.com/repos/acme/widgets/actions/runs?per_page=2": {
      workflow_runs: [
        {
          name: "CI",
          run_number: 42,
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/acme/widgets/actions/runs/42",
          created_at: "2026-05-08T08:00:00.000Z",
          updated_at: "2026-05-08T08:10:00.000Z"
        },
        {
          name: "Deploy",
          run_number: 43,
          head_branch: "main",
          event: "workflow_dispatch",
          status: "in_progress",
          conclusion: null,
          html_url: "https://github.com/acme/widgets/actions/runs/43",
          created_at: "2026-05-08T09:00:00.000Z",
          updated_at: "2026-05-08T09:00:00.000Z"
        }
      ]
    }
  });

  const status = await collectGithubOperatorStatus({
    repos: "acme/widgets",
    githubToken: "github-token",
    limit: 2,
    now: new Date("2026-05-08T10:00:00.000Z"),
    fetchImpl
  });

  assert.equal(status.mutates, false);
  assert.equal(status.configured, true);
  assert.equal(status.authConfigured, true);
  assert.equal(status.health, "attention");
  assert.deepEqual(status.totals, {
    openPullRequests: 1,
    openIssues: 1,
    failingWorkflowRuns: 1,
    activeWorkflowRuns: 1
  });
  assert.equal(status.repositories[0].repo, "acme/widgets");
  assert.equal(status.repositories[0].openIssues[0].number, 9);
  assert.equal(status.digest.pullRequestsNeedingAttention[0].reason, "draft");
  assert.equal(status.digest.issuesNeedingTriage[0].reason, "no_comments");
  assert.match(status.digest.ciFailures[0].explanation, /failing jobs/u);
});

test("collectGithubOperatorStatus keeps partial results when a repo fetch fails", async () => {
  const status = await collectGithubOperatorStatus({
    repos: "acme/missing",
    limit: 1,
    fetchImpl: fakeGithubFetch({}, { missingStatus: 404 })
  });

  assert.equal(status.health, "attention");
  assert.equal(status.repositories[0].repo, "acme/missing");
  assert.equal(status.warnings.length, 4);
  assert.equal(status.warnings[0].code, "github_fetch_failed");
});

function fakeGithubFetch(fixtures, { missingStatus = 404 } = {}) {
  return async (input, init = {}) => {
    assert.equal(init.headers.accept, "application/vnd.github+json");
    const url = String(input);
    if (!Object.hasOwn(fixtures, url)) {
      return fakeResponse({ message: "not found" }, { ok: false, status: missingStatus });
    }
    return fakeResponse(fixtures[url]);
  };
}

function fakeResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    }
  };
}
