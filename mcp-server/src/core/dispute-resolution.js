import { ValidationError } from "./errors.js";

export const ARBITRATOR_SLA_SECONDS = 14 * 24 * 60 * 60;

export const DISPUTE_REASON_CODES = Object.freeze({
  upheld: "DISPUTE_LOST",
  dismissed: "DISPUTE_OVERTURNED",
  split: "DISPUTE_PARTIAL",
  timeout: "ARB_TIMEOUT"
});

export function normalizeDisputeVerdict(value) {
  const verdict = String(value ?? "").trim().toLowerCase();
  if (verdict === "upheld" || verdict === "uphold") return "upheld";
  if (verdict === "dismissed" || verdict === "dismiss" || verdict === "rejected" || verdict === "reject") {
    return "dismissed";
  }
  if (verdict === "split" || verdict === "partial" || verdict === "request-more") return "split";
  if (verdict === "timeout" || verdict === "arb_timeout") return "timeout";
  throw new ValidationError("verdict must be one of upheld, dismissed, split.");
}

export function buildDisputeResolution({ verdict, remainingPayout, workerPayout = undefined } = {}) {
  const normalized = normalizeDisputeVerdict(verdict);
  const remaining = normalizePayout(remainingPayout, "remainingPayout");

  if (normalized === "upheld") {
    return {
      verdict: normalized,
      workerPayout: 0,
      reasonCode: DISPUTE_REASON_CODES.upheld,
      nextSessionStatus: "rejected",
      releaseAction: "slash-to-treasury"
    };
  }

  if (normalized === "dismissed" || normalized === "timeout") {
    return {
      verdict: normalized,
      workerPayout: remaining,
      reasonCode: DISPUTE_REASON_CODES[normalized],
      nextSessionStatus: "resolved",
      releaseAction: "return-to-depositor"
    };
  }

  const explicit = workerPayout === undefined || workerPayout === null || workerPayout === ""
    ? defaultPartialPayout(remaining)
    : normalizePayout(workerPayout, "workerPayout");
  if (explicit <= 0 || explicit > remaining) {
    throw new ValidationError("workerPayout for split verdicts must be greater than zero and no more than the remaining payout.", {
      workerPayout: explicit,
      remainingPayout: remaining
    });
  }

  return {
    verdict: normalized,
    workerPayout: explicit,
    reasonCode: DISPUTE_REASON_CODES.split,
    nextSessionStatus: "resolved",
    releaseAction: "return-to-depositor",
    payoutSource: workerPayout === undefined || workerPayout === null || workerPayout === ""
      ? "default_half_remaining"
      : "operator_supplied"
  };
}

function normalizePayout(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ValidationError(`${label} must be a non-negative number.`);
  }
  return parsed;
}

function defaultPartialPayout(remaining) {
  if (remaining <= 1) {
    return remaining;
  }
  return Math.floor(remaining / 2);
}
