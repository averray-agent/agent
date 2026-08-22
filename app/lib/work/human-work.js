const OPERATOR_ROLES = new Set(["admin", "verifier"]);
const TERMINAL_SESSION_STATUSES = new Set([
  "resolved",
  "rejected",
  "closed",
  "expired",
  "timed_out",
  "chain_state_diverged"
]);
export const WORK_LAST_VISIT_STORAGE_KEY = "averray.work.lastVisitAt:v1";

export function extractJobRows(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

export function isHumanWorkListing(job) {
  const id = String(job?.id ?? "").trim().toLowerCase();
  const verifierMode = String(job?.verifierMode ?? "").trim().toLowerCase();
  if (!id) return false;
  if (id.startsWith("worker-canary-")) return false;
  if (verifierMode === "witness") return false;
  if (job?.disposableProof === true) return false;
  return true;
}

export function filterHumanWorkListings(payload) {
  return extractJobRows(payload).filter(isHumanWorkListing);
}

export function parseWorkLastVisit(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = /^[0-9]+$/u.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function isJobNewSince(job, since) {
  if (!Number.isSafeInteger(since) || since < 0) return false;
  const listedAt = Date.parse(String(job?.listedAt ?? ""));
  return Number.isFinite(listedAt) && listedAt > since;
}

export function workCatalogueIsPending(request) {
  return request?.isLoading === true
    && request?.data === undefined
    && !request?.error;
}

export function routeAfterSignIn(roles, requestedNext) {
  const operator = Array.isArray(roles)
    && roles.some((role) => OPERATOR_ROLES.has(String(role).toLowerCase()));
  if (!operator) return "/work";
  return safeInternalPath(requestedNext) ?? "/overview";
}

export function workJobHref(jobId) {
  return `/work/${encodeURIComponent(String(jobId ?? "").trim())}`;
}

export function jobDefinitionRawUrl(jobId) {
  const normalized = String(jobId ?? "").trim();
  return normalized
    ? `https://api.averray.com/jobs/${encodeURIComponent(normalized)}`
    : null;
}

export function serializeJobDefinition(definition) {
  return JSON.stringify(definition, null, 2);
}

export function workSessionHref(sessionId) {
  return `/work/session/${encodeURIComponent(String(sessionId ?? "").trim())}`;
}

export function workJobIdFromPath(pathname) {
  const match = String(pathname ?? "").match(/^\/work\/([^/]+)\/?$/u);
  return decodePathPart(match?.[1]);
}

export function workSessionIdFromPath(pathname) {
  const match = String(pathname ?? "").match(/^\/work\/session\/([^/]+)\/?$/u);
  return decodePathPart(match?.[1]);
}

export function isTerminalSessionStatus(status) {
  return TERMINAL_SESSION_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

export function buildClaimTerms({ listing, definition, preflight, eligibility, netReward }) {
  const rewardAmount = firstFinite(definition?.rewardAmount, listing?.reward?.amount, listing?.rewardAmount);
  const rewardAsset = firstString(definition?.rewardAsset, listing?.reward?.asset, listing?.rewardAsset, "asset") ?? "asset";
  const exactNet = firstFinite(netReward, preflight?.netReward);
  const stake = firstFinite(preflight?.totalClaimLock, preflight?.claimStake, listing?.stake, 0);
  const ttlSeconds = firstFinite(definition?.claimTtlSeconds, listing?.claimTtlSeconds);
  const waiverEligible = listing?.onboardingWaiverEligible === true
    || definition?.onboardingWaiverEligible === true;
  const waiverApplied = preflight?.claimEconomicsWaived === true;
  const gasBrokered = preflight?.gasRetentionSupported === true
    || listing?.requiresSponsoredGas === true
    || definition?.requiresSponsoredGas === true;
  const refusalReason = firstString(
    preflight?.eligible === false ? preflight?.reasonMessage : undefined,
    preflight?.eligible === false ? preflight?.reason : undefined,
    eligibility?.eligible === false ? eligibility?.reasonMessage : undefined,
    eligibility?.eligible === false ? eligibility?.reason : undefined,
    listing?.claimable === false ? listing?.reason : undefined,
    definition?.claimable === false ? definition?.reason : undefined
  );

  return {
    rewardAmount,
    rewardAsset,
    netReward: exactNet,
    stake,
    ttlSeconds,
    waiverEligible,
    waiverApplied,
    gasBrokered,
    eligible: preflight ? preflight.eligible === true && !refusalReason : !refusalReason,
    refusalReason: refusalReason ?? null
  };
}

export function verificationDepthStatement(definition) {
  const declared = firstString(
    definition?.verification?.checkDepthStatement,
    definition?.verification?.depthStatement,
    definition?.verificationContract?.checkDepthStatement,
    definition?.verificationContract?.depthStatement
  );
  if (declared) return declared;
  const mode = firstString(definition?.verifierMode, definition?.verificationContract?.verifierMode);
  if (mode === "benchmark") {
    return "Benchmark verification checks the submission for the configured required terms; it does not independently re-derive the work.";
  }
  if (mode === "deterministic") {
    return "Deterministic verification compares the submission with the configured expected output.";
  }
  if (mode === "github_pr") {
    return "GitHub PR verification checks live pull-request evidence when available; unreadable or ambiguous evidence escalates to human review.";
  }
  if (mode === "human_fallback") {
    return "A human reviewer decides this submission; verification is not automatic.";
  }
  return "The verifier will report what it checked with the terminal receipt.";
}

export function publicReceiptUrl(receiptId) {
  const value = String(receiptId ?? "").trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/u.test(value)
    ? `https://averray.com/receipts/${value}`
    : null;
}

function safeInternalPath(value) {
  if (typeof value !== "string") return null;
  const path = value.trim();
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

function decodePathPart(value) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}
