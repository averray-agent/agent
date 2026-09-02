#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { DEFAULT_ESCROW_ASSET_SYMBOL } from "../core/assets.js";

/**
 * Ingest standards/spec freshness audit jobs.
 *
 * The provider is allowlist-driven: operators configure canonical public
 * specification URLs and the local/documentation surface that should stay in
 * sync with them. Generated jobs ask agents to produce reviewable drift
 * reports, not to edit external standards bodies directly.
 *
 * Example:
 *   AGENT_ADMIN_TOKEN=... npm run ingest:standards-specs -- \
 *     --specs '[{"provider":"w3c","specTitle":"Verifiable Credentials Data Model v2.0","specUrl":"https://www.w3.org/TR/vc-data-model-2.0/","localSurface":"docs/"}]' \
 *     --dry-run
 */

export const DEFAULT_BASE_URL = "http://localhost:8787";
export const DEFAULT_PROVIDER = "custom";

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

export async function ingestStandardsSpecs({
  specs = [],
  limit = 10,
  minScore = 55,
  fetchImpl = fetch
} = {}) {
  const targets = parseSpecs(specs);
  const skipped = [];
  const candidates = [];

  for (const target of targets) {
    try {
      const enriched = await fetchSpecDetails({ target, fetchImpl });
      const score = scoreSpecTarget(enriched);
      if (score < minScore) {
        skipped.push({ specUrl: target.specUrl, reason: "below_min_score", score });
        continue;
      }
      candidates.push({ target: enriched, score });
    } catch (error) {
      skipped.push({
        specUrl: target.specUrl,
        reason: "fetch_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const jobs = candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ target, score }) => toPlatformJob(target, score));

  if (candidates.length > jobs.length) {
    skipped.push({ reason: "over_limit", count: candidates.length - jobs.length });
  }

  return {
    provider: "standards",
    specCount: targets.length,
    minScore,
    count: jobs.length,
    jobs,
    skipped
  };
}

export async function fetchSpecDetails({ target, fetchImpl = fetch }) {
  const response = await fetchImpl(target.specUrl, {
    headers: requestHeaders()
  });
  const textBody = await response.text();
  const htmlTitle = extractHtmlTitle(textBody);
  const canonicalUrl = extractCanonicalUrl(textBody, target.specUrl);
  return {
    ...target,
    specTitle: target.specTitle || htmlTitle || target.specUrl,
    finalUrl: response.url || target.specUrl,
    canonicalUrl,
    httpStatus: response.status,
    ok: response.ok,
    contentType: headerValue(response.headers, "content-type"),
    lastModified: headerValue(response.headers, "last-modified"),
    etag: headerValue(response.headers, "etag")
  };
}

export function parseSpecs(raw) {
  const parsed = typeof raw === "string" ? parseSpecString(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeSpecTarget).filter(Boolean);
}

export function scoreSpecTarget(target) {
  let score = 25;
  if (target.provider) score += 5;
  if (target.specTitle) score += 10;
  if (target.specUrl) score += 15;
  if (target.localSurface) score += 12;
  if (target.ok) score += 20;
  if (target.httpStatus && target.httpStatus !== 200) score -= 20;
  if (target.canonicalUrl) score += 6;
  if (target.lastModified) score += 6;
  if (target.etag) score += 4;
  if (target.expectedStatus) score += 4;
  if (target.currentVersion) score += 4;
  return Math.max(0, Math.min(100, score));
}

export function standardsSpecKey(source) {
  if (!source?.specUrl) return undefined;
  return [
    String(source.provider ?? DEFAULT_PROVIDER).toLowerCase(),
    String(source.specUrl).toLowerCase(),
    String(source.localSurface ?? "").toLowerCase()
  ].join("|");
}

export function toPlatformJob(target, score = scoreSpecTarget(target)) {
  const provider = normalizeProvider(target.provider);
  const specTitle = target.specTitle || target.specUrl;
  const localSurface = target.localSurface || target.repo || "configured project docs";
  const id = `standards-${slugify(provider)}-${slugify(target.specId || specTitle)}`.slice(0, 120);

  return {
    id,
    title: `Audit standards freshness: ${specTitle}`,
    description:
      `Compare the local surface "${localSurface}" against the canonical ${provider} specification "${specTitle}" and report any drift or missing updates.`,
    jobType: "review",
    requiredRole: "worker",
    category: "docs",
    tier: "starter",
    rewardAsset: DEFAULT_ESCROW_ASSET_SYMBOL,
    rewardAmount: 3,
    verifierMode: "benchmark",
    verifierTerms: ["source_surface", "drift_findings", "missing_updates", "fix_recommendation"],
    verifierMinimumMatches: 3,
    inputSchemaRef: "schema://jobs/docs-input",
    outputSchemaRef: "schema://jobs/docs-drift-audit-output",
    claimTtlSeconds: 7200,
    retryLimit: 1,
    requiresSponsoredGas: true,
    source: {
      type: "standards_spec",
      provider,
      specId: target.specId,
      specTitle,
      specUrl: target.specUrl,
      finalUrl: target.finalUrl,
      canonicalUrl: target.canonicalUrl,
      currentVersion: target.currentVersion,
      expectedStatus: target.expectedStatus,
      localSurface,
      repo: target.repo,
      httpStatus: target.httpStatus,
      contentType: target.contentType,
      lastModified: target.lastModified,
      etag: target.etag,
      score,
      discoveryApi: target.specUrl
    },
    acceptanceCriteria: [
      "Fetch the canonical specification URL and cite the exact version, status, or modified metadata that is visible.",
      "Compare the configured local surface against the canonical spec for stale terminology, outdated requirements, missing links, or obsolete references.",
      "Return at least one concrete drift finding, or set severity=low with evidence that no issue was found.",
      "Include a focused fix recommendation that can become a follow-up PR or documentation task.",
      "Do not edit the external standards body page; submit a reviewable audit report only."
    ],
    estimatedDifficulty: score >= 80 ? "starter" : "review-needed",
    agentInstructions: [
      `Review the canonical specification: ${target.specUrl}.`,
      `Audit this local surface or repository area: ${localSurface}.`,
      "Capture the source_surface, drift_findings, missing_updates, severity, and fix_recommendation fields exactly.",
      "Prefer exact section links, version strings, headings, or status banners over broad summaries.",
      "Treat the result as a standards freshness audit, not a direct standards edit."
    ],
    verification: {
      method: "benchmark",
      suggestedCheck: "docs_drift_audit_complete",
      evidenceSchemaRef: "schema://jobs/docs-drift-audit-output",
      signals: ["source_surface_present", "canonical_spec_cited", "drift_or_no_issue", "severity_present", "recommendation_present"]
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
  return { id: job.id, status: response.status, ok: response.ok, payload };
}

function parseSpecString(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to compact line parser.
  }
  return String(raw)
    .split(/\n/u)
    .map((entry) => {
      const [specTitle, specUrl, provider, localSurface, expectedStatus] = entry.split("|").map((part) => part?.trim());
      if (!specTitle || !specUrl) return undefined;
      return { specTitle, specUrl, provider, localSurface, expectedStatus };
    })
    .filter(Boolean);
}

function normalizeSpecTarget(raw) {
  const specUrl = text(raw?.specUrl ?? raw?.url);
  const specTitle = text(raw?.specTitle ?? raw?.title ?? raw?.name);
  if (!specUrl || !isHttpUrl(specUrl)) return undefined;
  return {
    provider: normalizeProvider(raw?.provider),
    specId: text(raw?.specId ?? raw?.id),
    specTitle,
    specUrl,
    currentVersion: text(raw?.currentVersion ?? raw?.version),
    expectedStatus: text(raw?.expectedStatus ?? raw?.status),
    localSurface: text(raw?.localSurface ?? raw?.surface ?? raw?.path),
    repo: text(raw?.repo)
  };
}

function extractHtmlTitle(body) {
  const match = String(body).match(/<title[^>]*>([^<]+)<\/title>/iu);
  return match ? decodeHtml(match[1]).replace(/\s+/gu, " ").trim() : "";
}

function extractCanonicalUrl(body, baseUrl) {
  const match = String(body).match(/<link[^>]+rel=["']canonical["'][^>]*>/iu)
    ?? String(body).match(/<link[^>]+href=["'][^"']+["'][^>]+rel=["']canonical["'][^>]*>/iu);
  if (!match) return "";
  const href = match[0].match(/href=["']([^"']+)["']/iu)?.[1];
  if (!href) return "";
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return text(headers.get(name));
  }
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return text(direct);
}

function normalizeProvider(value) {
  return text(value || DEFAULT_PROVIDER).toLowerCase();
}

function requestHeaders() {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "user-agent": "AverrayStandardsIngest/0.1 (https://averray.com; operator@averray.com)"
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function decodeHtml(value) {
  // Decode &amp; LAST so an already-encoded entity like "&amp;lt;" stays "&lt;"
  // instead of being double-unescaped to "<" (CodeQL js/double-escaping).
  return String(value)
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function text(value) {
  return String(value ?? "").trim();
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
  const specs = args.specs ?? process.env.STANDARDS_INGEST_SPECS_JSON ?? process.env.STANDARDS_INGEST_SPECS;
  const limit = parsePositiveInt(args.limit, 10);
  const minScore = parsePositiveInt(args["min-score"], 55);
  const baseUrl = trimTrailingSlash(String(args.baseUrl ?? process.env.AGENT_API_BASE_URL ?? DEFAULT_BASE_URL));
  const adminToken = process.env.AGENT_ADMIN_TOKEN?.trim();

  if (!dryRun && !adminToken) {
    fail("AGENT_ADMIN_TOKEN is required unless --dry-run is set.");
  }

  const dryRunPayload = await ingestStandardsSpecs({ specs, limit, minScore });
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
