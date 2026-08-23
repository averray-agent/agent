function normalizedAddress(value) {
  const address = String(value ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/u.test(address) ? address : undefined;
}

/**
 * Classify a job by the EscrowCore address that actually holds it.
 *
 * Dates and ABI layouts are deliberately not evidence of ownership. During a
 * drain, both generations are readable at once; the address returned by the
 * authoritative job lookup is the only safe routing fact.
 */
export function classifyEscrowGeneration(liveJob, config = {}) {
  const jobEscrow = normalizedAddress(liveJob?.escrowAddress);
  const currentEscrow = normalizedAddress(config?.escrowCoreAddress);
  const legacyEscrow = normalizedAddress(config?.legacyEscrowCoreAddress);

  if (jobEscrow && legacyEscrow && jobEscrow === legacyEscrow) return "legacy";
  if (jobEscrow && currentEscrow && jobEscrow === currentEscrow) return "current";

  // Gateways without a configured drain contract have only one generation.
  // Once a legacy address is configured, missing/unrecognised ownership is
  // fail-closed instead.
  if (!legacyEscrow && (!jobEscrow || !currentEscrow || jobEscrow === currentEscrow)) {
    return "current";
  }
  return "unknown";
}
