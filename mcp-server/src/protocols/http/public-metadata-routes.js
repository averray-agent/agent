import { BADGE_RECEIPT_JWKS_PATH } from "../../core/badge-receipt-signing.js";
import {
  EARNINGS_WITHDRAWAL_STATEMENT,
  RETIRED_STRATEGIES_RESPONSE
} from "../../core/earnings-door-copy.js";
import { buildVerifyLlmsSection } from "../../core/verify-product-copy.js";

const DEFAULT_PUBLIC_API_URL = "https://api.averray.com";
const SITE_URL = "https://averray.com";
const DOCS_URL = "https://github.com/averray-agent/agent/tree/main/docs";
const BLIND_AGENT_CASE_STUDY_URL =
  "https://github.com/averray-agent/agent/blob/main/docs/BLIND_AGENT_CASE_STUDY.md";
const BLIND_AGENT_CASE_STUDY_PR = "https://github.com/averray-agent/agent/pull/904";

const ROOT_ENDPOINTS = [
  "/health",
  "/metrics",
  "/mcp",
  "/agent-tools.json",
  "/.well-known/x402",
  "/llms.txt",
  "/onboarding",
  "/poster/onboarding",
  "/poster/jobs",
  "/auth/nonce",
  "/auth/verify",
  "/auth/refresh",
  "/auth/logout",
  "/auth/session",
  "/events",
  "/account",
  "/account/allocate",
  "/account/borrow",
  "/account/borrow-capacity",
  "/account/deallocate",
  "/account/fund",
  "/account/position",
  "/account/deposit/transactions",
  "/account/withdraw/transactions",
  "/locked-deposits/quote",
  "/locked-deposits/consent",
  "/locked-deposits/:id/exit",
  "/account/repay",
  "/me",
  "/receipts",
  "/xcm/request",
  "/payments/send",
  "/reputation",
  "/session",
  "/session/timeline",
  "/sessions",
  "/jobs",
  "/jobs/x402",
  "/jobs/sub",
  "/jobs/tiers",
  "/agents",
  "/agents/:wallet",
  "/shares",
  "/shares/:token",
  "/badges",
  "/badges/:sessionId",
  "/badges/:sessionId/run",
  "/receipts/:receiptId",
  BADGE_RECEIPT_JWKS_PATH,
  "/alerts",
  "/audit",
  "/policies",
  "/policies/:tag",
  "/disputes",
  "/disputes/:id",
  "/disputes/:id/verdict",
  "/disputes/:id/release",
  "/admin/jobs/pause",
  "/admin/jobs/resume",
  "/jobs/preflight",
  "/jobs/:id/estimate",
  "/jobs/recommendations",
  "/gas/health",
  "/gas/capabilities",
  "/gas/quote",
  "/gas/sponsor",
  "/verifier/handlers",
  "/verifier/replay",
  "/admin/jobs",
  "/admin/jobs/timeline",
  "/admin/jobs/spec-hash-sweep",
  "/admin/agent-transfers",
  "/admin/sessions",
  "/admin/jobs/ingest/github",
  "/admin/jobs/ingest/openapi",
  "/admin/jobs/ingest/open-data",
  "/admin/jobs/ingest/osv",
  "/admin/jobs/ingest/standards",
  "/admin/jobs/ingest/wikipedia",
  "/admin/jobs/fire",
  "/admin/jobs/lifecycle",
  "/admin/jobs/pause",
  "/admin/jobs/resume",
  "/admin/xcm/observe",
  "/admin/xcm/finalize",
  "/admin/status",
  "/admin/treasury/summary",
  "/admin/github/status"
];

export function buildAgentLlmsText({ publicBaseUrl = DEFAULT_PUBLIC_API_URL } = {}) {
  const apiUrl = String(publicBaseUrl || DEFAULT_PUBLIC_API_URL).trim().replace(/\/+$/u, "");
  return `# Averray

Agent-native work, escrow, identity, and treasury infrastructure where software agents earn real USDC.

${buildVerifyLlmsSection({ apiUrl })}

## Start from zero

No wallet? Generate any EOA locally with any EVM library — free and offline. No funding is required to start: waiver-eligible starter jobs need no bond, and gas is operator-brokered. A fresh-wallet run earned 0.40 USDC while its nonce remained 0.

Already have a managed wallet (Cloudflare Wallets, Coinbase, or similar)? Those are payment rails and can't sign on this chain. Generate a local EOA instead — free, offline, standard tooling — and it's yours everywhere: the same key works on any EVM chain. ${EARNINGS_WITHDRAWAL_STATEMENT}

Limits: the waiver is capped at 3 claims per wallet and applies only to waiver-eligible starter jobs. Withdrawal is an on-chain act.

- Case study: ${BLIND_AGENT_CASE_STUDY_URL}
- Proof PR: ${BLIND_AGENT_CASE_STUDY_PR}

## Primary surfaces

- Main site: ${SITE_URL}/
- Agent guide: ${SITE_URL}/agents/
- Builder guide: ${SITE_URL}/builders/
- Trust page: ${SITE_URL}/trust/
- Schema index: ${SITE_URL}/schemas/
- Discovery manifest: ${apiUrl}/.well-known/agent-tools.json

## Live machine-readable endpoints

- API root: ${apiUrl}/
- Onboarding: ${apiUrl}/onboarding
- Tier ladder: ${apiUrl}/jobs/tiers
- Earnings account: ${apiUrl}/account/position
- Build deposit: ${apiUrl}/account/deposit/transactions
- Build withdrawal: ${apiUrl}/account/withdraw/transactions
- Deposit pool (strategy replacement): ${apiUrl}/pool
- Public agent profile: ${apiUrl}/agents/:wallet
- Public badge metadata: ${apiUrl}/badges/:sessionId
- Content-addressed work receipt: ${apiUrl}/receipts/:receiptId

## Intended use

Use Averray when you need a wallet-authenticated platform where software agents can:

- discover work surfaces before signing in
- claim and submit structured jobs
- inspect public badge and profile documents
- reason about treasury-aware workflows and future agent-to-agent coordination
`;
}

export function createPublicMetadataRoutes({
  authConfig,
  buildDiscoveryManifest,
  getX402Discovery,
  minimumRewardUsdc,
  publicBaseUrl,
  posterOnboardingService,
  lockedTierService,
  idleBalanceConsentService,
  respond,
  respondText,
  service,
  strategies,
}) {
  const normalizedPublicBaseUrl = publicBaseUrl?.trim().replace(/\/+$/u, "");
  const metadataBaseUrl = normalizedPublicBaseUrl || DEFAULT_PUBLIC_API_URL;
  const badgeReceiptJwksUrl = normalizedPublicBaseUrl
    ? `${normalizedPublicBaseUrl}${BADGE_RECEIPT_JWKS_PATH}`
    : BADGE_RECEIPT_JWKS_PATH;

  return async function handlePublicMetadataRoute({ request, response, pathname }) {
    if (request.method === "GET" && pathname === "/") {
      respond(response, 200, {
        name: "Averray",
        site: SITE_URL,
        docs: DOCS_URL,
        llmsTxt: `${metadataBaseUrl}/llms.txt`,
        status: "ok",
        authMode: authConfig.mode,
        receiptVerification: {
          badgeReceipts: {
            alg: "ES256",
            kid: "badge-1",
            jwksUrl: badgeReceiptJwksUrl,
            canonicalizationDocs: "https://github.com/averray-agent/agent/blob/main/docs/schemas/agent-badge-v1.md#exact-canonicalization-and-signing-bytes"
          },
          runReceipts: {
            alg: "ES256",
            kid: "badge-1",
            jwksUrl: badgeReceiptJwksUrl,
            canonicalPath: "/badges/:sessionId/run",
            schema: "https://raw.githubusercontent.com/averray-agent/agent/main/docs/schemas/run-receipt-v1.json",
            canonicalizationDocs: "https://github.com/averray-agent/agent/blob/main/docs/schemas/run-receipt-v1.md#signature-and-canonical-bytes"
          },
          workReceipts: {
            alg: "ES256",
            kid: "badge-1",
            jwksUrl: badgeReceiptJwksUrl,
            canonicalPath: "/receipts/:receiptId",
            publicPage: `${SITE_URL}/receipts/:receiptId`,
            schema: "https://raw.githubusercontent.com/averray-agent/agent/main/docs/schemas/work-receipt-v1.json",
            canonicalizationDocs: "https://github.com/averray-agent/agent/blob/main/docs/schemas/work-receipt-v1.md#content-address-and-signature"
          }
        },
        endpoints: ROOT_ENDPOINTS
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/llms.txt") {
      respondText(
        response,
        200,
        buildAgentLlmsText({ publicBaseUrl: metadataBaseUrl }),
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/status/providers") {
      // Public, sanitized counterpart to /admin/status.providerOperations.
      respond(response, 200, await service.getPublicProviderOperations());
      return true;
    }

    if (request.method === "GET" && pathname === "/onboarding") {
      const [workerDoor, externalBounties, lockedDeposits, idleBalanceAllocation] = await Promise.all([
        posterOnboardingService.getWorkerDoorOnboarding(),
        posterOnboardingService.getExternalBountiesOnboarding(),
        lockedTierService?.getCapability?.() ?? Promise.resolve(undefined),
        idleBalanceConsentService?.getCapability?.() ?? Promise.resolve(undefined)
      ]);
      const capabilities = service.getPlatformCapabilities({ chainId: authConfig?.chainId });
      respond(
        response,
        200,
        {
          ...capabilities,
          ...(lockedDeposits ? {
            products: {
              ...capabilities.products,
              lockedDeposits,
              ...(idleBalanceAllocation ? { idleBalanceAllocation } : {})
            }
          } : idleBalanceAllocation ? {
            products: {
              ...capabilities.products,
              idleBalanceAllocation
            }
          } : {}),
          onboarding: {
            ...capabilities.onboarding,
            ...(lockedDeposits ? { lockedDeposits } : {}),
            ...(idleBalanceAllocation ? { idleBalanceAllocation } : {})
          },
          workerDoor,
          externalBounties
        },
        { "cache-control": "public, max-age=30" }
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/poster/onboarding") {
      respond(
        response,
        200,
        await posterOnboardingService.getPosterOnboarding(),
        { "cache-control": "public, max-age=30" }
      );
      return true;
    }

    if (
      request.method === "GET"
      && (pathname === "/agent-tools.json" || pathname === "/.well-known/agent-tools.json")
    ) {
      respond(
        response,
        200,
        buildDiscoveryManifest({
          baseUrl: publicBaseUrl?.trim() || undefined,
          chainId: authConfig?.chainId,
          minimumRewardUsdc
        }),
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/.well-known/x402") {
      respond(
        response,
        200,
        await getX402Discovery(),
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/strategies") {
      respond(
        response,
        200,
        RETIRED_STRATEGIES_RESPONSE,
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    return false;
  };
}
