import { buildSettlementExpectation } from "../../core/settlement-expectation.js";
import { schemaRefToJobSchemaPath } from "../../core/job-schema-registry.js";

const DEFAULT_AGENT_LIMIT = 25;
const MAX_AGENT_LIMIT = 100;

const SOURCE_LABELS = new Map([
  ["external", "external"],
  ["github_issue", "github"],
  ["open_data_dataset", "open_data"],
  ["openapi_spec", "openapi"],
  ["osv_advisory", "osv"],
  ["standards_spec", "standards"],
  ["wikipedia_article", "wikipedia"]
]);

const SOURCE_ALIASES = new Map([
  ["external", "external"],
  ["wiki", "wikipedia"],
  ["wikipedia_article", "wikipedia"],
  ["open_data", "open_data"],
  ["open_data_dataset", "open_data"],
  ["data_gov", "open_data"],
  ["datagov", "open_data"],
  ["open_api", "openapi"],
  ["openapi", "openapi"],
  ["openapi_spec", "openapi"],
  ["osv", "osv"],
  ["osv_advisory", "osv"],
  ["standards", "standards"],
  ["standards_spec", "standards"],
  ["github", "github"],
  ["github_issue", "github"]
]);

export function buildPublicJobsResponse(jobs, searchParams) {
  const listedJobs = jobs.map(withListedAt);
  if (!usesAgentFriendlyQuery(searchParams)) {
    return listedJobs;
  }

  const limit = parseLimit(searchParams.get("limit"), DEFAULT_AGENT_LIMIT, MAX_AGENT_LIMIT);
  const offset = parseOffset(searchParams.get("offset"));
  const filters = parseJobFilters(searchParams);
  const filteredJobs = listedJobs.filter((job) => matchesFilters(job, filters));
  const page = filteredJobs.slice(offset, offset + limit);
  const since = parseSince(searchParams.get("since"));

  return {
    jobs: page.map(toCompactJobRow),
    count: page.length,
    total: filteredJobs.length,
    limit,
    offset,
    nextOffset: offset + limit < filteredJobs.length ? offset + limit : null,
    filters,
    meta: {
      newSince: since === undefined
        ? 0
        : filteredJobs.filter((job) => isListedAfter(job.listedAt, since)).length
    },
    compact: true
  };
}

function withListedAt(job) {
  return {
    ...job,
    listedAt: job.listedAt ?? job.lifecycle?.createdAt ?? job.createdAt ?? job.firedAt ?? null
  };
}

function parseSince(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (/^[0-9]+$/u.test(raw)) {
    const epochMs = Number(raw);
    return Number.isSafeInteger(epochMs) ? epochMs : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(raw)) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isListedAfter(listedAt, since) {
  const parsed = Date.parse(String(listedAt ?? ""));
  return Number.isFinite(parsed) && parsed > since;
}

function usesAgentFriendlyQuery(searchParams) {
  if (!searchParams || [...searchParams.keys()].length === 0) {
    return false;
  }
  return normalizeToken(searchParams.get("format") ?? searchParams.get("shape")) !== "full";
}

function parseJobFilters(searchParams) {
  return {
    source: normalizeSourceFilter(searchParams.get("source")),
    category: normalizeToken(searchParams.get("category")),
    state: normalizeToken(searchParams.get("state"))
  };
}

function matchesFilters(job, filters) {
  if (filters.source && !sourceCandidates(job).has(filters.source)) {
    return false;
  }
  if (filters.category && normalizeToken(job.category) !== filters.category) {
    return false;
  }
  if (filters.state) {
    const { state, status, effectiveState } = effectiveJobState(job);
    const wantsClaimable = ["open", "available", "claimable"].includes(filters.state);
    if (wantsClaimable && effectiveState === "claimable") {
      return true;
    }
    if (filters.state !== state && filters.state !== status && filters.state !== effectiveState) {
      return false;
    }
  }
  return true;
}

function toCompactJobRow(job) {
  const lifecycle = job.lifecycle ?? {};
  const { state } = effectiveJobState(job);
  const claimable = job.claimable ?? state === "open";
  const sourceDetails = compactSourceDetails(job);
  const settlement = buildSettlementExpectation(job.verifierMode);
  return {
    id: job.id,
    title: job.title,
    state,
    claimState: job.claimState ?? state,
    effectiveState: job.effectiveState ?? (claimable ? "claimable" : job.claimState ?? state),
    claimable,
    currentWalletCanClaim: job.currentWalletCanClaim ?? null,
    fundingState: job.fundingState ?? null,
    reason: job.reason ?? null,
    claimedBy: job.claimedBy ?? null,
    claimedAt: job.claimedAt ?? null,
    claimExpiresAt: job.claimExpiresAt ?? null,
    retryLimit: job.retryLimit ?? null,
    claimAttemptCount: job.claimAttemptCount ?? null,
    remainingClaimAttempts: job.remainingClaimAttempts ?? null,
    claimNumber: job.claimNumber ?? null,
    sessionId: job.sessionId ?? null,
    source: publicSourceLabel(job),
    sourceType: job.source?.type ?? null,
    category: job.category ?? null,
    jobType: job.jobType ?? null,
    tier: job.tier ?? null,
    verifierMode: job.verifierMode ?? null,
    claimTtlSeconds: job.claimTtlSeconds ?? null,
    listedAt: job.listedAt ?? null,
    ...(job.priorityWindow ? { priorityWindow: job.priorityWindow } : {}),
    requiresSponsoredGas: job.requiresSponsoredGas === true,
    onboardingWaiverEligible: job.onboardingWaiverEligible === true,
    disposableProof: job.disposableProof === true,
    stake: job.claimStake ?? job.stake ?? null,
    reward: {
      asset: job.rewardAsset ?? null,
      amount: job.rewardAmount ?? null
    },
    listedAt: job.listedAt,
    // Beside the reward on purpose: an agent comparing two jobs is already looking
    // here, and how fast it gets paid is the other half of the price.
    ...(settlement ? { settlement } : {}),
    createdAt: lifecycle.createdAt ?? null,
    summary: summarizeJob(job),
    successCriteria: summarizeSuccessCriteria(job),
    definitionUrl: `/jobs/definition?jobId=${encodeURIComponent(job.id)}`,
    ...(job.listingStatus ? { listingStatus: job.listingStatus } : {}),
    ...(job.verificationDepth ? { verificationDepth: job.verificationDepth } : {}),
    ...(job.contentTrust ? { contentTrust: job.contentTrust } : {}),
    ...(job.provenance ? { provenance: job.provenance } : {}),
    ...(job?.source?.type === "external" && job.source.poster
      ? { poster: job.source.poster }
      : {}),
    ...((job?.source === "external" || job?.source?.type === "external") && job.claimBond
      ? { claimBond: job.claimBond }
      : {}),
    ...(sourceDetails ? { sourceDetails } : {})
  };
}

function effectiveJobState(job) {
  const lifecycle = job.lifecycle ?? {};
  const state = normalizeToken(job.claimState ?? job.state ?? lifecycle.state ?? lifecycle.status ?? "open");
  const status = normalizeToken(job.claimStatus?.claimState ?? job.state ?? state);
  const effectiveState = normalizeToken(job.effectiveState ?? (job.claimable ? "claimable" : state));
  return { state, status, effectiveState };
}

function compactSourceDetails(job) {
  if (job?.source?.type === "external") {
    const poster = job.source.poster ?? job.poster;
    return poster
      ? {
          wallet: poster.wallet ?? null,
          fundedAt: poster.fundedAt ?? null,
          txHash: poster.txHash ?? null,
          blockNumber: poster.blockNumber ?? null
        }
      : undefined;
  }
  if (job?.source?.type !== "wikipedia_article") {
    return undefined;
  }
  const source = job.source;
  return {
    taskType: source.taskType ?? null,
    pageTitle: source.pageTitle ?? null,
    lang: source.lang ?? source.language ?? null,
    revisionId: source.revisionId ?? null,
    articleUrl: source.articleUrl ?? source.pageUrl ?? null,
    pinnedRevisionUrl: source.pinnedRevisionUrl ?? buildWikipediaPinnedRevisionUrl(source),
    proposalOnly: source.proposalOnly ?? source.attribution?.directEdit === false,
    attributionPolicy: source.attributionPolicy ?? null,
    outputSchemaUrl: source.outputSchemaUrl ?? schemaRefToJobSchemaPath(job.outputSchemaRef) ?? null
  };
}

function buildWikipediaPinnedRevisionUrl(source) {
  const lang = String(source?.lang ?? source?.language ?? "en").trim() || "en";
  const title = String(source?.pageTitle ?? "").trim();
  const revisionId = String(source?.revisionId ?? "").trim();
  const url = new URL(`https://${lang}.wikipedia.org/w/index.php`);
  if (title) {
    url.searchParams.set("title", title.replace(/\s+/gu, "_"));
  }
  if (revisionId) {
    url.searchParams.set("oldid", revisionId);
  }
  return String(url);
}

function summarizeJob(job) {
  const description = String(job.description ?? "").replace(/\s+/gu, " ").trim();
  if (!description) {
    return "";
  }
  return description.length > 180 ? `${description.slice(0, 177)}...` : description;
}

function summarizeSuccessCriteria(job) {
  const criterion = Array.isArray(job.acceptanceCriteria)
    ? job.acceptanceCriteria.find((value) => String(value ?? "").trim())
    : undefined;
  const text = String(criterion ?? "").replace(/\s+/gu, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function sourceCandidates(job) {
  const source = job.source ?? {};
  return new Set([
    publicSourceLabel(job),
    normalizeSourceFilter(source.type),
    normalizeSourceFilter(source.provider),
    normalizeSourceFilter(source.project)
  ].filter(Boolean));
}

function publicSourceLabel(job) {
  const rawType = normalizeToken(job.source?.type);
  if (SOURCE_LABELS.has(rawType)) {
    return SOURCE_LABELS.get(rawType);
  }
  return normalizeSourceFilter(job.source?.provider)
    ?? normalizeSourceFilter(job.source?.project)
    ?? rawType
    ?? normalizeToken(job.category)
    ?? "unknown";
}

function normalizeSourceFilter(value) {
  const token = normalizeToken(value);
  return token ? SOURCE_ALIASES.get(token) ?? token : undefined;
}

function normalizeToken(value) {
  const token = String(value ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_");
  return token || undefined;
}

function parseLimit(value, fallback, max) {
  const raw = Number(value ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(raw), max);
}

function parseOffset(value) {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw) || raw < 0) {
    return 0;
  }
  return Math.trunc(raw);
}
