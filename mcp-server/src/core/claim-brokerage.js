import { AuthorizationError } from "./errors.js";
import { isExternalJob } from "./external-job-lifecycle.js";

/**
 * Who pays the gas for an on-chain claim.
 *
 * Today the operator pays for every claim, unconditionally: job-execution-service
 * calls gateway.claimJob(jobId, wallet), and the gateway brokers whenever the
 * wallet differs from the signer. There is no per-job condition anywhere, so
 * "brokered" is not a property a job HAS — it is simply what always happens.
 *
 * That is fine while we author the entire catalogue: we fund the rewards, so
 * funding the gas too is just another line in the same bill. It stops being fine
 * the moment outsiders can post work, because then a poster's volume spends our
 * money. The subsidy is uncapped, unlike the 3-claim bond waiver.
 *
 * So this makes the policy EXPRESSIBLE without changing it. The default is `all`,
 * which is exactly today's behaviour — this module is a seam, not a switch that
 * has been thrown.
 *
 * `curated_only` fails CLOSED rather than half-working: there is no worker-
 * submitted claim path yet, so if the policy excludes a job we refuse it with a
 * reason instead of silently doing something else. Building that path — or
 * recovering the gas from the poster's escrow so brokering stays break-even — is
 * the follow-up, and it belongs with the settlement work.
 */
export const CLAIM_BROKERAGE_POLICIES = Object.freeze(["all", "curated_only"]);
export const DEFAULT_CLAIM_BROKERAGE_POLICY = "all";

export function resolveClaimBrokeragePolicy(env = process.env) {
  const raw = String(env?.CLAIM_BROKERAGE_POLICY ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_CLAIM_BROKERAGE_POLICY;
  if (!CLAIM_BROKERAGE_POLICIES.includes(raw)) {
    throw new Error(
      `CLAIM_BROKERAGE_POLICY must be one of ${CLAIM_BROKERAGE_POLICIES.join(", ")}.`
    );
  }
  return raw;
}

/**
 * Classification is deliberately NOT redefined here. isExternalJob already owns
 * it and accepts both shapes the catalogue uses — `source: "external"` and
 * `source: { type: "external" }`. A local copy that handled only one would have
 * silently brokered half the external jobs, and two definitions of "external"
 * is the drift this codebase keeps paying for.
 */
export function shouldBrokerClaim(job, policy = DEFAULT_CLAIM_BROKERAGE_POLICY) {
  if (policy === "curated_only") return !isExternalJob(job);
  return true;
}

/**
 * Refusal for a claim we will not pay gas for. Structured and specific: an agent
 * that cannot claim must learn WHY and what would change it, not receive a bare
 * failure — the same contract the rest of the front door already honours.
 */
export function claimBrokerageRefusal(jobId) {
  return new AuthorizationError(
    `Job ${jobId} is externally posted; the operator does not broker its on-chain claim. `
    + "Claim it directly on EscrowCore from a wallet holding native gas.",
    "claim_not_brokered"
  );
}

/**
 * True when advertising copy may state that gas is operator-brokered without
 * qualification. Used by the discovery-manifest guard so the published wording
 * cannot keep promising universal brokering after the policy narrows.
 */
export function brokerageIsUniversal(policy = DEFAULT_CLAIM_BROKERAGE_POLICY) {
  return policy === "all";
}
