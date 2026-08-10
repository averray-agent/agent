/**
 * What a worker should expect about getting paid, derived from the job's own
 * verifier mode.
 *
 * WHY THIS EXISTS
 * A worker browsing the board sees the reward and cannot see how the job is
 * verified — `verifierMode` was not in the listing at all. On 2026-08-10 the live
 * board was 8 `benchmark` jobs and 4 `human_fallback` ones: a third of the work
 * routed to human review with a seven-day worst case, and nothing distinguished
 * those from the jobs that settle automatically. An agent choosing between a 0.4
 * and a 0.25 reward was choosing blind on the dimension that matters most to it.
 *
 * STRUCTURAL, NOT STATISTICAL
 * This is deliberately NOT a measured median time-to-payment. Almost every job
 * settled so far was completed by the operator's own worker, so any average we
 * published would describe ourselves rather than what an outsider would meet —
 * the same trap as counting our own probes as external arrivals. What is said
 * here follows from the verifier mode alone, so it is true on day one with no
 * sample and cannot drift as the population changes. A measured figure belongs
 * here later, beside this rather than instead of it, once there is an external
 * population to measure and the same self/external split to measure it honestly.
 *
 * Derived on read, never stored: the expectation cannot fall out of step with
 * the mode it describes.
 */

/** Seven days. The on-chain `EscrowCore.DISPUTE_WINDOW`, read 2026-08-10 as 604800. */
const DISPUTE_WINDOW_SECONDS = 604800;

const EXPECTATIONS = Object.freeze({
  benchmark: {
    path: "automatic",
    approval: "A verifier checks the submission against the job's terms. No human is involved.",
    worstCase: null
  },
  deterministic: {
    path: "automatic",
    approval: "A verifier checks the submission against the job's terms. No human is involved.",
    worstCase: null
  },
  github_pr: {
    path: "automatic_with_human_fallback",
    approval:
      "Live GitHub evidence is checked automatically and approves on its own when it is "
      + "readable and passing.",
    worstCase:
      "If GitHub is unreachable, rate-limited, private or ambiguous, it enters human "
      + "review instead and never auto-approves."
  },
  human_fallback: {
    path: "human_review",
    approval: "A human reviews the submission. There is no automatic approval.",
    worstCase: "A contested outcome can take up to the dispute window to resolve."
  }
});

/**
 * @returns {object|undefined} undefined when the mode is unknown — an absent block
 *   is honest, whereas a guessed one would be the kind of confident wrong answer
 *   an agent would act on.
 */
export function buildSettlementExpectation(verifierMode) {
  const mode = String(verifierMode ?? "").trim().toLowerCase();
  const known = EXPECTATIONS[mode];
  if (!known) return undefined;
  return {
    verifierMode: mode,
    path: known.path,
    approval: known.approval,
    // Only the paths a human can enter are bounded by the dispute window; an
    // automatic verifier settles or rejects without one.
    ...(known.path === "automatic"
      ? {}
      : { humanReviewWorstCaseSeconds: DISPUTE_WINDOW_SECONDS }),
    ...(known.worstCase ? { worstCase: known.worstCase } : {})
  };
}

export { DISPUTE_WINDOW_SECONDS };
