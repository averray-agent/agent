import { buildDiscoveryManifest, POLKADOT_HUB_MAINNET_CHAIN_ID } from "./discovery-manifest.js";
import { HTTP_METRIC_PATHS } from "../protocols/http/http-helpers.js";

// publicEndpoints is the existing discovery allowlist, NOT an auth bypass.
// HTTP handlers retain their own auth. In particular /metrics is advertised
// there but bearer-gated in production, and must not enter this public spec.
export const PUBLIC_OPENAPI_EXCLUSIONS = Object.freeze({
  "GET /metrics": "Private production telemetry; requires the metrics bearer, not a public API contract.",
  "GET /verifier/handlers": "Session-settlement verifier internals; standalone buyers use /verify/profiles."
});

// http-helpers' list is often mistaken for the public allowlist. Check it too,
// conservatively: a new path there must be documented or receive a deliberate
// scope decision. These reasons do not change the handlers' access controls.
export const OPENAPI_INVENTORY_EXCLUSIONS = Object.freeze({
  "/metrics": "Bearer-gated production telemetry.",
  "/monitor/bank-feed": "Operator monitoring, not a buyer/worker contract.",
  "/monitor/deposit-pool": "Operator ceremony observability, not a buyer/worker contract.",
  "/shares": "Authenticated snapshot creation; public token resolution is documented separately.",
  "/strategies": "Retired surface; callers are directed to /pool.",
  "/account/strategies": "Retired surface; callers are directed to /pool.",
  "/account/allocate": "Capability-gated treasury mutation, outside the public worker door.",
  "/account/deallocate": "Capability-gated treasury mutation, outside the public worker door.",
  "/account/borrow": "Capability-gated treasury mutation, outside this contract.",
  "/account/repay": "Capability-gated treasury mutation, outside this contract.",
  "/account/fund": "Privileged funding path; the public door returns self-deposit templates.",
  "/payments/send": "Retired surface; the public withdrawal-template door is documented.",
  "/auth/session": "Privileged session creation; worker sessions use /auth/nonce and /auth/verify.",
  "/session/timeline": "Authenticated operational session timeline; /session exposes the worker state.",
  "/xcm/request": "Owner/operator async treasury diagnostics.",
  "/jobs/sub": "Authenticated delegation, outside the public single-job worker door.",
  "/events": "Authenticated SSE event stream, not a public collection.",
  "/alerts": "Authenticated operational alert collection.",
  "/audit": "Authenticated operational audit collection.",
  "/policies": "Authenticated policy inspection, not a public collection.",
  "/content": "Hash-content publication; outside the public receipt read contract.",
  "/disputes": "Role-gated dispute operations, outside this public document.",
  "/verifier/handlers": "Session-settlement verifier catalogue; buyers use /verify/profiles.",
  "/verifier/result": "Session-settlement verifier internals; buyers use /verify/runs/{runId}.",
  "/verifier/replay": "Role-gated session-settlement verifier internals.",
  "/verifier/run": "Role-gated settlement orchestration, not standalone Verify.",
  "/gas/quote": "Authenticated ERC-4337 operational quote, outside the worker door.",
  "/gas/sponsor": "Authenticated ERC-4337 sponsorship, outside the worker door."
});

// Companion public reads not enumerated in publicEndpoints (the registry also
// predates the per-id job route). These are checked as operations, not merely
// path strings, so documenting POST cannot silently stand in for GET.
const PUBLIC_COMPANIONS = [
  ["GET", "/"], ["GET", "/openapi.json"], ["GET", "/mcp"],
  ["GET", "/agent-tools.json"], ["GET", "/.well-known/agent-tools.json"],
  ["GET", "/status/providers"], ["GET", "/transparency"],
  ["GET", "/jobs/{id}"], ["GET", "/jobs/open"],
  ["GET", "/badges/{sessionId}/run"], ["GET", "/.well-known/badge-receipt-jwks.json"]
];

export function toOpenApiPath(path) {
  return path.split("?")[0].replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
}

export function publicOpenApiErrors(document, {
  manifest = buildDiscoveryManifest({ chainId: POLKADOT_HUB_MAINNET_CHAIN_ID }),
  inventory = HTTP_METRIC_PATHS
} = {}) {
  const errors = [];
  if (document?.openapi !== "3.1.0") errors.push("openapi must be 3.1.0");
  if (!document?.info?.title || !document?.info?.version) errors.push("info.title/version are required");
  if (!document?.paths || !Object.keys(document.paths).length) errors.push("paths are required");
  if (JSON.stringify(document?.servers?.map(({ url }) => url)) !== JSON.stringify(["https://api.averray.com"])) {
    errors.push("servers must contain only https://api.averray.com");
  }
  if (JSON.stringify(document).includes("420420417")) errors.push("testnet chain id 420420417 must not be published");
  for (const [path, pathItem] of Object.entries(document?.paths ?? {})) {
    if (path.startsWith("/admin/")) errors.push(`private admin path ${path} must not be published`);
    if (Object.hasOwn(OPENAPI_INVENTORY_EXCLUSIONS, path)) {
      errors.push(`excluded path ${path} must not be published: ${OPENAPI_INVENTORY_EXCLUSIONS[path]}`);
    }
    for (const method of Object.keys(pathItem ?? {})) {
      const key = `${method.toUpperCase()} ${path}`;
      if (Object.hasOwn(PUBLIC_OPENAPI_EXCLUSIONS, key)) {
        errors.push(`excluded public operation ${key} must not be published: ${PUBLIC_OPENAPI_EXCLUSIONS[key]}`);
      }
    }
  }
  const advertised = manifest.publicEndpoints.map(({ method, path }) => [method, toOpenApiPath(path)]);
  for (const [method, path] of [...advertised, ...PUBLIC_COMPANIONS]) {
    const key = `${method} ${path}`;
    if (PUBLIC_OPENAPI_EXCLUSIONS[key]) continue;
    if (!document?.paths?.[path]?.[method.toLowerCase()]) errors.push(`missing public operation ${key}`);
  }
  for (const path of inventory) {
    // The admin namespace is categorically outside the public contract; the
    // publication check above separately forbids it from appearing in paths.
    if (path.startsWith("/admin/") || OPENAPI_INVENTORY_EXCLUSIONS[path]) continue;
    if (!document?.paths?.[path]) errors.push(`route inventory path needs documentation or a named exclusion: ${path}`);
  }
  return [...new Set(errors)];
}
