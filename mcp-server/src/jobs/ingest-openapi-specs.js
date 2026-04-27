#!/usr/bin/env node

import { pathToFileURL } from "node:url";

/**
 * Ingest OpenAPI quality audit jobs.
 *
 * Operators configure public OpenAPI documents and the local/API surface that
 * should stay aligned with them. Generated jobs ask workers to validate the
 * spec shape, examples, descriptions, and drift evidence, then submit a
 * reviewable audit report or PR recommendation.
 */

export const DEFAULT_BASE_URL = "http://localhost:8787";
export const DEFAULT_PROVIDER = "openapi";

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

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

export async function ingestOpenApiSpecs({
  specs = [],
  limit = 10,
  minScore = 55,
  fetchImpl = fetch
} = {}) {
  const targets = parseOpenApiSpecs(specs);
  const skipped = [];
  const candidates = [];

  for (const target of targets) {
    try {
      const enriched = await fetchOpenApiDetails({ target, fetchImpl });
      const score = scoreOpenApiTarget(enriched);
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
    provider: DEFAULT_PROVIDER,
    specCount: targets.length,
    minScore,
    count: jobs.length,
    jobs,
    skipped
  };
}

export async function fetchOpenApiDetails({ target, fetchImpl = fetch }) {
  const response = await fetchImpl(target.specUrl, {
    headers: requestHeaders()
  });
  const rawBody = await response.text();
  const parsed = parseOpenApiDocument(rawBody, headerValue(response.headers, "content-type"));
  return {
    ...target,
    apiTitle: target.apiTitle || parsed.title || target.specUrl,
    finalUrl: response.url || target.specUrl,
    httpStatus: response.status,
    ok: response.ok,
    contentType: headerValue(response.headers, "content-type"),
    lastModified: headerValue(response.headers, "last-modified"),
    etag: headerValue(response.headers, "etag"),
    openapiVersion: parsed.openapiVersion,
    documentVersion: parsed.documentVersion,
    pathCount: parsed.pathCount,
    operationCount: parsed.operationCount,
    schemaCount: parsed.schemaCount,
    missingOperationDescriptions: parsed.missingOperationDescriptions,
    missingOperationIds: parsed.missingOperationIds,
    exampleCount: parsed.exampleCount,
    parseMode: parsed.parseMode
  };
}

export function parseOpenApiSpecs(raw) {
  const parsed = typeof raw === "string" ? parseSpecString(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeOpenApiTarget).filter(Boolean);
}

export function parseOpenApiDocument(rawBody, contentType = "") {
  const body = String(rawBody ?? "");
  const json = parseJson(body);
  if (json && typeof json === "object") {
    return inspectOpenApiJson(json);
  }
  return inspectOpenApiText(body, contentType);
}

export function scoreOpenApiTarget(target) {
  let score = 20;
  if (target.provider) score += 5;
  if (target.apiTitle) score += 10;
  if (target.specUrl) score += 15;
  if (target.localSurface) score += 8;
  if (target.ok) score += 18;
  if (target.httpStatus && target.httpStatus !== 200) score -= 20;
  if (target.openapiVersion) score += 12;
  if (target.pathCount > 0) score += 10;
  if (target.operationCount > 0) score += 8;
  if (target.schemaCount > 0) score += 5;
  if (target.missingOperationDescriptions > 0) score += 4;
  if (target.missingOperationIds > 0) score += 3;
  if (target.exampleCount === 0 && target.operationCount > 0) score += 3;
  return Math.max(0, Math.min(100, score));
}

export function openApiSpecKey(source) {
  if (!source?.specUrl) return undefined;
  return [
    String(source.provider ?? DEFAULT_PROVIDER).toLowerCase(),
    String(source.specUrl).toLowerCase(),
    String(source.localSurface ?? "").toLowerCase()
  ].join("|");
}

export function toPlatformJob(target, score = scoreOpenApiTarget(target)) {
  const provider = normalizeProvider(target.provider);
  const apiTitle = target.apiTitle || target.specUrl;
  const localSurface = target.localSurface || target.repo || "configured API implementation or docs";
  const id = `openapi-${slugify(provider)}-${slugify(target.specId || apiTitle)}`.slice(0, 120);

  return {
    id,
    title: `Audit OpenAPI quality: ${apiTitle}`,
    description:
      `Validate the public OpenAPI document "${apiTitle}" and compare it with "${localSurface}" for broken examples, missing descriptions, schema drift, and endpoint documentation gaps.`,
    jobType: "review",
    requiredRole: "worker",
    category: "api",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 3,
    verifierMode: "benchmark",
    verifierTerms: ["spec_url", "checks", "findings", "recommended_actions"],
    verifierMinimumMatches: 3,
    inputSchemaRef: "schema://jobs/openapi-quality-audit-input",
    outputSchemaRef: "schema://jobs/openapi-quality-audit-output",
    claimTtlSeconds: 7200,
    retryLimit: 1,
    requiresSponsoredGas: true,
    source: {
      type: "openapi_spec",
      provider,
      specId: target.specId,
      apiTitle,
      specUrl: target.specUrl,
      finalUrl: target.finalUrl,
      localSurface,
      repo: target.repo,
      httpStatus: target.httpStatus,
      contentType: target.contentType,
      lastModified: target.lastModified,
      etag: target.etag,
      openapiVersion: target.openapiVersion,
      documentVersion: target.documentVersion,
      pathCount: target.pathCount,
      operationCount: target.operationCount,
      schemaCount: target.schemaCount,
      missingOperationDescriptions: target.missingOperationDescriptions,
      missingOperationIds: target.missingOperationIds,
      exampleCount: target.exampleCount,
      parseMode: target.parseMode,
      score,
      discoveryApi: target.specUrl
    },
    acceptanceCriteria: [
      "Fetch the OpenAPI document and record status, content type, final URL, and OpenAPI version.",
      "Check endpoint coverage, operation descriptions, operationIds, request/response examples, and schema references.",
      "Compare the configured local surface against the public spec for stale endpoint names, missing changelog/docs references, or schema drift.",
      "Report at least one concrete finding, or set no_issue_found=true with evidence for each completed check.",
      "Submit a reviewable audit report or PR recommendation; do not mutate the public API spec directly."
    ],
    estimatedDifficulty: score >= 80 ? "starter" : "review-needed",
    agentInstructions: [
      `Review the OpenAPI document: ${target.specUrl}.`,
      `Audit this local/API surface: ${localSurface}.`,
      "Inspect operation descriptions, operationIds, examples, response schemas, and stale endpoint references.",
      "Submit structured evidence with api_title, spec_url, checks, findings, no_issue_found, summary, and recommended_actions.",
      "Keep the output reviewable and cite exact paths, methods, schema names, or section links."
    ],
    verification: {
      method: "benchmark",
      suggestedCheck: "openapi_quality_report_complete",
      evidenceSchemaRef: "schema://jobs/openapi-quality-audit-output",
      signals: ["spec_url_present", "checks_present", "finding_or_no_issue", "recommendations_present"]
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
      const [apiTitle, specUrl, provider, localSurface, repo] = entry.split("|").map((part) => part?.trim());
      if (!apiTitle || !specUrl) return undefined;
      return { apiTitle, specUrl, provider, localSurface, repo };
    })
    .filter(Boolean);
}

function normalizeOpenApiTarget(raw) {
  const specUrl = text(raw?.specUrl ?? raw?.url);
  const apiTitle = text(raw?.apiTitle ?? raw?.title ?? raw?.name);
  if (!specUrl || !isHttpUrl(specUrl)) return undefined;
  return {
    provider: normalizeProvider(raw?.provider),
    specId: text(raw?.specId ?? raw?.id),
    apiTitle,
    specUrl,
    localSurface: text(raw?.localSurface ?? raw?.surface ?? raw?.path),
    repo: text(raw?.repo)
  };
}

function inspectOpenApiJson(document) {
  const paths = objectOrEmpty(document.paths);
  const operations = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(objectOrEmpty(pathItem))) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      operations.push({ path, method: method.toLowerCase(), operation: objectOrEmpty(operation) });
    }
  }
  const schemas = objectOrEmpty(document.components?.schemas ?? document.definitions);
  return {
    parseMode: "json",
    openapiVersion: text(document.openapi ?? document.swagger),
    title: text(document.info?.title),
    documentVersion: text(document.info?.version),
    pathCount: Object.keys(paths).length,
    operationCount: operations.length,
    schemaCount: Object.keys(schemas).length,
    missingOperationDescriptions: operations.filter(({ operation }) => !text(operation.summary) && !text(operation.description)).length,
    missingOperationIds: operations.filter(({ operation }) => !text(operation.operationId)).length,
    exampleCount: countExamples(document)
  };
}

function inspectOpenApiText(body, contentType) {
  const openapiVersion = firstMatch(body, /^\s*(?:openapi|swagger)\s*:\s*["']?([^"'\n]+)["']?\s*$/imu);
  const title = firstMatch(body, /^\s*title\s*:\s*["']?([^"'\n]+)["']?\s*$/imu);
  const documentVersion = firstMatch(body, /^\s*version\s*:\s*["']?([^"'\n]+)["']?\s*$/imu);
  const methodMatches = body.match(/^\s+(get|put|post|delete|options|head|patch|trace)\s*:/gimu) ?? [];
  const pathMatches = body.match(/^\s{2}\/[^:\n]+:/gmu) ?? [];
  return {
    parseMode: contentType.includes("yaml") || /\.ya?ml(?:$|\?)/iu.test(contentType) ? "yaml" : "text",
    openapiVersion,
    title,
    documentVersion,
    pathCount: pathMatches.length,
    operationCount: methodMatches.length,
    schemaCount: (body.match(/^\s{4}[A-Za-z0-9_.-]+\s*:\s*$/gmu) ?? []).length,
    missingOperationDescriptions: 0,
    missingOperationIds: 0,
    exampleCount: (body.match(/\bexamples?\s*:/giu) ?? []).length
  };
}

function countExamples(value) {
  let count = 0;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "example" || key === "examples") count += 1;
      visit(child);
    }
  };
  visit(value);
  return count;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function firstMatch(value, pattern) {
  return text(String(value).match(pattern)?.[1]);
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requestHeaders() {
  return {
    accept: "application/json,application/yaml,text/yaml,text/plain;q=0.9,*/*;q=0.8",
    "user-agent": "AverrayOpenApiIngest/0.1 (https://averray.com; operator@averray.com)"
  };
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

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
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
  const specs = args.specs ?? process.env.OPENAPI_INGEST_SPECS_JSON ?? process.env.OPENAPI_INGEST_SPECS;
  const limit = parsePositiveInt(args.limit, 10);
  const minScore = parsePositiveInt(args["min-score"], 55);
  const baseUrl = trimTrailingSlash(String(args.baseUrl ?? process.env.AGENT_API_BASE_URL ?? DEFAULT_BASE_URL));
  const adminToken = process.env.AGENT_ADMIN_TOKEN?.trim();

  if (!dryRun && !adminToken) {
    fail("AGENT_ADMIN_TOKEN is required unless --dry-run is set.");
  }

  const dryRunPayload = await ingestOpenApiSpecs({ specs, limit, minScore });
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
