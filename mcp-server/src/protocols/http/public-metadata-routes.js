import { BADGE_RECEIPT_JWKS_PATH } from "../../core/badge-receipt-signing.js";

const ROOT_ENDPOINTS = [
  "/health",
  "/metrics",
  "/agent-tools.json",
  "/onboarding",
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
  "/account/repay",
  "/account/strategies",
  "/xcm/request",
  "/payments/send",
  "/reputation",
  "/session",
  "/session/timeline",
  "/sessions",
  "/jobs",
  "/jobs/sub",
  "/jobs/tiers",
  "/agents",
  "/agents/:wallet",
  "/shares",
  "/shares/:token",
  "/badges",
  "/badges/:sessionId",
  BADGE_RECEIPT_JWKS_PATH,
  "/alerts",
  "/audit",
  "/policies",
  "/policies/:tag",
  "/disputes",
  "/disputes/:id",
  "/disputes/:id/verdict",
  "/disputes/:id/release",
  "/strategies",
  "/admin/jobs/pause",
  "/admin/jobs/resume",
  "/jobs/preflight",
  "/jobs/recommendations",
  "/gas/health",
  "/gas/capabilities",
  "/gas/quote",
  "/gas/sponsor",
  "/verifier/handlers",
  "/verifier/replay",
  "/admin/jobs",
  "/admin/jobs/timeline",
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
  "/admin/github/status"
];

export function createPublicMetadataRoutes({
  authConfig,
  buildDiscoveryManifest,
  publicBaseUrl,
  respond,
  service,
  strategies,
}) {
  const normalizedPublicBaseUrl = publicBaseUrl?.trim().replace(/\/+$/u, "");
  const badgeReceiptJwksUrl = normalizedPublicBaseUrl
    ? `${normalizedPublicBaseUrl}${BADGE_RECEIPT_JWKS_PATH}`
    : BADGE_RECEIPT_JWKS_PATH;

  return async function handlePublicMetadataRoute({ request, response, pathname }) {
    if (request.method === "GET" && pathname === "/") {
      respond(response, 200, {
        name: "agent-platform",
        status: "ok",
        authMode: authConfig.mode,
        receiptVerification: {
          badgeReceipts: {
            alg: "ES256",
            kid: "badge-1",
            jwksUrl: badgeReceiptJwksUrl,
            canonicalizationDocs: "https://github.com/averray-agent/agent/blob/main/docs/schemas/agent-badge-v1.md#exact-canonicalization-and-signing-bytes"
          }
        },
        endpoints: ROOT_ENDPOINTS
      });
      return true;
    }

    if (request.method === "GET" && pathname === "/status/providers") {
      // Public, sanitized counterpart to /admin/status.providerOperations.
      respond(response, 200, await service.getPublicProviderOperations());
      return true;
    }

    if (request.method === "GET" && pathname === "/onboarding") {
      respond(response, 200, service.getPlatformCapabilities());
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
          baseUrl: publicBaseUrl?.trim() || undefined
        }),
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    if (request.method === "GET" && pathname === "/strategies") {
      respond(
        response,
        200,
        {
          strategies,
          docs: "https://github.com/depre-dev/agent/blob/main/docs/strategies/vdot.md"
        },
        { "cache-control": "public, max-age=300" }
      );
      return true;
    }

    return false;
  };
}
