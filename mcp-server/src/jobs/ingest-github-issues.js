#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  DEFAULT_OPEN_PR_CAP_PER_REPO,
  evaluateMaintainerSurfaceForIssue,
  repoFromIssue
} from "../core/maintainer-surface-policy.js";
import { DEFAULT_ESCROW_ASSET_SYMBOL } from "../core/assets.js";
import { substantiveVerifierTerms } from "./substantive-verifier-terms.js";

/**
 * Ingest agent-suitable GitHub issues into the Agent Platform job catalog.
 *
 * Example:
 *   AGENT_ADMIN_TOKEN=... npm run ingest:github-issues -- \
 *     --query 'is:issue is:open label:"good first issue" language:JavaScript' \
 *     --limit 10 \
 *     --dry-run
 */

export const DEFAULT_QUERY =
  'is:issue is:open archived:false label:"good first issue" (test OR docs OR typo OR validation OR error OR refactor)';
export const DEFAULT_BASE_URL = "http://localhost:8787";

const POSITIVE_LABEL_SCORES = new Map([
  ["good first issue", 30],
  ["help wanted", 20],
  ["documentation", 15],
  ["docs", 15],
  ["bug", 10],
  ["test", 15],
  ["tests", 15]
]);

const NEGATIVE_LABELS = new Set([
  "security",
  "architecture",
  "design",
  "migration",
  "breaking change",
  "blocked",
  "needs decision"
]);

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key.includes("=")) {
      const [name, ...rest] = key.split("=");
      parsed[name] = rest.join("=");
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export async function ingestGithubIssues({
  query = DEFAULT_QUERY,
  limit = 10,
  minScore = 55,
  githubToken = undefined,
  fetchImpl = fetch,
  maintainerPolicy = {}
} = {}) {
  const issues = await searchIssues({
    query,
    limit: Math.max(limit * 3, 30),
    githubToken,
    fetchImpl
  });
  const scored = await Promise.all(issues.map(async (issue) => {
    const policy = await evaluateMaintainerSurfaceForIssue(issue, {
      githubToken,
      fetchImpl,
      ...maintainerPolicy
    });
    return { issue, score: scoreIssue(issue), policy };
  }));
  const skippedDetails = scored
    .filter(({ score, policy }) => score < minScore || !policy.allowed)
    .map(({ issue, score, policy }) => ({
      repo: policy.repo ?? repoFromIssue(issue),
      issueNumber: Number(issue.number),
      reason: policy.allowed ? "score_below_minimum" : policy.reason,
      score
    }));
  const candidates = scored
    .filter(({ score, policy }) => score >= minScore && policy.allowed)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  const jobs = candidates.map(({ issue, score, policy }) => toPlatformJob(issue, score, {
    maintainerPolicy: policy,
    openPrCap: maintainerPolicy.openPrCap ?? DEFAULT_OPEN_PR_CAP_PER_REPO
  }));

  return {
    query,
    minScore,
    count: jobs.length,
    jobs,
    skipped: issues.length - candidates.length,
    skippedDetails
  };
}

export async function searchIssues({ query, limit, githubToken, fetchImpl = fetch }) {
  const url = new URL("https://api.github.com/search/issues");
  url.searchParams.set("q", `${query} -label:wontfix -label:duplicate -label:invalid`);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(Math.min(limit, 100)));

  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "agent-platform-issue-ingestor"
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;

  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub search failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  return (payload.items ?? []).filter((issue) => !issue.pull_request);
}

export function scoreIssue(issue) {
  const title = String(issue.title ?? "").toLowerCase();
  const body = String(issue.body ?? "");
  const labels = labelNames(issue);
  let score = 0;

  for (const label of labels) {
    score += POSITIVE_LABEL_SCORES.get(label) ?? 0;
    if (NEGATIVE_LABELS.has(label)) score -= 20;
  }

  if (/\b(test|tests|unit test|coverage)\b/u.test(title)) score += 20;
  if (/\b(doc|docs|documentation|readme|example|typo)\b/u.test(title)) score += 18;
  if (/\b(error message|validation|edge case|refactor|cleanup)\b/u.test(title)) score += 12;
  if (/\b(crash|race condition|architecture|migration|security|auth|oauth)\b/u.test(title)) score -= 20;

  if (body.length >= 120 && body.length <= 4000) score += 10;
  if (body.length > 8000) score -= 15;
  if ((issue.comments ?? 0) > 15) score -= 10;
  if (issue.locked) score -= 40;

  return Math.max(0, score);
}

export function toPlatformJob(issue, score = scoreIssue(issue), {
  maintainerPolicy = undefined,
  openPrCap = DEFAULT_OPEN_PR_CAP_PER_REPO
} = {}) {
  const repo = repoFullName(issue);
  const issueNumber = Number(issue.number);
  const issueUrl = String(issue.html_url ?? `https://github.com/${repo}/issues/${issueNumber}`);
  const issueTitle = String(issue.title ?? `GitHub issue #${issueNumber}`).trim();
  const body = String(issue.body ?? "").trim();
  const category = inferCategory(issue);
  const slug = slugify(issueTitle).slice(0, 48);
  const id = `oss-${slugify(repo)}-${issueNumber}-${slug}`.slice(0, 120);
  const acceptanceCriteria = buildAcceptanceCriteria({ category, repo, issueNumber });

  return {
    id,
    title: `Audit and report on GitHub issue: ${issueTitle}`,
    description:
      `Audit ${repo} issue #${issueNumber} and return a focused implementation report. Upstream issue context: ${summariseIssueBody(body)}`,
    jobType: "review",
    requiredRole: "worker",
    category,
    tier: "starter",
    rewardAsset: DEFAULT_ESCROW_ASSET_SYMBOL,
    rewardAmount: 0.2,
    verifierMode: "benchmark",
    verifierTerms: substantiveVerifierTerms(repo, `#${issueNumber}`, issueTitle, issueUrl),
    verifierMinimumMatches: 2,
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    claimTtlSeconds: 7200,
    retryLimit: 1,
    requiresSponsoredGas: true,
    onboardingWaiverEligible: true,
    source: {
      type: "github_issue",
      repo,
      issueNumber,
      issueUrl,
      labels: [...labelNames(issue)],
      score,
      comments: Number(issue.comments ?? 0),
      locked: Boolean(issue.locked),
      body: summariseIssueBody(body),
      maintainerPolicy: {
        repoDenied: false,
        disclosureRequired: true,
        openPrCap,
        scannedPaths: maintainerPolicy?.policyScan?.scannedPaths ?? []
      }
    },
    acceptanceCriteria,
    estimatedDifficulty: estimateDifficulty(score),
    agentInstructions: [
      `Read ${issueUrl} and audit the reported behavior against the linked repository.`,
      "Describe the smallest focused change that would address the issue.",
      "Report the relevant tests or docs build that should validate the proposed change.",
      "Do not modify the upstream repository or open a pull request; submit the audit report to Averray only.",
      "Submit the report with summary, output, and status fields."
    ],
    verification: {
      method: "benchmark",
      suggestedCheck: "github_issue_audit_report_complete",
      signals: ["issue_reviewed", "proposed_change_reported", "validation_plan_reported"],
      evidenceSchemaRef: "schema://jobs/coding-output"
    }
  };
}

export async function postJobs({ baseUrl, adminToken, jobs, fetchImpl = fetch }) {
  const results = [];
  for (const job of jobs) {
    results.push(await createJob({ baseUrl, adminToken, job, fetchImpl }));
  }
  return results;
}

export async function createJob({ baseUrl, adminToken, job, fetchImpl = fetch }) {
  const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/admin/jobs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(job)
  });

  const body = await response.text();
  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    payload = { raw: body };
  }

  return {
    id: job.id,
    status: response.status,
    ok: response.ok,
    payload
  };
}

function repoFullName(issue) {
  const fromApiUrl = String(issue.repository_url ?? "").split("/repos/").at(-1);
  if (fromApiUrl) return fromApiUrl;
  const match = String(issue.html_url ?? "").match(/github\.com\/([^/]+\/[^/]+)\/issues\//u);
  return match?.[1] ?? "unknown/unknown";
}

function labelNames(issue) {
  return new Set((issue.labels ?? []).map((label) => String(label.name ?? label).toLowerCase()).filter(Boolean));
}

function inferCategory(issue) {
  const title = String(issue.title ?? "").toLowerCase();
  const labels = labelNames(issue);
  if (labels.has("documentation") || labels.has("docs") || /\b(doc|docs|documentation|readme|example|typo)\b/u.test(title)) {
    return "docs";
  }
  if (labels.has("test") || labels.has("tests") || /\b(test|tests|coverage)\b/u.test(title)) {
    return "testing";
  }
  return "coding";
}

function buildAcceptanceCriteria({ category, repo, issueNumber }) {
  return [
    `Audit ${repo} issue #${issueNumber} and cite the issue in the report.`,
    "Describe a focused proposed change without modifying the upstream repository.",
    category === "docs"
      ? "Report the docs build or review steps that should validate the proposed change."
      : "Report the relevant tests that should validate the proposed change.",
    category === "testing"
      ? "Describe a regression test or coverage improvement where practical."
      : "Keep unrelated refactors out of the recommendation.",
    "Submit the audit report to Averray; do not open a pull request."
  ];
}

function estimateDifficulty(score) {
  if (score >= 85) return "starter";
  if (score >= 65) return "starter-plus";
  return "review-needed";
}

function summariseIssueBody(body) {
  if (!body) {
    return "No issue body was provided. Agent should rely on the linked issue and repository context.";
  }
  return body.length > 4000 ? `${body.slice(0, 3997)}...` : body;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);
  const limit = parsePositiveInt(args.limit, 10);
  const minScore = parsePositiveInt(args["min-score"], 55);
  const query = String(args.query ?? process.env.GITHUB_ISSUE_QUERY ?? DEFAULT_QUERY);
  const baseUrl = trimTrailingSlash(String(args.baseUrl ?? process.env.AGENT_API_BASE_URL ?? DEFAULT_BASE_URL));
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const adminToken = process.env.AGENT_ADMIN_TOKEN?.trim();

  if (!dryRun && !adminToken) {
    fail("AGENT_ADMIN_TOKEN is required unless --dry-run is set.");
  }

  const dryRunPayload = await ingestGithubIssues({ query, limit, minScore, githubToken });
  if (dryRun) {
    console.log(JSON.stringify(dryRunPayload, null, 2));
    return;
  }

  const results = await postJobs({ baseUrl, adminToken, jobs: dryRunPayload.jobs });
  console.log(JSON.stringify({ ...dryRunPayload, results }, null, 2));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
