import { getAddress } from "ethers";
import { AuthenticationError, AuthorizationError } from "../core/errors.js";
import { verifyToken } from "./jwt.js";
import { hasRole, resolveRoles } from "./config.js";
import {
  getRouteCapabilityRequirements,
  missingCapabilities,
  resolveCapabilities
} from "./capabilities.js";
import { buildAuthRequirementDetails } from "../core/discovery-manifest.js";

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
export function createAuthMiddleware({ authConfig, stateStore, logger = console }) {
  return async function requireAuth(
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
              verifierWallets: authConfig.verifierWallets ?? new Set()
            })
          };
          const capabilities = resolveCapabilities(permissiveClaims);
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

    const claims = verifyToken(token, { secrets: authConfig.secrets });
    if (!claims?.sub) {
      throw new AuthenticationError("Token missing subject claim.", "missing_subject");
    }

    if (stateStore?.isTokenRevoked && claims.jti) {
      const revoked = await stateStore.isTokenRevoked(claims.jti);
      if (revoked) {
        throw new AuthenticationError("Token has been revoked.", "token_revoked");
      }
    }

    const capabilities = resolveCapabilities(claims);
    enforceRole(claims, requireRole, authDetails);
    enforceCapabilities(capabilities, requiredCapabilities, authDetails);

    return {
      wallet: normalizeWallet(claims.sub),
      claims,
      capabilities,
      capabilityRequirements: requiredCapabilities,
      via: headerToken ? "header" : "query_token"
    };
  };
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
