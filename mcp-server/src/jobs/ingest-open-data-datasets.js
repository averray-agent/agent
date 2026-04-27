#!/usr/bin/env node

import { pathToFileURL } from "node:url";

/**
 * Ingest public open-data dataset/resource quality-audit jobs.
 *
 * The v1 provider targets the US Data.gov CKAN catalog. Data.gov's API is a
 * metadata catalog, not the dataset host, so generated jobs ask agents to
 * produce reviewable audit reports: reachability, format/schema notes, stale
 * metadata, broken resource links, and concrete improvement recommendations.
 *
 * Example:
 *   AGENT_ADMIN_TOKEN=... npm run ingest:open-data -- \
 *     --query 'res_format:CSV' \
 *     --dry-run
 */

export const DEFAULT_BASE_URL = "http://localhost:8787";
export const DEFAULT_PROVIDER = "data.gov";
export const DEFAULT_QUERY = "res_format:CSV";
export const DATA_GOV_PACKAGE_SEARCH_URL = "https://catalog.data.gov/api/3/action/package_search";
export const DATA_GOV_CATALOG_SEARCH_URL = "https://catalog.data.gov/search";

const PREFERRED_RESOURCE_FORMATS = new Set(["CSV", "JSON", "GEOJSON", "API", "XLS", "XLSX", "XML"]);
const RESOURCE_FORMAT_PRIORITY = new Map([
  ["CSV", 70],
  ["JSON", 60],
  ["GEOJSON", 55],
  ["XLSX", 50],
  ["XLS", 45],
  ["API", 40],
  ["XML", 35]
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

export async function ingestOpenDataDatasets({
  datasets = [],
  query = DEFAULT_QUERY,
  limit = 10,
  minScore = 55,
  fetchImpl = fetch
} = {}) {
  const explicitTargets = parseDatasets(datasets);
  const targets = explicitTargets.length
    ? explicitTargets
    : await searchDataGovDatasets({ query, limit: Math.max(limit * 3, 30), fetchImpl });

  const skipped = [];
  const candidates = [];
  for (const target of targets) {
    const score = scoreDatasetTarget(target);
    if (!target.resourceUrl) {
      skipped.push({ datasetId: target.datasetId, resourceId: target.resourceId, reason: "missing_resource_url" });
      continue;
    }
    if (score < minScore) {
      skipped.push({ datasetId: target.datasetId, resourceId: target.resourceId, reason: "below_min_score", score });
      continue;
    }
    candidates.push({ target, score });
  }

  const selectedCandidates = selectBestResourcePerDataset(candidates, skipped);
  const jobs = selectedCandidates
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ target, score }) => toPlatformJob(target, score));

  if (selectedCandidates.length > jobs.length) {
    skipped.push({ reason: "over_limit", count: selectedCandidates.length - jobs.length });
  }

  return {
    provider: DEFAULT_PROVIDER,
    query: explicitTargets.length ? undefined : query,
    minScore,
    count: jobs.length,
    jobs,
    skipped
  };
}

export async function searchDataGovDatasets({ query = DEFAULT_QUERY, limit = 30, fetchImpl = fetch } = {}) {
  const ckanUrl = new URL(process.env.DATA_GOV_PACKAGE_SEARCH_URL?.trim() || DATA_GOV_PACKAGE_SEARCH_URL);
  ckanUrl.searchParams.set("q", query);
  ckanUrl.searchParams.set("rows", String(Math.min(limit, 100)));
  ckanUrl.searchParams.set("sort", "metadata_modified desc");

  const ckanResponse = await fetchImpl(ckanUrl, {
    headers: dataGovHeaders()
  });
  if (ckanResponse.ok) {
    const payload = await ckanResponse.json();
    const packages = payload.result?.results ?? [];
    return packages.flatMap(extractPackageTargets);
  }

  const ckanBody = await ckanResponse.text();
  if (![404, 410].includes(ckanResponse.status)) {
    throw new Error(`Data.gov package_search failed (${ckanResponse.status}): ${ckanBody}`);
  }

  return searchDataGovCatalog({ query, limit, fetchImpl, previousStatus: ckanResponse.status, previousBody: ckanBody });
}

export async function searchDataGovCatalog({
  query = DEFAULT_QUERY,
  limit = 30,
  fetchImpl = fetch,
  previousStatus = undefined,
  previousBody = undefined
} = {}) {
  const url = new URL(process.env.DATA_GOV_CATALOG_SEARCH_URL?.trim() || DATA_GOV_CATALOG_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(Math.min(limit, 100)));
  url.searchParams.set("sort", "last_harvested_date");

  const response = await fetchImpl(url, {
    headers: dataGovHeaders()
  });
  if (!response.ok) {
    const body = await response.text();
    const previous = previousStatus ? `; package_search failed first (${previousStatus}): ${previousBody}` : "";
    throw new Error(`Data.gov catalog search failed (${response.status}): ${body}${previous}`);
  }

  const payload = await response.json();
  const results = payload.results ?? [];
  return results.flatMap(extractCatalogResultTargets);
}

export function parseDatasets(raw) {
  const parsed = typeof raw === "string" ? parseDatasetString(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeDatasetTarget).filter(Boolean);
}

export function extractPackageTargets(pkg) {
  const datasetId = text(pkg.id ?? pkg.name);
  const datasetTitle = text(pkg.title ?? pkg.name);
  const datasetUrl = pkg.name ? `https://catalog.data.gov/dataset/${pkg.name}` : text(pkg.url);
  const agency = agencyName(pkg);
  const license = text(pkg.license_title ?? pkg.license_id);
  const metadataModified = text(pkg.metadata_modified);
  const resources = Array.isArray(pkg.resources) ? pkg.resources : [];

  return resources
    .map((resource) => normalizeDatasetTarget({
      portal: DEFAULT_PROVIDER,
      datasetId,
      datasetTitle,
      datasetUrl,
      resourceId: resource.id,
      resourceTitle: resource.name ?? resource.description,
      resourceUrl: resource.url,
      resourceFormat: resource.format ?? resource.mimetype,
      agency,
      license,
      modified: resource.last_modified ?? resource.revision_timestamp ?? metadataModified,
      metadataModified
    }))
    .filter(Boolean);
}

export function extractCatalogResultTargets(result) {
  const dcat = result.dcat && typeof result.dcat === "object" ? result.dcat : {};
  const datasetId = text(result.identifier ?? dcat.identifier ?? result.slug);
  const datasetTitle = text(result.title ?? dcat.title ?? result.slug);
  const slug = text(result.slug);
  const datasetUrl = text(dcat.landingPage ?? result.landingPage)
    || (slug ? `https://catalog.data.gov/dataset/${slug}` : "");
  const agency = text(result.publisher ?? dcat.publisher?.name ?? result.organization?.name);
  const license = text(dcat.license);
  const metadataModified = text(dcat.modified ?? result.last_harvested_date);
  const distributions = Array.isArray(dcat.distribution) ? dcat.distribution : [];

  return distributions
    .map((distribution, index) => normalizeDatasetTarget({
      portal: DEFAULT_PROVIDER,
      datasetId,
      datasetTitle,
      datasetUrl,
      resourceId: text(distribution.identifier ?? distribution["@id"] ?? distribution.title) || `${datasetId || slug}-distribution-${index + 1}`,
      resourceTitle: distribution.title ?? distribution.name ?? distribution.description,
      resourceUrl: firstText(distribution.downloadURL, distribution.accessURL, distribution.url),
      resourceFormat: distribution.format ?? distribution.mediaType ?? distribution["dcat:mediaType"],
      agency,
      license,
      modified: distribution.modified ?? metadataModified,
      metadataModified,
      discoveryApi: DATA_GOV_CATALOG_SEARCH_URL
    }))
    .filter(Boolean);
}

export function scoreDatasetTarget(target) {
  let score = 25;
  if (target.datasetTitle) score += 8;
  if (target.datasetUrl) score += 10;
  if (target.resourceUrl) score += 22;
  if (PREFERRED_RESOURCE_FORMATS.has(normalizeFormat(target.resourceFormat))) score += 16;
  if (target.agency) score += 6;
  if (target.license) score += 5;
  if (target.modified || target.metadataModified) score += 8;
  if (looksOld(target.modified ?? target.metadataModified)) score += 8;
  if (!target.resourceUrl) score -= 40;
  return Math.max(0, Math.min(100, score));
}

export function selectBestResourcePerDataset(candidates, skipped = []) {
  const byDataset = new Map();
  for (const candidate of candidates) {
    const key = datasetKey(candidate.target);
    const current = byDataset.get(key);
    if (!current || compareDatasetCandidates(candidate, current) < 0) {
      byDataset.set(key, candidate);
    }
  }

  const selected = new Set(byDataset.values());
  for (const candidate of candidates) {
    if (selected.has(candidate)) continue;
    const winner = byDataset.get(datasetKey(candidate.target));
    skipped.push({
      datasetId: candidate.target.datasetId,
      resourceId: candidate.target.resourceId,
      reason: "duplicate_dataset_resource",
      selectedResourceId: winner?.target?.resourceId
    });
  }

  return [...byDataset.values()];
}

export function toPlatformJob(target, score = scoreDatasetTarget(target)) {
  const format = normalizeFormat(target.resourceFormat) || "UNKNOWN";
  const title = `Audit open-data resource: ${target.datasetTitle}`;
  const id = `open-data-datagov-${slugify(target.datasetId || target.datasetTitle)}-${slugify(target.resourceId || target.resourceTitle || format)}`.slice(0, 120);

  return {
    id,
    title,
    description:
      `Audit the Data.gov catalog resource "${target.resourceTitle || target.datasetTitle}" for reachability, format/schema clarity, stale metadata, and actionable cleanup recommendations.`,
    jobType: "work",
    requiredRole: "worker",
    category: "data",
    tier: "starter",
    rewardAsset: "DOT",
    rewardAmount: 2,
    verifierMode: "benchmark",
    verifierTerms: ["dataset_url", "resource_url", "checks", "recommended_actions"],
    verifierMinimumMatches: 3,
    inputSchemaRef: "schema://jobs/open-data-quality-audit-input",
    outputSchemaRef: "schema://jobs/open-data-quality-audit-output",
    claimTtlSeconds: 7200,
    retryLimit: 1,
    requiresSponsoredGas: true,
    source: {
      type: "open_data_dataset",
      provider: DEFAULT_PROVIDER,
      portal: DEFAULT_PROVIDER,
      datasetId: target.datasetId,
      datasetTitle: target.datasetTitle,
      datasetUrl: target.datasetUrl,
      resourceId: target.resourceId,
      resourceTitle: target.resourceTitle,
      resourceUrl: target.resourceUrl,
      resourceFormat: format,
      agency: target.agency,
      license: target.license,
      modified: target.modified,
      metadataModified: target.metadataModified,
      score,
      discoveryApi: target.discoveryApi || DATA_GOV_PACKAGE_SEARCH_URL
    },
    acceptanceCriteria: [
      "Fetch the dataset landing page and resource URL and record their status, content type, and final URL if redirected.",
      "Summarize the resource format and schema/columns when the resource is CSV, JSON, GeoJSON, XML, or spreadsheet-like.",
      "Check for stale or incomplete catalog metadata such as missing format, license, agency, modified date, or broken resource links.",
      "Report at least one concrete finding, or set no_issue_found=true with evidence for each completed check.",
      "Do not edit the government dataset directly or contact agencies; submit a reviewable audit report only."
    ],
    estimatedDifficulty: estimateDifficulty(score),
    agentInstructions: [
      "Treat this as a public-data quality audit, not a direct edit task.",
      `Review the Data.gov dataset page: ${target.datasetUrl}.`,
      `Inspect the resource URL: ${target.resourceUrl}.`,
      "If the resource is tabular, capture the header/field summary and obvious missing-value or schema problems without downloading huge files.",
      "Submit structured evidence with dataset_title, dataset_url, resource_url, checks, findings, no_issue_found, summary, and recommended_actions."
    ],
    verification: {
      method: "benchmark",
      suggestedCheck: "open_data_quality_report_complete",
      evidenceSchemaRef: "schema://jobs/open-data-quality-audit-output",
      signals: ["dataset_url_present", "resource_url_present", "checks_present", "finding_or_no_issue", "recommendations_present"]
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

function parseDatasetString(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to compact line parser.
  }
  return String(raw)
    .split(/\n/u)
    .map((entry) => {
      const [datasetTitle, datasetUrl, resourceUrl, resourceFormat, agency] = entry.split("|").map((part) => part?.trim());
      if (!datasetTitle || !datasetUrl || !resourceUrl) return undefined;
      return { datasetTitle, datasetUrl, resourceUrl, resourceFormat, agency };
    })
    .filter(Boolean);
}

function normalizeDatasetTarget(raw) {
  const portal = text(raw?.portal ?? DEFAULT_PROVIDER).toLowerCase();
  const datasetTitle = text(raw?.datasetTitle ?? raw?.title ?? raw?.name);
  const datasetUrl = text(raw?.datasetUrl ?? raw?.landingPage ?? raw?.landing_page ?? raw?.packageUrl);
  const resourceUrl = text(raw?.resourceUrl ?? raw?.downloadURL ?? raw?.downloadUrl ?? raw?.accessURL ?? raw?.accessUrl ?? raw?.url);
  if (portal !== DEFAULT_PROVIDER || !datasetTitle || !datasetUrl || !resourceUrl) return undefined;

  return {
    portal: DEFAULT_PROVIDER,
    datasetId: text(raw?.datasetId ?? raw?.packageId ?? raw?.id),
    datasetTitle,
    datasetUrl,
    resourceId: text(raw?.resourceId),
    resourceTitle: text(raw?.resourceTitle ?? raw?.resourceName),
    resourceUrl,
    resourceFormat: normalizeFormat(raw?.resourceFormat ?? raw?.format),
    agency: text(raw?.agency ?? raw?.publisher),
    license: text(raw?.license),
    modified: text(raw?.modified ?? raw?.lastModified),
    metadataModified: text(raw?.metadataModified ?? raw?.metadata_modified),
    ...(text(raw?.discoveryApi) ? { discoveryApi: text(raw.discoveryApi) } : {})
  };
}

function agencyName(pkg) {
  const organization = pkg.organization;
  if (organization && typeof organization === "object") {
    return text(organization.title ?? organization.name);
  }
  const publisher = pkg.publisher;
  if (publisher && typeof publisher === "object") {
    return text(publisher.name ?? publisher.title);
  }
  return text(publisher ?? pkg.agency);
}

function normalizeFormat(value) {
  return text(value).toUpperCase().replace(/^APPLICATION\//u, "");
}

function looksOld(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = Date.now() - timestamp;
  return ageMs > 1000 * 60 * 60 * 24 * 365 * 2;
}

function estimateDifficulty(score) {
  if (score >= 80) return "starter";
  return "review-needed";
}

function datasetKey(target) {
  return [
    DEFAULT_PROVIDER,
    target.datasetId || target.datasetUrl || target.datasetTitle
  ].map((part) => String(part ?? "").trim().toLowerCase()).join("|");
}

function compareDatasetCandidates(left, right) {
  const scoreDiff = right.score - left.score;
  if (scoreDiff !== 0) return scoreDiff;

  const formatDiff = resourceFormatPriority(right.target) - resourceFormatPriority(left.target);
  if (formatDiff !== 0) return formatDiff;

  return String(left.target.resourceUrl).localeCompare(String(right.target.resourceUrl));
}

function resourceFormatPriority(target) {
  return RESOURCE_FORMAT_PRIORITY.get(normalizeFormat(target.resourceFormat)) ?? 0;
}

function text(value) {
  return String(value ?? "").trim();
}

function firstText(...values) {
  return values.map(text).find(Boolean) ?? "";
}

function dataGovHeaders() {
  return {
    accept: "application/json",
    "user-agent": "AverrayOpenDataIngest/0.1 (https://averray.com; operator@averray.com)"
  };
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
  const datasets = args.datasets ?? process.env.OPEN_DATA_INGEST_DATASETS_JSON ?? process.env.OPEN_DATA_INGEST_DATASETS;
  const query = String(args.query ?? process.env.OPEN_DATA_INGEST_QUERY ?? DEFAULT_QUERY);
  const limit = parsePositiveInt(args.limit, 10);
  const minScore = parsePositiveInt(args["min-score"], 55);
  const baseUrl = trimTrailingSlash(String(args.baseUrl ?? process.env.AGENT_API_BASE_URL ?? DEFAULT_BASE_URL));
  const adminToken = process.env.AGENT_ADMIN_TOKEN?.trim();

  if (!dryRun && !adminToken) {
    fail("AGENT_ADMIN_TOKEN is required unless --dry-run is set.");
  }

  const dryRunPayload = await ingestOpenDataDatasets({ datasets, query, limit, minScore });
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
