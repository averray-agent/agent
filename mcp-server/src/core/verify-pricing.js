import { VerificationProfileRegistry } from "../services/verification-profile-registry.js";

export const VERIFY_PRICING_PAGE = "https://averray.com/pricing/";
export const VERIFY_TERMS_PAGE = "https://averray.com/terms/";

// The API and static site project the same published registry; neither owns prices.
export function buildVerifyPricing(profiles = new VerificationProfileRegistry().list()) {
  return {
    verify: profiles.map(({ ref, price }) => ({
      profile: ref,
      amount: price.amount,
      asset: price.asset,
      network: price.network,
      billingRule: price.billingRule
    })),
    page: VERIFY_PRICING_PAGE
  };
}

export function buildVerifySiteSignalsLlmsSection({ apiUrl = "https://api.averray.com" } = {}) {
  return `## Pricing

- Per-profile Verify prices: ${apiUrl}/pricing
- Pricing page: ${VERIFY_PRICING_PAGE}
- Before authorizing a run, read the requested profile's live 402 quote. Inconclusive runs are not billed.

## Terms

- Service terms (DRAFT — pending operator approval): ${VERIFY_TERMS_PAGE}
- API terms redirect: ${apiUrl}/terms
`;
}
