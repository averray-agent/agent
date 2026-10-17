import { VERIFY_PROFILE_CATALOGUE } from "./verification-profile-prices.js";
import { VERIFY_BILLING_RULE } from "./verify-product-copy.js";

export const VERIFY_PRICING_PAGE = "https://averray.com/pricing/";

// The API and static site project the same published registry; neither owns prices.
export function buildVerifyPricing(profiles = VERIFY_PROFILE_CATALOGUE) {
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
- Before authorizing a run, read the requested profile's live 402 quote. ${VERIFY_BILLING_RULE}

## Terms

- Averray Verify terms of use: https://averray.com/terms/
- API terms redirect: ${apiUrl}/terms
- Privacy policy, including Verify data: https://averray.com/privacy/
`;
}
