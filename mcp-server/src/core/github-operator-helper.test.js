import test from "node:test";
import assert from "node:assert/strict";

import {
  collectGithubOperatorStatus,
  normalizeGithubHelperLimit,
  normalizeGithubHelperView,
  parseGithubHelperRepos
} from "./github-operator-helper.js";

test("parseGithubHelperRepos accepts repo names and GitHub URLs", () => {
  assert.deepEqual(
    parseGithubHelperRepos("averray-agent/agent, https://github.com/depre-dev/averray-reference-agent.git, bad"),
    ["averray-agent/agent", "depre-dev/averray-reference-agent"]
  );
});

test("parseGithubHelperRepos falls back to GITHUB_DEFAULT_REPO", () => {
  const previousRepos = process.env.GITHUB_HELPER_REPOS;
  const previousDefaultRepo = process.env.GITHUB_DEFAULT_REPO;
  const previousRepository = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_HELPER_REPOS;
  process.env.GITHUB_DEFAULT_REPO = "averray-agent/agent";
  process.env.GITHUB_REPOSITORY = "other/repo";
  try {
    assert.deepEqual(parseGithubHelperRepos(), ["averray-agent/agent"]);
  } finally {
    restoreEnv("GITHUB_HELPER_REPOS", previousRepos);
    restoreEnv("GITHUB_DEFAULT_REPO", previousDefaultRepo);
    restoreEnv("GITHUB_REPOSITORY", previousRepository);
  }
});

test("normalizeGithubHelperLimit clamps unsafe values", () => {
  assert.equal(normalizeGithubHelperLimit("0"), 5);
  assert.equal(normalizeGithubHelperLimit("3"), 3);
  assert.equal(normalizeGithubHelperLimit("999"), 20);
});

test("normalizeGithubHelperView accepts the operator command views", () => {
  assert.equal(normalizeGithubHelperView("prs"), "prs");
  assert.equal(normalizeGithubHelperView("ci"), "ci");
  assert.equal(normalizeGithubHelperView("issues"), "issues");
  assert.equal(normalizeGithubHelperView("wat"), "status");
});

test("collectGithubOperatorStatus reports unconfigured helper without mutating", async () => {
  const status = await collectGithubOperatorStatus({
    repos: "",
    view: "ci",
    githubToken: undefined,
    now: new Date("2026-05-08T10:00:00.000Z"),
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    }
  });

  assert.equal(status.configured, false);
  assert.equal(status.mutates, false);
  assert.equal(status.health, "ok");
  assert.equal(status.view, "ci");
  assert.equal(status.selectedView.name, "ci");
  assert.deepEqual(status.selectedView.items, []);
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
    "https://api.github.com/repos/acme/widgets/pulls?state=open&sort=updated&direction=desc&per_page=3": [
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
    "https://api.github.com/repos/acme/widgets/issues?state=open&sort=updated&direction=desc&per_page=6": [
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
    "https://api.github.com/repos/acme/widgets/actions/runs?per_page=3": {
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
    limit: 3,
    view: "digest",
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
  assert.equal(status.view, "digest");
  assert.equal(status.views.prs[0].number, 7);
  assert.equal(status.views.issues[0].number, 9);
  assert.equal(status.views.ci.length, 2);
  assert.deepEqual(
    status.selectedView.items.map((item) => item.kind),
    ["pull_request", "issue", "workflow_failure"]
  );
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

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
