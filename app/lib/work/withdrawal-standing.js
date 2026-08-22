export const WITHDRAWAL_STANDING_STATEMENT =
  "Withdrawing never affects your tier, badges, caps, or eligibility — your standing stays with your wallet.";
export const CREDIT_INTEREST_STATEMENT =
  "Proven workers can register interest in a small zero-interest cash line (pilot).";

export function withdrawalStandingFromIntent(payload) {
  const standing = asRecord(asRecord(payload)?.standing);
  const creditInterest = asRecord(standing?.creditInterest);
  if (
    standing?.persists !== true
    || standing.statement !== WITHDRAWAL_STANDING_STATEMENT
    || standing.claimTierLabel !== "claim tier"
    || !nonEmptyString(standing.claimTier)
    || !nonEmptyString(standing.reputationTier)
    || !nonNegativeInteger(standing.badges)
    || !nonNegativeInteger(standing.waiverSlotsRemaining)
    || typeof creditInterest?.eligible !== "boolean"
    || typeof creditInterest?.registered !== "boolean"
  ) return null;

  const eligible = creditInterest.eligible === true;
  if (eligible && (
    standing.registerPath !== "/credit/interest"
    || standing.creditInterestStatement !== CREDIT_INTEREST_STATEMENT
  )) return null;
  if (!eligible && (
    Object.hasOwn(standing, "registerPath")
    || Object.hasOwn(standing, "creditInterestStatement")
  )) return null;

  return {
    claimTier: standing.claimTier,
    claimTierLabel: standing.claimTierLabel,
    reputationTier: standing.reputationTier,
    badges: standing.badges,
    waiverSlotsRemaining: standing.waiverSlotsRemaining,
    creditInterest: {
      eligible,
      registered: creditInterest.registered
    },
    ...(eligible
      ? {
          registerPath: standing.registerPath,
          creditInterestStatement: standing.creditInterestStatement
        }
      : {}),
    persists: true,
    statement: standing.statement
  };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}
