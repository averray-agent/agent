#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { schemaRefToJobSchemaPath } from "../core/job-schema-registry.js";

export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_BASE_URL = "http://localhost:8787";
export const DEFAULT_CATEGORIES = [
  { title: "Category:All articles with dead external links", taskType: "citation_repair" },
  { title: "Category:All articles with unsourced statements", taskType: "citation_repair" },
  { title: "Category:Wikipedia articles in need of updating", taskType: "freshness_check" },
  { title: "Category:Articles with infoboxes needing cleanup", taskType: "infobox_consistency" }
];

const TASK_CONFIG = {
  citation_repair: {
    titlePrefix: "Wikipedia citation repair",
    outputSchemaRef: "schema://jobs/wikipedia-citation-repair-output",
    verifierTerms: ["page_title", "revision_id", "citation_findings", "proposed_changes", "review_notes"],
    rewardAmount: 4
  },
  freshness_check: {
    titlePrefix: "Wikipedia freshness check",
    outputSchemaRef: "schema://jobs/wikipedia-freshness-check-output",
    verifierTerms: ["page_title", "revision_id", "freshness_findings", "recommended_editor_actions", "risk_level"],
    rewardAmount: 4
  },
  infobox_consistency: {
    titlePrefix: "Wikipedia infobox consistency",
    outputSchemaRef: "schema://jobs/wikipedia-infobox-consistency-output",
    verifierTerms: ["page_title", "revision_id", "checked_fields", "proposed_changes", "review_notes"],
    rewardAmount: 4
  }
};

const MAINTENANCE_TEMPLATE_HINTS = [
  "Template:Dead link",
  "Template:Citation needed",
  "Template:Update",
  "Template:Outdated",
  "Template:Infobox"
];

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

export async function ingestWikipediaMaintenance({
  language = DEFAULT_LANGUAGE,
  categories = DEFAULT_CATEGORIES,
  limit = 10,
  minScore = 55,
  fetchImpl = fetch
} = {}) {
  const normalizedLanguage = normalizeLanguage(language);
  const normalizedCategories = parseCategories(categories);
  const seen = new Set();
  const candidates = [];
  let discovered = 0;

  for (const category of normalizedCategories) {
    if (candidates.length >= limit * 3) break;
    const members = await fetchCategoryMembers({
      language: normalizedLanguage,
      categoryTitle: category.title,
      limit: Math.max(limit * 2, 10),
      fetchImpl
    });
    discovered += members.length;
    for (const member of members) {
      const article = await fetchArticleDetails({
        language: normalizedLanguage,
        pageId: member.pageid,
        category,
        fetchImpl
      });
      if (!article) continue;
      const key = wikipediaArticleKey(article);
      if (seen.has(key)) continue;
      seen.add(key);
      const score = scoreArticle(article);
      if (score >= minScore) {
        candidates.push({ article, score });
      }
    }
  }

  const jobs = candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ article, score }) => toPlatformJob(article, score));

  return {
    language: normalizedLanguage,
    categories: normalizedCategories.map((category) => category.title),
    minScore,
    count: jobs.length,
    jobs,
    skipped: Math.max(0, discovered - jobs.length)
  };
}

export async function fetchCategoryMembers({ language, categoryTitle, limit, fetchImpl = fetch }) {
  const url = mediaWikiActionUrl(language);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("list", "categorymembers");
  url.searchParams.set("cmtitle", categoryTitle);
  url.searchParams.set("cmnamespace", "0");
  url.searchParams.set("cmlimit", String(Math.min(limit, 50)));
  url.searchParams.set("origin", "*");

  const response = await fetchImpl(url, { headers: requestHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Wikipedia category query failed (${response.status}): ${body}`);
  }
  const payload = await response.json();
  return payload?.query?.categorymembers ?? [];
}

export async function fetchArticleDetails({ language, pageId, category, fetchImpl = fetch }) {
  const url = mediaWikiActionUrl(language);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("prop", "info|revisions|templates");
  url.searchParams.set("inprop", "url");
  url.searchParams.set("rvlimit", "1");
  url.searchParams.set("rvprop", "ids|timestamp");
  url.searchParams.set("tllimit", "50");
  url.searchParams.set("pageids", String(pageId));
  url.searchParams.set("origin", "*");

  const response = await fetchImpl(url, { headers: requestHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Wikipedia page query failed (${response.status}): ${body}`);
  }
  const payload = await response.json();
  const page = Object.values(payload?.query?.pages ?? {})[0];
  if (!page || page.missing) {
    return undefined;
  }
  const revision = page.revisions?.[0] ?? {};
  const taskType = normalizeTaskType(category.taskType ?? inferTaskType(category.title, page.templates));
  return {
    language,
    pageId: Number(page.pageid ?? pageId),
    title: String(page.title ?? ""),
    pageUrl: String(page.fullurl ?? `https://${language}.wikipedia.org/wiki/${encodeURIComponent(String(page.title ?? ""))}`),
    revisionId: String(revision.revid ?? ""),
    revisionTimestamp: revision.timestamp,
    categoryTitle: category.title,
    taskType,
    templates: (page.templates ?? []).map((template) => String(template.title ?? "")).filter(Boolean)
  };
}

export function scoreArticle(article) {
  let score = 25;
  if (article.revisionId) score += 15;
  if (article.pageId) score += 10;
  if (article.taskType === "citation_repair") score += 20;
  if (article.taskType === "freshness_check") score += 18;
  if (article.taskType === "infobox_consistency") score += 16;
  if (article.templates.some((template) => MAINTENANCE_TEMPLATE_HINTS.some((hint) => template.includes(hint)))) {
    score += 15;
  }
  if (/\b(list of|timeline of|draft:|template:)\b/iu.test(article.title)) score -= 15;
  return Math.max(0, score);
}

export function toPlatformJob(article, score = scoreArticle(article)) {
  const task = TASK_CONFIG[article.taskType] ?? TASK_CONFIG.citation_repair;
  const slug = slugify(article.title).slice(0, 48);
  const id = `wiki-${article.language}-${article.pageId}-${article.taskType}-${slug}`.slice(0, 120);
  const articleUrl = article.articleUrl ?? article.pageUrl;
  const pinnedRevisionUrl = article.pinnedRevisionUrl ?? wikipediaPinnedRevisionUrl(article);
  const outputSchemaUrl = schemaRefToJobSchemaPath(task.outputSchemaRef);

  return {
    id,
    title: `${task.titlePrefix}: ${article.title}`,
    description:
      `Review Wikipedia article "${article.title}" at revision ${article.revisionId} and return an Averray-attributed, editor-ready proposal.`,
    jobType: "review",
    requiredRole: "worker",
    category: "wikipedia",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: task.rewardAmount,
    verifierMode: "benchmark",
    verifierTerms: task.verifierTerms,
    verifierMinimumMatches: 4,
    inputSchemaRef: "schema://jobs/wikipedia-maintenance-input",
    outputSchemaRef: task.outputSchemaRef,
    claimTtlSeconds: 3600,
    retryLimit: 1,
    requiresSponsoredGas: true,
    source: {
      type: "wikipedia_article",
      project: "wikipedia",
      language: article.language,
      lang: article.language,
      pageId: article.pageId,
      pageTitle: article.title,
      pageUrl: article.pageUrl,
      articleUrl,
      revisionId: article.revisionId,
      pinnedRevisionUrl,
      proposalOnly: true,
      revisionTimestamp: article.revisionTimestamp,
      categoryTitle: article.categoryTitle,
      taskType: article.taskType,
      templates: article.templates,
      score,
      outputSchemaRef: task.outputSchemaRef,
      outputSchemaUrl,
      discoveryApi: `https://${article.language}.wikipedia.org/w/api.php`,
      writePolicy: "averray_company_reviewed_proposal_only",
      attributionPolicy: "Averray proposal only / no direct Wikipedia edit",
      attribution: {
        proposer: "Averray",
        directEdit: false,
        note:
          "Worker output is submitted to Averray. Any later communication or edit to Wikipedia must be attributed to Averray and comply with Wikipedia disclosure and bot/editor rules."
      }
    },
    acceptanceCriteria: [
      "Names the exact Wikipedia page title and revision id reviewed.",
      "Uses public Wikipedia revision data and reliable external source URLs.",
      "Returns a structured proposal that can be reviewed by a human editor.",
      "Does not claim the live Wikipedia article was edited.",
      "Keeps Averray attribution intact for any downstream submission."
    ],
    estimatedDifficulty: estimateDifficulty(score),
    agentInstructions: [
      `Review the fixed revision at ${pinnedRevisionUrl}.`,
      "Do not edit Wikipedia directly from the agent account.",
      "Submit the correction or review notes back to Averray as structured evidence.",
      "Any later public Wikipedia communication must come from Averray or an approved Averray editor/bot account, with required disclosures.",
      "Include source URLs and enough context for a human editor to verify the proposal."
    ],
    verification: {
      method: "reviewable_wikipedia_proposal",
      evidenceSchemaRef: task.outputSchemaRef,
      signals: ["page_revision_cited", "source_urls_present", "proposal_only", "averray_attribution", "human_review_ready"]
    }
  };
}

export function wikipediaPinnedRevisionUrl(article) {
  const language = normalizeLanguage(article?.language ?? DEFAULT_LANGUAGE);
  const revisionId = String(article?.revisionId ?? "").trim();
  const title = String(article?.title ?? article?.pageTitle ?? "").trim();
  const url = new URL(`https://${language}.wikipedia.org/w/index.php`);
  if (title) {
    url.searchParams.set("title", title.replace(/\s+/gu, "_"));
  }
  if (revisionId) {
    url.searchParams.set("oldid", revisionId);
  }
  return String(url);
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
  return { id: job.id, status: response.status, ok: response.ok, payload };
}

export function parseCategories(raw) {
  if (!raw) return DEFAULT_CATEGORIES;
  if (Array.isArray(raw)) {
    return raw.map(normalizeCategory).filter(Boolean);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(normalizeCategory).filter(Boolean);
    } catch {
      // Fall through to comma/newline parsing.
    }
    return raw
      .split(/\n|,/u)
      .map((title) => normalizeCategory(title))
      .filter(Boolean);
  }
  return DEFAULT_CATEGORIES;
}

export function wikipediaArticleKey(article) {
  return `${article.language}:${article.pageId}:${article.revisionId}:${article.taskType}`;
}

function normalizeCategory(raw) {
  if (typeof raw === "string") {
    const title = raw.trim();
    return title ? { title, taskType: inferTaskType(title) } : undefined;
  }
  const title = String(raw?.title ?? "").trim();
  if (!title) return undefined;
  return { title, taskType: normalizeTaskType(raw?.taskType ?? inferTaskType(title)) };
}

function inferTaskType(title, templates = []) {
  const haystack = `${title} ${templates.map((template) => template.title ?? template).join(" ")}`.toLowerCase();
  if (/\b(update|outdated|current|freshness)\b/u.test(haystack)) return "freshness_check";
  if (/\binfobox\b/u.test(haystack)) return "infobox_consistency";
  return "citation_repair";
}

function normalizeTaskType(value) {
  const taskType = String(value ?? "").trim();
  return TASK_CONFIG[taskType] ? taskType : "citation_repair";
}

function normalizeLanguage(value) {
  const language = String(value ?? DEFAULT_LANGUAGE).trim().toLowerCase();
  return /^[a-z][a-z0-9-]{1,15}$/u.test(language) ? language : DEFAULT_LANGUAGE;
}

function mediaWikiActionUrl(language) {
  return new URL(`https://${normalizeLanguage(language)}.wikipedia.org/w/api.php`);
}

function requestHeaders() {
  return {
    accept: "application/json",
    "user-agent": "AverrayWikipediaIngest/0.1 (https://averray.com; operator@averray.com)"
  };
}

function estimateDifficulty(score) {
  if (score >= 80) return "starter";
  if (score >= 65) return "starter-plus";
  return "review-needed";
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
  const language = String(args.language ?? process.env.WIKIPEDIA_INGEST_LANGUAGE ?? DEFAULT_LANGUAGE);
  const categories = args.categories ?? process.env.WIKIPEDIA_INGEST_CATEGORIES_JSON ?? process.env.WIKIPEDIA_INGEST_CATEGORIES;
  const limit = parsePositiveInt(args.limit, 10);
  const minScore = parsePositiveInt(args["min-score"], 55);
  const baseUrl = trimTrailingSlash(String(args.baseUrl ?? process.env.AGENT_API_BASE_URL ?? DEFAULT_BASE_URL));
  const adminToken = process.env.AGENT_ADMIN_TOKEN?.trim();

  if (!dryRun && !adminToken) {
    fail("AGENT_ADMIN_TOKEN is required unless --dry-run is set.");
  }

  const dryRunPayload = await ingestWikipediaMaintenance({ language, categories, limit, minScore });
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
