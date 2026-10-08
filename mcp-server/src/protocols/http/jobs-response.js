import { createHash } from "node:crypto";
import { ValidationError } from "../../core/errors.js";
import { buildSettlementExpectation } from "../../core/settlement-expectation.js";
import { schemaRefToJobSchemaPath } from "../../core/job-schema-registry.js";
import {
  countRealWaiverEligibleClaimableJobs,
  isRealWaiverEligibleJob
} from "../../core/onboarding-inventory.js";

const DEFAULT_AGENT_LIMIT = 50;
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
  return buildPublicJobsPage(jobs, searchParams).body;
}

export function buildPublicJobsPage(jobs, searchParams = new URLSearchParams()) {
  const listedJobs = jobs.map(withListedAt);
  // Preserve the complete legacy array for existing app and ops consumers.
  if ([...searchParams.keys()].length === 0) {
    return { body: listedJobs, nextCursor: null, limit: listedJobs.length };
  }
  const limit = parseLimit(searchParams.get("limit"), DEFAULT_AGENT_LIMIT, MAX_AGENT_LIMIT);
  const filters = parseJobFilters(searchParams);
  const included = [...new Set(String(searchParams.get("include") ?? "").split(",").map(normalizeToken).filter(Boolean))].sort();
  const allowed = new Set(["submitted", "exhausted", "claimed", "disputed", "expired", "closed", "cancelled", "unclaimable", "restricted", "paused", "stale"]);
  if (included.some((state) => !allowed.has(state))) throw new ValidationError("Unknown jobs include state.");
  const context = createHash("sha256").update(JSON.stringify({ filters, included, wallet: searchParams.get("wallet") })).digest("hex");
  const filteredJobs = listedJobs.filter((job) => {
    const { state } = effectiveJobState(job);
    if (included.includes(state) && (!filters.state || filters.state === "claimable")) {
      return matchesFilters(job, { ...filters, state: undefined });
    }
    if (!matchesFilters(job, filters)) return false;
    if (filters.state || !included.length) return true;
    return state === "open" && job.claimable === true;
  }).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  let offset = parseOffset(searchParams.get("offset"));
  if (searchParams.has("cursor")) {
    try {
      const cursor = JSON.parse(Buffer.from(searchParams.get("cursor"), "base64url").toString("utf8"));
      if (searchParams.has("offset") || cursor.v !== 1 || typeof cursor.after !== "string" || cursor.context !== context) throw new Error();
      offset = filteredJobs.findIndex((job) => String(job.id) > cursor.after);
      if (offset < 0) offset = filteredJobs.length;
    } catch {
      throw new ValidationError("Invalid jobs cursor for these filters.");
    }
  }
  const page = filteredJobs.slice(offset, offset + limit);
  const nextCursor = offset + page.length < filteredJobs.length
    ? Buffer.from(JSON.stringify({ v: 1, after: String(page.at(-1).id), context })).toString("base64url")
    : null;
  const since = parseSince(searchParams.get("since"));

  const body = !usesAgentFriendlyQuery(searchParams) ? page : {
    jobs: page.map(toCompactJobRow),
    count: page.length,
    total: filteredJobs.length,
    limit,
    offset,
    nextOffset: offset + limit < filteredJobs.length ? offset + limit : null,
    nextCursor,
    filters,
    inventory: {
      claimableJobs: listedJobs.filter((job) => job.claimable === true).length,
      waiverEligibleJobs: listedJobs.filter(isRealWaiverEligibleJob).length,
      waiverEligibleClaimableJobs: countRealWaiverEligibleClaimableJobs(listedJobs),
      definition: "starter + real ingestion source + onboardingWaiverEligible=true + claimable=true"
    },
    meta: {
      newSince: since === undefined
        ? 0
        : filteredJobs.filter((job) => isListedAfter(job.listedAt, since)).length
    },
    compact: true
  };
  return { body, nextCursor, limit };
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
    if (filters.state === "claimable") return ["open", "expired"].includes(state) && effectiveState === "claimable" && job.claimable === true;
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
  const claimable = job.claimable === true;
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
    fundingState: job.fundingState ?? "not_checked",
    reason: job.reason ?? null,
    ...(job.escrowGeneration ? { escrowGeneration: job.escrowGeneration } : {}),
    ...(job.legacyPostingUnclaimable === true ? { legacyPostingUnclaimable: true } : {}),
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
    ...(job.assetContext ? { assetContext: job.assetContext } : {}),
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
  const state = normalizeToken(job.claimStatus?.claimState ?? job.claimState ?? job.state ?? lifecycle.state ?? lifecycle.status);
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
  return compactMarkdown(job.description);
}

function summarizeSuccessCriteria(job) {
  const criterion = Array.isArray(job.acceptanceCriteria)
    ? job.acceptanceCriteria.find((value) => String(value ?? "").trim())
    : undefined;
  return compactMarkdown(criterion);
}

// Transport budget, not a Markdown renderer. Only retain complete blocks;
// a first block larger than the budget leaves the app's fallback copy in place.
function compactMarkdown(value) {
  const markdown = String(value ?? "").trim();
  const limit = 1_000;
  if (markdown.length <= limit) return markdown;
  let fence = null, offset = 0, boundary = 0;
  for (const line of markdown.split("\n")) {
    if (offset + line.length > limit) break;
    const marker = line.match(/^\s*(?:>\s*)*(?:[-+*]\s+|\d+[.)]\s+)?(`{3,}|~{3,})(.*)$/u);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (!fence && !line.trim()) boundary = offset;
    offset += line.length + 1;
  }
  return markdown.slice(0, boundary).trimEnd();
}

function sourceCandidates(job) {
  const source = job.source ?? {};
  return new Set([
    normalizeToken(job.provenance?.postingRoute),
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
  return Math.max(1, Math.min(Math.trunc(raw), max));
}

function parseOffset(value) {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw) || raw < 0) {
    return 0;
  }
  return Math.trunc(raw);
}
