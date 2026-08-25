import { getAddress } from "ethers";
import { AuthenticationError, AuthorizationError } from "../core/errors.js";
import { verifyTokenFromConfig } from "./jwt.js";
import { ARRIVAL_CANARY_MARKER_TOKEN_KIND } from "./token-kinds.js";
import { hasRole, resolveRoles } from "./config.js";
import {
  getRouteCapabilityRequirements,
  isSubstrateNativeClaims,
  isViewerOnlyClaims,
  missingCapabilities,
  resolveCapabilities
} from "./capabilities.js";
import { isGrantActive, mergeGrantCapabilities } from "../core/capability-grants.js";
import { buildAuthRequirementDetails } from "../core/discovery-manifest.js";
import { parseWalletIdentity } from "../core/wallet-identity.js";

const GRANT_CACHE_TTL_MS = 15_000;
// B-03 — state-changing (mutating) requests re-check grants on a much tighter
// freshness bound than reads, so a *cross-process* revoke stops authorizing
// MUTATIONS within ~2s instead of the 15s read-path backstop. A revoked grant
// briefly still being *read* is far lower-stakes than one briefly still
// *settling*; reads keep the 15s TTL for steady-state throughput.
const MUTATION_GRANT_CACHE_TTL_MS = 2_000;

/**
 * Create an auth middleware bound to a specific auth configuration.
 *
 * Returns a `requireAuth(request, url, options)` function that extracts and
 * verifies a token, returning `{ wallet, claims, via }`.
 *
 * Options:
 *   - allowQueryToken: accept ?token= in the URL (used for SSE where headers are unavailable).
 *   - requireRole: throw AuthorizationError unless the verified claims include this role.
 *   - requireCapability / requireCapabilities: require one or more resolved capabilities.
 *
 * In permissive mode, if no token is supplied, the middleware falls back to the
 * `wallet` query parameter with a warning. In strict mode, missing or invalid
 * tokens always throw `AuthenticationError`. Role enforcement is checked in
 * both modes — permissive fallback wallets are resolved against
 * `authConfig.adminWallets` / `authConfig.verifierWallets` to avoid locking
 * admins out of local dev.
 *
 * A `stateStore` with `isTokenRevoked(jti)` is optional. When supplied the
 * middleware rejects tokens whose `jti` is in the revocation list.
 */
export function createAuthMiddleware({
  authConfig,
  stateStore,
  substrateMappingGate,
  logger = console,
  now = () => new Date()
}) {
  // Per-subject grant cache. The grant list is stable for the lifetime of a
  // JWT and lookups happen on every authed request, so a short in-process
  // cache keeps the steady-state cost of capability merging low. Grant/revoke
  // routes explicitly invalidate touched subjects so operator-initiated
  // revokes take effect on the next request in THIS process; the TTL is the
  // cross-process backstop. Entries store `fetchedAt` so the caller can apply a
  // per-request freshness bound — tighter for mutations (B-03).
  const grantCache = new Map();

  async function loadActiveGrantsFor(wallet, maxAgeMs = GRANT_CACHE_TTL_MS) {
    if (!wallet) return [];
    if (typeof stateStore?.listCapabilityGrants !== "function") return [];
    const cacheKey = String(wallet).toLowerCase();
    const cached = grantCache.get(cacheKey);
    const nowMs = now().getTime();
    if (cached && nowMs - cached.fetchedAt < maxAgeMs) {
      return cached.grants;
    }
    let grants = [];
    try {
      grants = await stateStore.listCapabilityGrants({
        subject: cacheKey,
        status: "active",
        limit: 50
      });
    } catch (error) {
      logger.warn?.({ wallet: cacheKey, error: error?.message }, "auth.grant_lookup_failed");
      grants = [];
    }
    grantCache.set(cacheKey, {
      grants: Array.isArray(grants) ? grants : [],
      fetchedAt: nowMs
    });
    return grantCache.get(cacheKey).grants;
  }

  async function expandCapabilities(claims, baseCapabilities, grantMaxAgeMs = GRANT_CACHE_TTL_MS) {
    const subject = String(claims?.sub ?? "").trim();
    if (!subject) return baseCapabilities;
    // Viewer-only authority is immutable for the life of the session. A stale
    // or accidental capability grant must never turn the phone-safe identity
    // into a mutation signer.
    if (isViewerOnlyClaims(claims) || isSubstrateNativeClaims(claims)) return baseCapabilities;
    if (isServiceTokenClaims(claims)) {
      const grantId = String(claims?.capabilityGrantId ?? "").trim();
      if (!grantId || typeof stateStore?.getCapabilityGrant !== "function") {
        return baseCapabilities;
      }
      try {
        const grant = await stateStore.getCapabilityGrant(grantId);
        if (!grant || String(grant.subject ?? "").toLowerCase() !== subject.toLowerCase()) {
          return baseCapabilities;
        }
        if (!isGrantActive(grant, { now })) {
          return baseCapabilities;
        }
        return mergeGrantCapabilities(baseCapabilities, [grant], { now });
      } catch (error) {
        logger.warn?.({ subject, grantId, error: error?.message }, "auth.service_token_grant_lookup_failed");
        return baseCapabilities;
      }
    }
    const grants = await loadActiveGrantsFor(subject, grantMaxAgeMs);
    if (!grants.length) return baseCapabilities;
    return mergeGrantCapabilities(baseCapabilities, grants, { now });
  }

  function invalidateCapabilityGrantCache(subject = undefined) {
    if (subject === undefined || subject === null || String(subject).trim() === "*") {
      grantCache.clear();
      return;
    }
    grantCache.delete(String(subject).trim().toLowerCase());
  }

  async function requireAuth(
    request,
    url,
    {
      allowQueryToken = false,
      requireRole = undefined,
      requireCapability = undefined,
      requireCapabilities = undefined,
      enforceRouteCapabilities = true
    } = {}
  ) {
    const routeCapabilities = enforceRouteCapabilities
      ? getRouteCapabilityRequirements(request.method, url.pathname)
      : [];
    const requiredCapabilities = normalizeRequiredCapabilities([
      ...routeCapabilities,
      requireCapability,
      ...(Array.isArray(requireCapabilities) ? requireCapabilities : [requireCapabilities])
    ]);
    const authDetails = buildAuthRequirementDetails(request.method, url.pathname, {
      requireRole,
      requiredCapabilities
    });
    // B-03 — mutating requests re-check grants on a tighter freshness bound so a
    // cross-process revoke can't keep authorizing a state change for the full 15s.
    const grantMaxAgeMs = isMutatingRequest(request) ? MUTATION_GRANT_CACHE_TTL_MS : GRANT_CACHE_TTL_MS;
    const headerToken = extractBearer(request);
    const queryToken = allowQueryToken ? (url.searchParams.get("token") ?? "").trim() || undefined : undefined;
    const token = headerToken ?? queryToken;

    if (!token) {
      if (authConfig.permissive) {
        const fallbackWallet = (url.searchParams.get("wallet") ?? "").trim();
        if (fallbackWallet) {
          logger.warn?.(
            { method: request.method, path: url.pathname, wallet: fallbackWallet },
            "auth.permissive_fallback"
          );
          const permissiveClaims = {
            sub: fallbackWallet,
            roles: resolveRoles(fallbackWallet, {
              adminWallets: authConfig.adminWallets ?? new Set(),
              verifierWallets: authConfig.verifierWallets ?? new Set(),
              viewerWallets: authConfig.viewerWallets ?? new Set()
            })
          };
          enforceViewerReadOnly(permissiveClaims, request, authDetails);
          const baseCapabilities = resolveCapabilities(permissiveClaims);
          const capabilities = await expandCapabilities(permissiveClaims, baseCapabilities, grantMaxAgeMs);
          enforceRole(permissiveClaims, requireRole, authDetails);
          enforceCapabilities(capabilities, requiredCapabilities, authDetails);
          return {
            wallet: normalizeWallet(fallbackWallet),
            claims: permissiveClaims,
            capabilities,
            capabilityRequirements: requiredCapabilities,
            via: "permissive_query"
          };
        }
      }
      throw new AuthenticationError("Authentication required.", "missing_token", authDetails);
    }

    if (!allowQueryToken && queryToken && !headerToken) {
      logger.warn?.(
        { method: request.method, path: url.pathname },
        "auth.query_token_on_non_sse_route"
      );
    }

    // verifyTokenFromConfig is the Phase 4b dispatcher (PR 4b.4). It
    // routes to the HMAC or KMS backend based on authConfig.jwtBackend
    // and the alg header — under the default JWT_BACKEND=hmac it is
    // byte-for-byte equivalent to the previous verifyToken(secrets)
    // call. ES256 verification is async (it lazy-imports the KMS
    // signer module on first use), so the dispatcher itself returns
    // a Promise — Promise.resolve(claims) for the HMAC path keeps the
    // shape uniform.
    const claims = await verifyTokenFromConfig(token, authConfig);
    if (claims?.tokenKind === ARRIVAL_CANARY_MARKER_TOKEN_KIND) {
      throw new AuthenticationError(
        "Arrival canary markers identify synthetic traffic; they cannot authenticate API requests.",
        "invalid_token_kind"
      );
    }
    if (!claims?.sub) {
      throw new AuthenticationError("Token missing subject claim.", "missing_subject");
    }
    const walletIdentity = resolveClaimsWalletIdentity(claims);

    if (stateStore?.isTokenRevoked && claims.jti) {
      const revoked = await stateStore.isTokenRevoked(claims.jti);
      if (revoked) {
        throw new AuthenticationError("Token has been revoked.", "token_revoked");
      }
    }

    const substrateMapping = await resolveSubstrateMapping({
      claims,
      walletIdentity,
      request,
      pathname: url.pathname,
      substrateMappingGate
    });
    enforceSubstrateNativeMapping(
      claims,
      request,
      url.pathname,
      requiredCapabilities,
      substrateMapping,
      walletIdentity,
      authDetails
    );
    const baseCapabilities = resolveCapabilities(claims, {
      substrateNativeMapped: substrateMapping?.mapped === true
    });
    enforceViewerReadOnly(claims, request, authDetails);
    const capabilities = await expandCapabilities(claims, baseCapabilities, grantMaxAgeMs);
    enforceRole(claims, requireRole, authDetails);
    enforceCapabilities(capabilities, requiredCapabilities, authDetails);

    const wallet = walletIdentity.source === "ss58"
      ? getAddress(walletIdentity.h160)
      : normalizeWallet(claims.sub);
    const arrivalWallet = walletIdentity.h160;
    if (/^0x[0-9a-f]{40}$/u.test(arrivalWallet)) {
      request._arrivalWallet = arrivalWallet;
    }
    return {
      wallet,
      ...(walletIdentity.source === "ss58" ? { walletIdentity } : {}),
      claims,
      capabilities,
      capabilityRequirements: requiredCapabilities,
      ...(substrateMapping ? { substrateMapping } : {}),
      via: headerToken ? "header" : "query_token"
    };
  }

  requireAuth.invalidateCapabilityGrantCache = invalidateCapabilityGrantCache;
  return requireAuth;
}

function isMutatingRequest(request) {
  const method = String(request?.method ?? "").toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function isServiceTokenClaims(claims = {}) {
  return claims?.serviceToken === true || claims?.tokenKind === "service";
}

function enforceRole(claims, requireRole, authDetails = undefined) {
  if (!requireRole) {
    return;
  }
  if (!hasRole(claims, requireRole)) {
    throw new AuthorizationError(`Requires "${requireRole}" role.`, "missing_role", {
      ...(authDetails ?? {}),
      requiresAuth: true,
      requiredRole: requireRole
    });
  }
}

function enforceCapabilities(capabilities, requiredCapabilities, authDetails = undefined) {
  if (!requiredCapabilities.length) {
    return;
  }
  const missing = missingCapabilities(capabilities, requiredCapabilities);
  if (missing.length) {
    throw new AuthorizationError("Missing required capability.", "missing_capability", {
      ...(authDetails ?? {}),
      requiresAuth: true,
      requiredCapabilities,
      missingCapabilities: missing
    });
  }
}

function enforceViewerReadOnly(claims, request, authDetails = undefined) {
  if (!isViewerOnlyClaims(claims) || !isMutatingRequest(request)) return;
  throw new AuthorizationError(
    "Operator viewer sessions are read-only.",
    "missing_capability",
    {
      ...(authDetails ?? {}),
      requiresAuth: true,
      requiredCapabilities: ["mutation:execute"],
      missingCapabilities: ["mutation:execute"],
      denialReason: "viewer_read_only"
    }
  );
}

function enforceSubstrateNativeMapping(
  claims,
  request,
  pathname,
  requiredCapabilities,
  mapping,
  walletIdentity,
  authDetails = undefined
) {
  if (
    !isSubstrateNativeClaims(claims)
    || !isMutatingRequest(request)
    || ["/auth/refresh", "/auth/logout"].includes(pathname)
  ) return;
  if (mapping?.mapped === true) return;
  const unreadable = mapping?.status === "unreadable";
  throw new AuthorizationError(
    unreadable
      ? "This Substrate-native account's pallet_revive mapping could not be read, so earning is refused closed. Retry when Asset Hub is readable; if the account is not mapped, call pallet_revive.map_account first. Its refundable deposit is paid by the account owner, not Averray."
      : "This Substrate-native account is not mapped for earning. Call pallet_revive.map_account first; it requires a refundable deposit paid by the account owner, not Averray, and the deposit is returned on unmap.",
    unreadable ? "substrate_mapping_unreadable" : "substrate_mapping_required",
    {
      ...(authDetails ?? {}),
      requiresAuth: true,
      requiredCapabilities,
      missingCapabilities: missingCapabilities(resolveCapabilities(claims), requiredCapabilities),
      denialReason: unreadable ? "substrate_mapping_unreadable" : "substrate_mapping_required",
      sessionType: "substrate-native",
      access: "read_only",
      earningEnabled: false,
      mapping: {
        status: mapping?.status ?? "unreadable",
        check: "revive.originalAccount",
        reason: mapping?.reason ?? "mapping_unreadable",
        ...(mapping?.failure ? { failure: mapping.failure } : {}),
        remedy: "pallet_revive.map_account",
        deposit: {
          required: true,
          paidBy: "account_owner",
          paidByAverray: false,
          refundableOn: "unmap"
        }
      },
      payout: {
        address: walletIdentity?.h160,
        source: "derived_h160",
        enabled: false
      },
      allowedMeanwhile: ["GET /me", "GET /jobs", "GET /account", "GET /sessions"]
    }
  );
}

async function resolveSubstrateMapping({
  claims,
  walletIdentity,
  request,
  pathname,
  substrateMappingGate
}) {
  if (
    !isSubstrateNativeClaims(claims)
    || (!isMutatingRequest(request) && pathname !== "/auth/session")
    || ["/auth/refresh", "/auth/logout"].includes(pathname)
  ) return undefined;
  if (typeof substrateMappingGate?.check !== "function") {
    return {
      mapped: false,
      mappingRequired: true,
      status: "unreadable",
      reason: "mapping_unreadable",
      failure: "mapping_gate_unavailable",
      h160: walletIdentity?.h160,
      ss58: walletIdentity?.ss58
    };
  }
  return substrateMappingGate.check(walletIdentity);
}

function resolveClaimsWalletIdentity(claims) {
  let subjectIdentity;
  try {
    subjectIdentity = parseWalletIdentity(claims?.sub);
  } catch {
    throw new AuthenticationError("Token subject is not a supported wallet identity.", "claims_mismatch");
  }
  const record = claims?.walletIdentity;
  if (subjectIdentity.source === "h160" && record === undefined) {
    return subjectIdentity;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new AuthenticationError("Token wallet identity claim is missing or malformed.", "claims_mismatch");
  }
  let recordIdentity;
  try {
    recordIdentity = parseWalletIdentity(record.ss58 ?? record.h160);
  } catch {
    throw new AuthenticationError("Token wallet identity claim is missing or malformed.", "claims_mismatch");
  }
  if (
    record.source !== subjectIdentity.source
    || recordIdentity.source !== subjectIdentity.source
    || recordIdentity.h160 !== subjectIdentity.h160
    || record.h160 !== subjectIdentity.h160
    || (subjectIdentity.source === "ss58" && record.ss58 !== claims.sub)
  ) {
    throw new AuthenticationError("Token subject and wallet identity claim do not match.", "claims_mismatch");
  }
  return subjectIdentity;
}

function normalizeRequiredCapabilities(values = []) {
  return [...new Set(
    values
      .flat()
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  )].sort();
}

function extractBearer(request) {
  const header = request.headers?.authorization ?? request.headers?.Authorization;
  if (!header || typeof header !== "string") {
    return undefined;
  }
  const match = header.match(/^Bearer\s+(?<token>\S+)$/u);
  return match?.groups?.token;
}

function normalizeWallet(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return raw;
  }
  if (/^0x[a-fA-F0-9]{40}$/u.test(raw)) {
    try {
      return getAddress(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}
