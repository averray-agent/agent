/**
 * Fail-closed claim-button policy for the public work surface.
 *
 * The wallet action and the actual claim share this classifier so the button
 * never gets ahead of the live definition/schema or wallet-specific terms.
 */
export function claimActionReadiness({
  authenticated,
  providerAvailable,
  publiclyListed,
  definitionReady,
  schemaReady,
  schemaFailed,
  walletChecksLoading,
  walletChecksFailed,
  eligible,
  refusalReason,
}) {
  if (!publiclyListed) {
    return blocked("This task is not currently listed as public paid work.");
  }
  if (!definitionReady) {
    return blocked("Loading the live task definition before wallet access is enabled.");
  }
  if (schemaFailed) {
    return blocked("The live output schema is unavailable. Retry it before claiming.");
  }
  if (!schemaReady) {
    return blocked("Loading the live output schema before wallet access is enabled.");
  }

  if (!authenticated) {
    if (!providerAvailable) {
      return blocked("Install MetaMask or Talisman before checking this wallet.");
    }
    return { enabled: true, reason: "Wallet sign-in opens the live claim preflight; it does not claim yet." };
  }

  if (walletChecksLoading) {
    return blocked("Loading live net reward, waiver, eligibility, lock, and gas terms.");
  }
  if (walletChecksFailed) {
    return blocked("Wallet-specific claim terms could not be confirmed. Retry the live checks.");
  }
  if (!eligible) {
    const readableReason = typeof refusalReason === "string" && refusalReason.trim()
      ? refusalReason.replace(/_/gu, " ")
      : "the live preflight refused this claim";
    return blocked(`Claim unavailable: ${readableReason}.`);
  }
  return { enabled: true, reason: "Live claim terms are resolved. Claiming is enabled." };
}

function blocked(reason) {
  return { enabled: false, reason };
}
