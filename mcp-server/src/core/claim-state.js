import { normalizeAssetSymbol } from "./assets.js";
import { decimalToBaseUnits } from "./platform-service-helpers.js";

const TERMINAL_SESSION_STATUSES = new Set(["resolved", "rejected", "closed", "expired", "timed_out"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BANK_INDEPENDENT_FUNDING_SOURCES = new Set([
  "ingestion_prefund",
  "recurring_template_reserve"
]);

export function claimExpiresAt(session, job) {
  if (session?.chainClaimExpiresAt) {
    const chainExpiresAtMs = Date.parse(session.chainClaimExpiresAt);
    if (Number.isFinite(chainExpiresAtMs)) {
      return new Date(chainExpiresAtMs).toISOString();
    }
  }
  if (!session?.claimedAt) return undefined;
  const claimedAtMs = Date.parse(session.claimedAt);
  const ttlSeconds = Number(job?.claimTtlSeconds ?? 0);
  if (!Number.isFinite(claimedAtMs) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return undefined;
  }
  return new Date(claimedAtMs + ttlSeconds * 1000).toISOString();
}

export function isExpiredClaim(session, job, now = new Date()) {
  if (session?.status !== "claimed") return false;
  const expiresAt = claimExpiresAt(session, job);
  // EscrowCore allows submitWork at exactly claimExpiry and only reopens via
  // handleClaimTimeout once block.timestamp is greater than claimExpiry.
  return Boolean(expiresAt && Date.parse(expiresAt) < now.getTime());
}

export function isTerminalSession(session) {
  return TERMINAL_SESSION_STATUSES.has(session?.status);
}

export function summarizeJobClaimState({
  job,
  session = undefined,
  sessions = undefined,
  wallet = undefined,
  rewardBank = undefined,
  now = new Date()
} = {}) {
  const lifecycle = job?.lifecycle ?? {};
  const lifecycleState = lifecycle.state ?? lifecycle.status ?? "open";
  const retryLimit = Number.isInteger(job?.retryLimit) ? job.retryLimit : 1;
  const claimAttemptCount = countClaimAttempts(sessions, session);
  const retryExhausted = retryLimit > 0 && claimAttemptCount >= retryLimit;
  const remainingClaimAttempts = retryLimit > 0
    ? Math.max(0, retryLimit - claimAttemptCount)
    : null;
  const normalizedWallet = normalizeWallet(wallet);
  const claimedBy = normalizeWallet(session?.wallet) ?? normalizeWallet(job?.claimedBy);
  const walletMatchesClaim = Boolean(normalizedWallet && claimedBy && normalizedWallet === claimedBy);
  const claimExpiresAtValue = claimExpiresAt(session, job);
  const expired = isExpiredClaim(session, job, now) || session?.status === "expired";
  // Preserve the explicit ingestion-prefund truth boundary. Lazy-funded jobs
  // have no funding metadata and are checked against the shared reward-bank
  // evidence below; recurring-reserve jobs use their dedicated reserve.
  const fundingState = job?.funding?.source === "ingestion_prefund"
    ? job.funding.state
    : undefined;
  const prefundingPending = fundingState !== undefined && fundingState !== "funded";
  const lazyFundingState = resolveLazyRewardFundingState(job, rewardBank);
  const lazyFundingPending = lazyFundingState === "pending";
  const lazyFundingUnverified = lazyFundingState === "unverified";
  const effectiveFundingState = fundingState
    ?? (lazyFundingPending ? "pending" : lazyFundingUnverified ? "unverified" : undefined);
  const fundingBlocked = prefundingPending || lazyFundingPending || lazyFundingUnverified;
  const fundingReason = prefundingPending || lazyFundingPending
    ? "reward_funding_pending"
    : lazyFundingUnverified
      ? "reward_funding_unverified"
      : undefined;

  if (!session) {
    const claimable = lifecycleState === "open" && !retryExhausted && !fundingBlocked;
    const claimState = retryExhausted ? "exhausted" : claimable ? "open" : lifecycleState;
    return compact({
      claimState,
      state: claimState,
      effectiveState: claimable ? "claimable" : claimState,
      claimable,
      currentWalletCanClaim: normalizedWallet ? claimable : null,
      fundingState: effectiveFundingState,
      reason: retryExhausted
        ? "retry_limit_exhausted"
        : fundingReason ?? (claimable ? "claimable" : `job_${lifecycleState}`),
      retryLimit,
      claimAttemptCount,
      remainingClaimAttempts,
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      claimNumber: null,
      sessionId: null
    });
  }

  if (expired) {
    const claimable = lifecycleState === "open" && !retryExhausted && !fundingBlocked;
    const claimState = retryExhausted ? "exhausted" : "expired";
    return compact({
      claimState,
      state: claimState,
      effectiveState: claimable ? "claimable" : claimState,
      claimable,
      currentWalletCanClaim: normalizedWallet ? claimable : null,
      fundingState: effectiveFundingState,
      reason: retryExhausted
        ? "retry_limit_exhausted"
        : fundingReason ?? "claim_ttl_expired_reopen_available",
      retryLimit,
      claimAttemptCount,
      remainingClaimAttempts,
      claimedBy,
      claimedAt: session.claimedAt ?? null,
      claimExpiresAt: claimExpiresAtValue ?? session.expiredAt ?? null,
      claimNumber: session.claimNumber ?? 1,
      sessionId: session.sessionId ?? null,
      expiredAt: session.expiredAt ?? claimExpiresAtValue ?? null
    });
  }

  if (session.status === "claimed") {
    return compact({
      claimState: "claimed",
      state: "claimed",
      effectiveState: "claimed",
      claimable: false,
      currentWalletCanClaim: normalizedWallet ? false : null,
      fundingState,
      reason: walletMatchesClaim ? "already_claimed_by_current_wallet" : "claimed_by_other_wallet",
      retryLimit,
      claimAttemptCount,
      remainingClaimAttempts,
      claimedBy,
      claimedAt: session.claimedAt ?? null,
      claimExpiresAt: claimExpiresAtValue ?? null,
      claimNumber: session.claimNumber ?? 1,
      sessionId: session.sessionId ?? null
    });
  }

  const claimState = submittedLikeState(session.status);
  return compact({
    claimState,
    state: claimState,
    effectiveState: claimState,
    claimable: false,
    currentWalletCanClaim: normalizedWallet ? false : null,
    fundingState,
    reason: claimState === "exhausted" ? "job_session_completed" : `session_${claimState}`,
    retryLimit,
    claimAttemptCount,
    remainingClaimAttempts,
    claimedBy,
    claimedAt: session.claimedAt ?? null,
    claimExpiresAt: claimExpiresAtValue ?? null,
    claimNumber: session.claimNumber ?? null,
    sessionId: session.sessionId ?? null
  });
}

function resolveLazyRewardFundingState(job, rewardBank) {
  const fundingSource = job?.funding?.source;
  if (BANK_INDEPENDENT_FUNDING_SOURCES.has(fundingSource) || rewardBank === undefined) {
    return undefined;
  }
  if (
    rewardBank?.readable !== true
    || rewardBank?.stale === true
    || typeof rewardBank?.asset !== "string"
    || !rewardBank.asset.trim()
    || !Number.isInteger(Number(rewardBank?.decimals))
  ) {
    return "unverified";
  }

  const rewardAsset = normalizeAssetSymbol(job?.rewardAsset);
  const bankAsset = normalizeAssetSymbol(rewardBank?.asset);
  if (rewardAsset !== bankAsset) {
    return "unverified";
  }

  try {
    const decimals = Number(rewardBank.decimals);
    const requiredRaw = [
      ["rewardAmount", job?.rewardAmount ?? 0],
      ["opsReserve", job?.opsReserve ?? 0],
      ["contingencyReserve", job?.contingencyReserve ?? 0]
    ].reduce(
      (total, [label, amount]) => total + decimalToBaseUnits(amount, decimals, label),
      0n
    );
    const liquidRaw = /^\d+$/u.test(String(rewardBank?.liquidRaw ?? "").trim())
      ? BigInt(String(rewardBank.liquidRaw).trim())
      : decimalToBaseUnits(rewardBank?.liquid, decimals, "reward bank liquid");
    return liquidRaw >= requiredRaw ? "available" : "pending";
  } catch {
    return "unverified";
  }
}

export function claimStatusFields(claimStatus) {
  return {
    claimStatus: {
      ...claimStatus,
      state: claimStatus.state ?? claimStatus.claimState,
      claimabilitySource: "claimStatus",
      lifecycleStatusMeaning: "content/job lifecycle; check claimStatus.claimable and claimStatus.reason before claiming"
    },
    claimState: claimStatus.claimState,
    effectiveState: claimStatus.effectiveState ?? claimStatus.claimState,
    claimable: claimStatus.claimable,
    currentWalletCanClaim: claimStatus.currentWalletCanClaim,
    fundingState: claimStatus.fundingState ?? null,
    reason: claimStatus.reason,
    retryLimit: claimStatus.retryLimit,
    claimAttemptCount: claimStatus.claimAttemptCount ?? null,
    remainingClaimAttempts: claimStatus.remainingClaimAttempts ?? null,
    claimNumber: claimStatus.claimNumber ?? null,
    claimedBy: claimStatus.claimedBy ?? null,
    claimedAt: claimStatus.claimedAt ?? null,
    claimExpiresAt: claimStatus.claimExpiresAt ?? null,
    sessionId: claimStatus.sessionId ?? null,
    state: claimStatus.state ?? claimStatus.claimState,
    claimabilitySource: "claimStatus",
    lifecycleStatusMeaning: "content/job lifecycle; check claimStatus.claimable and claimStatus.reason before claiming"
  };
}

export function countClaimAttempts(sessions = undefined, session = undefined) {
  const candidates = Array.isArray(sessions)
    ? sessions
    : session
      ? [session]
      : [];
  const seen = new Set();
  let count = 0;
  for (const candidate of candidates) {
    if (!candidate?.sessionId || seen.has(candidate.sessionId)) continue;
    seen.add(candidate.sessionId);
    // A claim whose on-chain submit failed (infra revert / RPC outage) and that
    // never reached a real submission must NOT burn the job's retry budget WHILE
    // the claim is still live — the worker can re-submit on the same claim, so it
    // gets a fair shot. submittedAt is the ground-truth that a real submission
    // landed (set only on the → submitted transition). But once the claim reaches
    // a TERMINAL state (it expired / timed out without a successful re-submit), it
    // must count — otherwise a job whose submit always reverts could be claimed
    // forever and never reach retry_limit_exhausted (anti-grief). Genuine no-shows
    // and rejections still count regardless.
    if (
      candidate.submitFailedAt &&
      !candidate.submittedAt &&
      !TERMINAL_SESSION_STATUSES.has(candidate.status)
    ) {
      continue;
    }
    if (candidate.claimedAt || candidate.status) {
      count += 1;
    }
  }
  return count;
}

function submittedLikeState(status) {
  if (status === "submitted" || status === "disputed" || status === "rejected") {
    return "submitted";
  }
  if (TERMINAL_SESSION_STATUSES.has(status)) {
    return "exhausted";
  }
  return status ?? "open";
}

function normalizeWallet(wallet) {
  if (typeof wallet !== "string" || !wallet.trim()) return undefined;
  const trimmed = wallet.trim();
  if (trimmed === ZERO_ADDRESS) return undefined;
  return trimmed.toLowerCase();
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}
