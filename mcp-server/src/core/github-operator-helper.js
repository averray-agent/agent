const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export function parseGithubHelperRepos(value = process.env.GITHUB_HELPER_REPOS ?? process.env.GITHUB_REPOSITORY ?? "") {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^https:\/\/github\.com\//u, ""))
    .map((entry) => entry.replace(/\.git$/u, ""))
    .filter((entry) => /^[^/\s]+\/[^/\s]+$/u.test(entry))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

export function normalizeGithubHelperLimit(value = process.env.GITHUB_HELPER_LIMIT ?? DEFAULT_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
}

export async function collectGithubOperatorStatus({
  repos = undefined,
  githubToken = process.env.GITHUB_TOKEN,
  apiBaseUrl = process.env.GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API_BASE_URL,
  limit = undefined,
  fetchImpl = fetch,
  now = new Date()
} = {}) {
  const normalizedRepos = parseGithubHelperRepos(Array.isArray(repos) ? repos.join(",") : repos);
  const normalizedLimit = normalizeGithubHelperLimit(limit);
  const warnings = [];

  if (normalizedRepos.length === 0) {
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      mutates: false,
      configured: false,
      authConfigured: Boolean(githubToken),
      health: "ok",
      repoCount: 0,
      totals: emptyTotals(),
      repositories: [],
      digest: {
        summary: "GitHub helper is not configured. Set GITHUB_HELPER_REPOS to enable PR, issue, and CI digests.",
        pullRequestsNeedingAttention: [],
        issuesNeedingTriage: [],
        ciFailures: []
      },
      warnings: [{
        severity: "low",
        code: "github_helper_not_configured",
        message: "Set GITHUB_HELPER_REPOS=owner/repo[,owner/repo] to enable this read-only helper."
      }],
      recommendations: ["Set GITHUB_HELPER_REPOS and a read-only GITHUB_TOKEN for higher rate limits."]
    };
  }

  const repositories = await Promise.all(normalizedRepos.map((repo) => collectRepoDigest({
    repo,
    githubToken,
    apiBaseUrl,
    limit: normalizedLimit,
    fetchImpl,
    warnings,
    now
  })));
  const totals = repositories.reduce((accumulator, repo) => {
    accumulator.openPullRequests += repo.openPullRequests.length;
    accumulator.openIssues += repo.openIssues.length;
    accumulator.failingWorkflowRuns += repo.workflowRuns.failed.length;
    accumulator.activeWorkflowRuns += repo.workflowRuns.active.length;
    return accumulator;
  }, emptyTotals());
  const pullRequestsNeedingAttention = repositories.flatMap((repo) =>
    repo.openPullRequests
      .filter((pr) => pr.isDraft || pr.reviewState === "needs_review" || pr.ageDays >= 7)
      .map((pr) => ({
        repo: repo.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        reason: pr.isDraft ? "draft" : (pr.ageDays >= 7 ? "stale" : "needs_review"),
        updatedAt: pr.updatedAt
      }))
  ).slice(0, normalizedLimit);
  const issuesNeedingTriage = repositories.flatMap((repo) =>
    repo.openIssues
      .filter((issue) => issue.commentCount === 0 || issue.ageDays >= 14)
      .map((issue) => ({
        repo: repo.repo,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        reason: issue.commentCount === 0 ? "no_comments" : "stale",
        updatedAt: issue.updatedAt
      }))
  ).slice(0, normalizedLimit);
  const ciFailures = repositories.flatMap((repo) =>
    repo.workflowRuns.failed.map((run) => ({
      repo: repo.repo,
      workflowName: run.workflowName,
      runNumber: run.runNumber,
      branch: run.branch,
      conclusion: run.conclusion,
      url: run.url,
      explanation: run.explanation,
      updatedAt: run.updatedAt
    }))
  ).slice(0, normalizedLimit);
  const health = warnings.some((warning) => warning.severity === "high")
    ? "degraded"
    : (totals.failingWorkflowRuns > 0 || warnings.length > 0 ? "attention" : "ok");

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    mutates: false,
    configured: true,
    authConfigured: Boolean(githubToken),
    health,
    repoCount: normalizedRepos.length,
    totals,
    repositories,
    digest: {
      summary: buildSummary({ totals, repoCount: normalizedRepos.length, health }),
      pullRequestsNeedingAttention,
      issuesNeedingTriage,
      ciFailures
    },
    warnings,
    recommendations: buildRecommendations({ totals, warnings, pullRequestsNeedingAttention, issuesNeedingTriage })
  };
}

async function collectRepoDigest({ repo, githubToken, apiBaseUrl, limit, fetchImpl, warnings, now }) {
  const [owner, name] = repo.split("/");
  const headers = buildHeaders(githubToken);
  const repoBase = `${apiBaseUrl.replace(/\/$/u, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const [repoInfo, pulls, issues, workflowRuns] = await Promise.all([
    getJson(`${repoBase}`, { headers, fetchImpl, warnings, repo, label: "repo" }),
    getJson(`${repoBase}/pulls?state=open&sort=updated&direction=desc&per_page=${limit}`, {
      headers,
      fetchImpl,
      warnings,
      repo,
      label: "pulls",
      fallback: []
    }),
    getJson(`${repoBase}/issues?state=open&sort=updated&direction=desc&per_page=${Math.min(limit * 2, 100)}`, {
      headers,
      fetchImpl,
      warnings,
      repo,
      label: "issues",
      fallback: []
    }),
    getJson(`${repoBase}/actions/runs?per_page=${limit}`, {
      headers,
      fetchImpl,
      warnings,
      repo,
      label: "workflow_runs",
      fallback: { workflow_runs: [] }
    })
  ]);
  const openPullRequests = Array.isArray(pulls) ? pulls.map((pr) => summarizePullRequest(pr, now)) : [];
  const openIssues = (Array.isArray(issues) ? issues : [])
    .filter((issue) => !issue.pull_request)
    .slice(0, limit)
    .map((issue) => summarizeIssue(issue, now));
  const workflowSummary = summarizeWorkflowRuns(workflowRuns?.workflow_runs ?? []);

  return {
    repo,
    defaultBranch: repoInfo?.default_branch,
    private: repoInfo?.private,
    archived: repoInfo?.archived,
    htmlUrl: repoInfo?.html_url ?? `https://github.com/${repo}`,
    openPullRequests,
    openIssues,
    workflowRuns: workflowSummary,
    needsAttention: openPullRequests.some((pr) => pr.isDraft || pr.ageDays >= 7)
      || workflowSummary.failed.length > 0
      || openIssues.some((issue) => issue.commentCount === 0 || issue.ageDays >= 14)
  };
}

async function getJson(url, { headers, fetchImpl, warnings, repo, label, fallback = undefined }) {
  try {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      warnings.push({
        severity: response.status >= 500 ? "high" : "medium",
        code: "github_fetch_failed",
        repo,
        endpoint: label,
        status: response.status,
        message: `GitHub ${label} request failed with HTTP ${response.status}.`
      });
      return fallback;
    }
    return response.json();
  } catch (error) {
    warnings.push({
      severity: "high",
      code: "github_fetch_error",
      repo,
      endpoint: label,
      message: error?.message ?? "GitHub request failed."
    });
    return fallback;
  }
}

function buildHeaders(githubToken) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "averray-github-operator-helper",
    ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {})
  };
}

function summarizePullRequest(pr, now) {
  return {
    number: Number(pr.number),
    title: String(pr.title ?? ""),
    url: pr.html_url,
    author: pr.user?.login,
    branch: pr.head?.ref,
    base: pr.base?.ref,
    isDraft: Boolean(pr.draft),
    reviewState: pr.draft ? "draft" : "needs_review",
    ageDays: ageDays(pr.created_at, now),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at
  };
}

function summarizeIssue(issue, now) {
  return {
    number: Number(issue.number),
    title: String(issue.title ?? ""),
    url: issue.html_url,
    author: issue.user?.login,
    labels: (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean),
    commentCount: Number(issue.comments ?? 0),
    ageDays: ageDays(issue.created_at, now),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at
  };
}

function summarizeWorkflowRuns(runs) {
  const summarized = runs.map((run) => ({
    workflowName: run.name,
    runNumber: Number(run.run_number),
    branch: run.head_branch,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    explanation: explainWorkflowRun(run)
  }));
  return {
    recent: summarized,
    failed: summarized.filter((run) => ["failure", "timed_out", "action_required"].includes(run.conclusion)),
    active: summarized.filter((run) => run.status && run.status !== "completed")
  };
}

function explainWorkflowRun(run) {
  if (run.status && run.status !== "completed") {
    return `Workflow is still ${run.status}; wait for completion before acting.`;
  }
  if (run.conclusion === "failure") {
    return "Workflow completed with failing jobs; inspect the run logs and fix the first failed job before retrying.";
  }
  if (run.conclusion === "timed_out") {
    return "Workflow timed out; check for hung tests, external services, or jobs with too-low timeout settings.";
  }
  if (run.conclusion === "action_required") {
    return "Workflow needs an approval or manual action before it can continue.";
  }
  if (run.conclusion === "cancelled") {
    return "Workflow was cancelled; usually safe to ignore if superseded by a newer run.";
  }
  return "Workflow has no blocking failure signal.";
}

function buildSummary({ totals, repoCount, health }) {
  if (health === "ok") {
    return `GitHub helper checked ${repoCount} repo(s): ${totals.openPullRequests} open PR(s), ${totals.openIssues} open issue(s), no failing workflow runs.`;
  }
  return `GitHub helper checked ${repoCount} repo(s): ${totals.openPullRequests} open PR(s), ${totals.openIssues} open issue(s), ${totals.failingWorkflowRuns} failing workflow run(s).`;
}

function buildRecommendations({ totals, warnings, pullRequestsNeedingAttention, issuesNeedingTriage }) {
  const recommendations = [];
  if (totals.failingWorkflowRuns > 0) {
    recommendations.push("Inspect the newest failing workflow run before merging or retrying.");
  }
  if (pullRequestsNeedingAttention.length > 0) {
    recommendations.push("Review stale or draft PRs and decide whether to merge, close, or unblock them.");
  }
  if (issuesNeedingTriage.length > 0) {
    recommendations.push("Triage old or unanswered issues so agent work has a clear next step.");
  }
  if (warnings.some((warning) => warning.status === 401 || warning.status === 403)) {
    recommendations.push("Check GITHUB_TOKEN permissions and rate limits for the configured repositories.");
  }
  return recommendations;
}

function emptyTotals() {
  return {
    openPullRequests: 0,
    openIssues: 0,
    failingWorkflowRuns: 0,
    activeWorkflowRuns: 0
  };
}

function ageDays(value, now = Date.now()) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return 0;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return Math.max(0, Math.floor((nowMs - timestamp) / 86_400_000));
}
