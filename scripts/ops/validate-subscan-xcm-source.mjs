#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const options = parseArgs(args);

if (options.help) {
  printHelp();
  process.exit(0);
}

const apiHost = requiredEnv("XCM_SUBSCAN_API_HOST");
const apiKey = requiredEnv("XCM_SUBSCAN_API_KEY");
const limit = options.limit ?? parsePositiveInt(process.env.XCM_SOURCE_LIMIT, 10);
const requirePublished = options.requirePublished || truthy(process.env.REQUIRE_PUBLISHED);
const capturePath = options.capture ?? process.env.XCM_CAPTURE_PATH;
const indexerBaseUrl = process.env.INDEXER_URL?.trim();
const indexerStatusUrl = options.indexerStatusUrl
  ?? process.env.INDEXER_XCM_STATUS_URL?.trim()
  ?? (indexerBaseUrl ? new URL("/xcm/outcomes/status", ensureTrailingSlash(indexerBaseUrl)).toString() : undefined);
const indexerOutcomesUrl = options.indexerOutcomesUrl
  ?? process.env.INDEXER_XCM_OUTCOMES_URL?.trim()
  ?? (indexerBaseUrl ? new URL("/xcm/outcomes", ensureTrailingSlash(indexerBaseUrl)).toString() : undefined);

const directPayload = await fetchSubscanBatch({
  apiHost,
  apiKey,
  limit
});

const sampleItems = Array.isArray(directPayload?.data?.list) ? directPayload.data.list : [];
const summary = buildSampleSummary(sampleItems);

if (sampleItems.length > 0 && summary.requestIdCandidates === 0) {
  throw new Error("Subscan validation failed: no request-id-like fields were found in the sampled rows.");
}
if (sampleItems.length > 0 && summary.statusCandidates === 0) {
  throw new Error("Subscan validation failed: no status-like fields were found in the sampled rows.");
}
if (sampleItems.length > 0 && summary.timestampCandidates === 0) {
  throw new Error("Subscan validation failed: no timestamp-like fields were found in the sampled rows.");
}

let indexerStatus = undefined;
if (indexerStatusUrl) {
  indexerStatus = await fetchJson(indexerStatusUrl, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });
  assertIndexerStatus(indexerStatus);
}

let indexerOutcomes = undefined;
if (indexerOutcomesUrl) {
  const url = new URL(indexerOutcomesUrl);
  url.searchParams.set("limit", String(Math.min(limit, 5)));
  indexerOutcomes = await fetchJson(url, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });
  assertIndexerOutcomes(indexerOutcomes);
}

if (requirePublished) {
  if (!indexerStatusUrl || !indexerOutcomesUrl) {
    throw new Error("Published-feed validation requires INDEXER_URL or both INDEXER_XCM_STATUS_URL and INDEXER_XCM_OUTCOMES_URL.");
  }
  if (Number(indexerStatus?.publishedCount ?? 0) <= 0) {
    throw new Error("Published-feed validation failed: indexer reports zero published outcomes.");
  }
  if (indexerStatus?.source?.type !== "subscan_xcm") {
    throw new Error(`Published-feed validation failed: expected source.type=subscan_xcm, got ${JSON.stringify(indexerStatus?.source)}.`);
  }
  if (indexerOutcomes?.meta?.source !== "external_xcm_observer_feed") {
    throw new Error(`Published-feed validation failed: expected /xcm/outcomes meta.source=external_xcm_observer_feed, got ${JSON.stringify(indexerOutcomes?.meta?.source)}.`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  subscan: {
    apiHost: stripTrailingSlash(apiHost),
    sampledRows: sampleItems.length,
    summary,
    sample: sampleItems.slice(0, Math.min(sampleItems.length, 5)).map(sanitizeSubscanRow)
  },
  indexer: indexerStatusUrl || indexerOutcomesUrl ? {
    statusUrl: indexerStatusUrl,
    outcomesUrl: indexerOutcomesUrl,
    status: indexerStatus ?? null,
    outcomes: indexerOutcomes ?? null
  } : null
};

if (capturePath) {
  const absoluteCapturePath = path.resolve(capturePath);
  await mkdir(path.dirname(absoluteCapturePath), { recursive: true });
  await writeFile(absoluteCapturePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Saved XCM validation report to ${absoluteCapturePath}`);
}

console.log("Subscan XCM transport validated.");
console.log(`Sampled rows: ${sampleItems.length}`);
console.log(`Candidate field coverage: requestId=${summary.requestIdCandidates}, status=${summary.statusCandidates}, timestamp=${summary.timestampCandidates}`);
if (indexerStatus) {
  console.log(`Indexer source: ${JSON.stringify(indexerStatus.source ?? null)}`);
  console.log(`Indexer publishedCount: ${Number(indexerStatus.publishedCount ?? 0)}`);
}
if (indexerOutcomes) {
  console.log(`Indexer outcomes meta.source: ${JSON.stringify(indexerOutcomes.meta?.source ?? null)}`);
  console.log(`Indexer outcomes items: ${Array.isArray(indexerOutcomes.items) ? indexerOutcomes.items.length : 0}`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === "--capture") {
      parsed.capture = argv[index + 1];
      index += 1;
    } else if (arg === "--indexer-status-url") {
      parsed.indexerStatusUrl = argv[index + 1];
      index += 1;
    } else if (arg === "--indexer-outcomes-url") {
      parsed.indexerOutcomesUrl = argv[index + 1];
      index += 1;
    } else if (arg === "--require-published") {
      parsed.requirePublished = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/validate-subscan-xcm-source.mjs [options]

Required env:
  XCM_SUBSCAN_API_HOST
  XCM_SUBSCAN_API_KEY

Optional env:
  INDEXER_URL
  INDEXER_XCM_STATUS_URL
  INDEXER_XCM_OUTCOMES_URL
  XCM_CAPTURE_PATH
  XCM_SOURCE_LIMIT
  REQUIRE_PUBLISHED

Options:
  --limit <n>
  --capture <path>
  --indexer-status-url <url>
  --indexer-outcomes-url <url>
  --require-published
  --help
`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

async function fetchSubscanBatch({ apiHost, apiKey, limit }) {
  const url = `${stripTrailingSlash(apiHost)}/api/scan/xcm/list`;
  return fetchJson(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      page: 0,
      row: limit,
      order: "asc"
    })
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status} for ${typeof url === "string" ? url : url.toString()}`);
  }
  return response.json();
}

function buildSampleSummary(rows) {
  return rows.reduce((acc, row) => {
    const record = row && typeof row === "object" && !Array.isArray(row) ? row : {};
    if (pickField(record, ["msg_hash", "message_hash", "extrinsic_hash", "hash"])) {
      acc.requestIdCandidates += 1;
    }
    if (pickField(record, ["status", "execution_status", "state"])) {
      acc.statusCandidates += 1;
    }
    if (pickField(record, ["block_timestamp", "timestamp", "time"])) {
      acc.timestampCandidates += 1;
    }
    if (pickField(record, ["remote_ref", "query_id"])) {
      acc.remoteRefCandidates += 1;
    }
    if (pickField(record, ["error_code", "failure_code"])) {
      acc.failureCodeCandidates += 1;
    }
    return acc;
  }, {
    requestIdCandidates: 0,
    statusCandidates: 0,
    timestampCandidates: 0,
    remoteRefCandidates: 0,
    failureCodeCandidates: 0
  });
}

function sanitizeSubscanRow(row) {
  const record = row && typeof row === "object" && !Array.isArray(row) ? row : {};
  return {
    requestIdCandidate: pickField(record, ["msg_hash", "message_hash", "extrinsic_hash", "hash"]) ?? null,
    statusCandidate: pickField(record, ["status", "execution_status", "state"]) ?? null,
    observedAtCandidate: pickField(record, ["block_timestamp", "timestamp", "time"]) ?? null,
    remoteRefCandidate: pickField(record, ["remote_ref", "query_id"]) ?? null,
    failureCodeCandidate: pickField(record, ["error_code", "failure_code"]) ?? null,
    keys: Object.keys(record).sort()
  };
}

function pickField(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function assertIndexerStatus(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Indexer status payload must be an object.");
  }
  if (typeof payload.enabled !== "boolean") {
    throw new Error("Indexer status payload must include boolean `enabled`.");
  }
  if (!payload.source || typeof payload.source !== "object" || Array.isArray(payload.source)) {
    throw new Error("Indexer status payload must include object `source`.");
  }
}

function assertIndexerOutcomes(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Indexer outcomes payload must be an object.");
  }
  if (!Array.isArray(payload.items)) {
    throw new Error("Indexer outcomes payload must include an `items` array.");
  }
  if (!payload.meta || typeof payload.meta !== "object" || Array.isArray(payload.meta)) {
    throw new Error("Indexer outcomes payload must include `meta`.");
  }
}
