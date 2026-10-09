import {
  VERIFY_BASE_NETWORK,
  VERIFY_BILLING_RULE,
  VERIFY_PROFILES_URL,
  VERIFY_X402_DISCOVERY_URL
} from "../../../mcp-server/src/core/verify-product-copy.js";

// A static directory handoff, not a payable quote or a Bazaar registration.
// Discovery and an unpaid POST supply current request-bound requirements.
export function GET() {
  return new Response(JSON.stringify({
    schemaVersion: "averray.verify-directory-listing.v1",
    name: "Averray Verify",
    description: "Paid, bounded verification of a candidate result with a signed, content-addressed receipt.",
    homepage: "https://averray.com/verify/",
    resource: { url: "https://api.averray.com/verify/runs", method: "POST", mimeType: "application/json" },
    payment: {
      protocol: "x402",
      network: VERIFY_BASE_NETWORK,
      asset: "USDC",
      requirementsSource: VERIFY_X402_DISCOVERY_URL,
      quote: "POST the exact request without payment; use the returned 402 accepts[0] unchanged.",
      settlement: "self_capture",
      captureAfter: "approved_or_rejected_verdict",
      billingRule: VERIFY_BILLING_RULE,
      automaticBazaarRegistration: false
    },
    inputContract: { profiles: VERIFY_PROFILES_URL, examples: "profiles[].workedExample.request" },
    completion: { poll: "https://api.averray.com/verify/runs/{runId}", receipt: "https://averray.com/receipts/{receiptId}/" },
    mcp: { endpoint: "https://api.averray.com/mcp", quote: "quoteVerificationRun", start: "startVerificationRun", poll: "getVerificationRun" }
  }, null, 2) + "\n", { headers: { "content-type": "application/json" } });
}
