#!/usr/bin/env node

/**
 * Ingest agent-suitable GitHub issues into the local Agent Platform job catalog.
 *
 * Example:
 *   AGENT_ADMIN_TOKEN=... npm run ingest:github-issues -- \
 *     --query 'is:issue is:open label:"good first issue" language:JavaScript' \
 *     --limit 10 \
 *     --dry-run
 *
 * Notes:
 * - GITHUB_TOKEN is optional for public repositories, but recommended to avoid
 *   low anonymous rate limits.
 * - AGENT_ADMIN_TOKEN is the JWT used against POST /admin/jobs. It is not
 *   needed for --dry-run.
 */

const DEFAULT_QUERY = 'is:issue is:open archived:false label:"good first issue" (test OR docs OR typo OR validation OR error OR refactor)';
const DEFAULT_BASE_URL = 'http://localhost:8787';

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args['dry-run']);
const limit = parsePositiveInt(args.limit, 10);
const minScore = parsePositiveInt(args['min-score'], 55);
const query = String(args.query ?? process.env.GITHUB_ISSUE_QUERY ?? DEFAULT_QUERY);
const baseUrl = trimTrailingSlash(String(args.baseUrl ?? process.env.AGENT_API_BASE_URL ?? DEFAULT_BASE_URL));
const githubToken = process.env.GITHUB_TOKEN?.trim();
const adminToken = process.env.AGENT_ADMIN_TOKEN?.trim();

if (!dryRun && !adminToken) {
  fail('AGENT_ADMIN_TOKEN is required unless --dry-run is set.');
}

const issues = await searchIssues({ query, limit: Math.max(limit * 3, 30), githubToken });
const candidates = issues
  .map((issue) => ({ issue, score: scoreIssue(issue) }))
  .filter(({ score }) => score >= minScore)
  .sort((left, right) => right.score - left.score)
  .slice(0, limit);

const jobs = candidates.map(({ issue, score }) => toPlatformJob(issue, score));

if (dryRun) {
  console.log(JSON.stringify({ query, minScore, count: jobs.length, jobs }, null, 2));
  process.exit(0);
}

const results = [];
for (const job of jobs) {
  results.push(await createJob({ baseUrl, adminToken, job }));
}

console.log(JSON.stringify({ query, minScore, count: results.length, results }, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key.includes('=')) {
      const [name, ...rest] = key.split('=');
      parsed[name] = rest.join('=');
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, '');
}

async function searchIssues({ query, limit, githubToken }) {
  const url = new URL('https://api.github.com/search/issues');
  url.searchParams.set('q', `${query} -label:wontfix -label:duplicate -label:invalid`);
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(Math.min(limit, 100)));

  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'agent-platform-issue-ingestor'
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub search failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  return (payload.items ?? []).filter((issue) => !issue.pull_request);
}

function scoreIssue(issue) {
  const title = String(issue.title ?? '').toLowerCase();
  const body = String(issue.body ?? '');
  const labels = new Set((issue.labels ?? []).map((label) => String(label.name ?? '').toLowerCase()));
  let score = 0;

  if (labels.has('good first issue')) score += 30;
  if (labels.has('help wanted')) score += 20;
  if (labels.has('documentation') || labels.has('docs')) score += 15;
  if (labels.has('bug')) score += 10;
  if (labels.has('test') || labels.has('tests')) score += 15;

  if (/\b(test|tests|unit test|coverage)\b/u.test(title)) score += 20;
  if (/\b(doc|docs|documentation|readme|example|typo)\b/u.test(title)) score += 18;
  if (/\b(error message|validation|edge case|refactor|cleanup)\b/u.test(title)) score += 12;
  if (/\b(crash|race condition|architecture|migration|security|auth|oauth)\b/u.test(title)) score -= 20;

  if (body.length >= 250 && body.length <= 4000) score += 10;
  if (body.length > 8000) score -= 15;
  if ((issue.comments ?? 0) > 15) score -= 10;
  if (issue.locked) score -= 40;

  return Math.max(0, score);
}

function toPlatformJob(issue, score) {
  const repo = issue.repository_url.split('/repos/').at(-1);
  const slug = slugify(issue.title).slice(0, 48);
  const id = `oss-${slugify(repo)}-${issue.number}-${slug}`.slice(0, 120);
  const isDocs = looksLikeDocsIssue(issue);
  const issueUrl = issue.html_url;

  return {
    id,
    category: isDocs ? 'documentation' : 'coding',
    tier: 'starter',
    rewardAsset: 'DOT',
    rewardAmount: 1,
    verifierMode: 'benchmark',
    verifierTerms: [
      'github',
      repo,
      `#${issue.number}`,
      isDocs ? 'documentation' : 'tests',
      issueUrl
    ],
    verifierMinimumMatches: 3,
    inputSchemaRef: isDocs ? 'schema://jobs/documentation-input' : 'schema://jobs/coding-input',
    outputSchemaRef: isDocs ? 'schema://jobs/documentation-output' : 'schema://jobs/coding-output',
    claimTtlSeconds: 7200,
    retryLimit: 1,
    requiresSponsoredGas: true,
    // These fields are useful for logs/dry-runs today. The current catalog
    // normalizer keeps only first-class job fields, so durable source metadata
    // should be promoted in a follow-up schema migration.
    source: {
      type: 'github_issue',
      repo,
      issueNumber: issue.number,
      issueUrl,
      labels: (issue.labels ?? []).map((label) => label.name),
      score
    }
  };
}

function looksLikeDocsIssue(issue) {
  const title = String(issue.title ?? '').toLowerCase();
  const labels = new Set((issue.labels ?? []).map((label) => String(label.name ?? '').toLowerCase()));
  return labels.has('documentation') || labels.has('docs') || /\b(doc|docs|documentation|readme|example|typo)\b/u.test(title);
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
}

async function createJob({ baseUrl, adminToken, job }) {
  const response = await fetch(`${baseUrl}/admin/jobs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json'
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

function fail(message) {
  console.error(message);
  process.exit(1);
}
