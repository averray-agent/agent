const price = (amount, amountRaw) => Object.freeze({
  amount,
  amountRaw,
  asset: "USDC",
  decimals: 6,
  network: "eip155:8453",
  billingRule: "inconclusive_not_billed"
});

// Prices are product policy, not deployment configuration. All consumers use
// the selected published profile, including discovery and build-time content.
export const VERIFY_PROFILE_PRICES = Object.freeze({
  "git-patch-tests-v1": price("5", "5000000"),
  "mcp-failure-semantics-v1": price("0.25", "250000"),
  "structured-output-evidence-v1": price("0.25", "250000")
});

// Published identity and price metadata is dependency-free for build-time consumers.
export const VERIFY_PROFILE_CATALOGUE = Object.freeze([
  "mcp-failure-semantics-v1", "git-patch-tests-v1", "structured-output-evidence-v1"
].map((name) => Object.freeze({ name, version: 1, ref: `${name}@1`, price: VERIFY_PROFILE_PRICES[name] })));
