import { getAddress } from "ethers";
import { AuthenticationError, AuthorizationError } from "../core/errors.js";
import { verifyToken } from "./jwt.js";
import { hasRole, resolveRoles } from "./config.js";

/**
 * Create an auth middleware bound to a specific auth configuration.
 *
 * Returns a `requireAuth(request, url, options)` function that extracts and
 * verifies a token, returning `{ wallet, claims, via }`.
 *
 * Options:
 *   - allowQueryToken: accept ?token= in the URL (used for SSE where headers are unavailable).
 *   - requireRole: throw AuthorizationError unless the verified claims include this role.
 *
 * In permissive mode, if no token is supplied, the middleware falls back to the
 * `wallet` query parameter with a warning. In strict mode, missing or invalid
 * tokens always throw `AuthenticationError`. Role enforcement is checked in
 * both modes — permissive fallback wallets are resolved against
 * `authConfig.adminWallets` / `authConfig.verifierWallets` to avoid locking
 * admins out of local dev.
 */
export function createAuthMiddleware({ authConfig, logger = console }) {
  return async function requireAuth(request, url, { allowQueryToken = false, requireRole = undefined } = {}) {
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
          enforceRole(permissiveClaims, requireRole);
          return {
            wallet: normalizeWallet(fallbackWallet),
            claims: permissiveClaims,
            via: "permissive_query"
          };
        }
      }
      throw new AuthenticationError("Authentication required.", "missing_token");
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

    enforceRole(claims, requireRole);

    return {
      wallet: normalizeWallet(claims.sub),
      claims,
      via: headerToken ? "header" : "query_token"
    };
  };
}

function enforceRole(claims, requireRole) {
  if (!requireRole) {
    return;
  }
  if (!hasRole(claims, requireRole)) {
    throw new AuthorizationError(`Requires "${requireRole}" role.`, "missing_role");
  }
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
