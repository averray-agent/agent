import { getAddress, isAddress } from "ethers";

import { ConflictError, ValidationError } from "./errors.js";

export const DESIGNATED_CLAIMANTS_ONLY_REASON = "designated_claimants_only";
export const DESIGNATED_AGREEMENT_CONCURRENT_CAP_REASON =
  "designated_agreement_concurrent_cap_reached";
export const DESIGNATED_AGREEMENT_REWARD_CAP_REASON =
  "designated_agreement_reward_cap_exceeded";
export const DESIGNATED_AGREEMENT_CAP_UNAVAILABLE_REASON =
  "designated_agreement_cap_unavailable";
export const DESIGNATED_AGREEMENT_CAP_CHECK_IN_PROGRESS_REASON =
  "designated_agreement_cap_check_in_progress";
export const DESIGNATED_AGREEMENT_MAX_CONCURRENT = 5;
export const DESIGNATED_AGREEMENT_MAX_REWARD_USDC = 25;

const ACTIVE_DESIGNATED_DRAFT_STATUSES = new Set(["live", "settlement_pending"]);
// A rejected or timed-out claim still leaves poster escrow committed. Capacity
// returns only once local state proves that the agreement itself is closed.
const TERMINAL_DESIGNATED_SESSION_STATUSES = new Set([
  "resolved",
  "closed",
  "settled"
]);

export function normalizeDesignatedClaimants(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 1) {
    throw designatedValidationError(
      "designatedClaimants must contain exactly one address for the pilot.",
      "designated_claimants_cardinality_invalid",
      { expectedCount: 1, actualCount: Array.isArray(value) ? value.length : null }
    );
  }
  const address = value[0];
  if (typeof address !== "string" || !isAddress(address)) {
    throw designatedValidationError(
      "designatedClaimants[0] must be a valid EVM address.",
      "designated_claimant_address_invalid"
    );
  }
  const checksummed = getAddress(address);
  if (address !== checksummed) {
    throw designatedValidationError(
      "designatedClaimants[0] must use its exact EIP-55 checksummed form.",
      "designated_claimant_checksum_required",
      { expectedAddress: checksummed }
    );
  }
  return Object.freeze([checksummed]);
}

export function isDesignatedJob(job) {
  return Array.isArray(job?.designatedClaimants) && job.designatedClaimants.length > 0;
}

export function evaluateDesignatedClaimant(job, wallet) {
  if (!isDesignatedJob(job)) {
    return Object.freeze({ applies: false, eligible: true });
  }
  const designatedWallet = String(job.designatedClaimants[0]);
  const currentWallet = typeof wallet === "string" && isAddress(wallet)
    ? getAddress(wallet)
    : undefined;
  const eligible = Boolean(
    currentWallet && currentWallet.toLowerCase() === designatedWallet.toLowerCase()
  );
  return Object.freeze({
    applies: true,
    eligible,
    reason: eligible ? undefined : DESIGNATED_CLAIMANTS_ONLY_REASON,
    designatedWallet
  });
}

export function requireDesignatedClaimant(job, wallet) {
  const decision = evaluateDesignatedClaimant(job, wallet);
  if (!decision.applies || decision.eligible) return decision;
  throw new ConflictError(
    "This agreement can only be claimed by its designated provider.",
    DESIGNATED_CLAIMANTS_ONLY_REASON,
    { jobId: job?.id, wallet }
  );
}

export function restrictDesignatedJobForPublic(job) {
  if (!isDesignatedJob(job)) return job;
  const claimStatus = job?.claimStatus
    ? {
        ...job.claimStatus,
        claimState: "restricted",
        state: "restricted",
        effectiveState: "restricted",
        claimable: false,
        currentWalletCanClaim: null,
        reason: DESIGNATED_CLAIMANTS_ONLY_REASON
      }
    : undefined;
  const restricted = {
    ...job,
    state: "restricted",
    claimState: "restricted",
    effectiveState: "restricted",
    claimable: false,
    currentWalletCanClaim: null,
    reason: DESIGNATED_CLAIMANTS_ONLY_REASON,
    ...(claimStatus ? { claimStatus } : {})
  };
  delete restricted.designatedClaimants;
  return restricted;
}

export async function countConcurrentDesignatedAgreements(stateStore, {
  excludeJobId = undefined
} = {}) {
  if (
    typeof stateStore?.listExternalJobDrafts !== "function"
    || typeof stateStore?.findSessionByJobId !== "function"
  ) {
    throw new ConflictError(
      "Designated-agreement capacity cannot be proven from the state store.",
      DESIGNATED_AGREEMENT_CAP_UNAVAILABLE_REASON,
      { currentCount: null, limit: DESIGNATED_AGREEMENT_MAX_CONCURRENT }
    );
  }
  let drafts;
  try {
    drafts = await stateStore.listExternalJobDrafts({ limit: 10_000 });
  } catch (error) {
    throw designatedCapacityUnavailable(error);
  }
  if (!Array.isArray(drafts)) {
    throw designatedCapacityUnavailable({ code: "state_store_invalid_response" });
  }
  let currentCount = 0;
  for (const draft of drafts) {
    if (!isDesignatedJob(draft?.definition)) continue;
    if (!ACTIVE_DESIGNATED_DRAFT_STATUSES.has(String(draft?.status ?? ""))) continue;
    if (excludeJobId && String(draft?.jobId).toLowerCase() === String(excludeJobId).toLowerCase()) {
      continue;
    }
    let session;
    try {
      session = await stateStore.findSessionByJobId(draft.jobId);
    } catch (error) {
      throw designatedCapacityUnavailable(error);
    }
    if (
      session
      && TERMINAL_DESIGNATED_SESSION_STATUSES.has(String(session.status ?? "").toLowerCase())
    ) continue;
    currentCount += 1;
  }
  return currentCount;
}

function designatedValidationError(message, code, details = undefined) {
  const error = new ValidationError(message, details);
  error.code = code;
  return error;
}

function designatedCapacityUnavailable(error) {
  return new ConflictError(
    "Designated-agreement capacity cannot be proven from the state store.",
    DESIGNATED_AGREEMENT_CAP_UNAVAILABLE_REASON,
    {
      currentCount: null,
      limit: DESIGNATED_AGREEMENT_MAX_CONCURRENT,
      sourceCode: error?.code ?? "state_store_read_failed"
    }
  );
}
