export const VERIFY_HERO_PROFILE_REF = "mcp-failure-semantics-v1@1";
export const VERIFY_X402_DISCOVERY_URL = "https://api.averray.com/.well-known/x402";
export const VERIFY_PROFILES_URL = "https://api.averray.com/verify/profiles";
export const VERIFY_BASE_NETWORK = "eip155:8453";
export const VERIFY_BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export const LIST_VERIFICATION_PROFILES_DESCRIPTION =
  `Published standalone verification profiles with pinned versions, limits, and success criteria. `
  + `Read the exact price and EIP-3009 payment requirements from ${VERIFY_X402_DISCOVERY_URL}; `
  + `the paid surface uses USDC ${VERIFY_BASE_USDC} on Base ${VERIFY_BASE_NETWORK}. `
  + "Inconclusive runs are not billed.";

export function buildVerifyLlmsSection({ apiUrl }) {
  return `## Verify — paid verification on Base

Buy a pinned verification run without creating a worker account. Start with ${VERIFY_HERO_PROFILE_REF}: it needs only an MCP endpoint URL.

- Live price and payment requirements: ${VERIFY_X402_DISCOVERY_URL} — read \`resources[0].maxAmountRequired\` and the selected \`accepts[]\` entry; no price is restated here.
- Payment rail: x402 EIP-3009 authorization for Base USDC (${VERIFY_BASE_NETWORK}, token ${VERIFY_BASE_USDC}).
- Profiles and request examples: ${VERIFY_PROFILES_URL}
- Submit: POST ${apiUrl}/verify/runs
- Public result: GET ${apiUrl}/verify/runs/{runId} — no authentication required.
- Public receipt after completion: https://averray.com/receipts/{receiptId}
`;
}
