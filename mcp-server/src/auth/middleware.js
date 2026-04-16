import { getAddress } from "ethers";
import { AuthenticationError } from "../core/errors.js";
import { verifyToken } from "./jwt.js";

/**
 * Create an auth middleware bound to a specific auth configuration.
 *
 * Returns a `requireAuth(request, url, options)` function that extracts and
 * verifies a token, returning `{ wallet, claims, via }`.
 *
 * Options:
 *   - allowQueryToken: accept ?token= in the URL (used for SSE where headers are unavailable).
 *
 * In permissive mode, if no token is supplied, the middleware falls back to the
 * `wallet` query parameter with a warning. In strict mode, missing or invalid
 * tokens always throw `AuthenticationError`.
 */
export function createAuthMiddleware({ authConfig, logger = console }) {
  return async function requireAuth(request, url, { allowQueryToken = false } = {}) {
    const headerToken = extractBearer(request);
    const queryToken = allowQueryToken ? (url.searchParams.get("token") ?? "").trim() || undefined : undefined;
    const token = headerToken ?? queryToken;

    if (!token) {
      if (authConfig.permissive) {
        const fallbackWallet = (url.searchParams.get("wallet") ?? "").trim();
        if (fallbackWallet) {
          logger.warn?.(
            `[auth] permissive-mode fallback: accepting ?wallet= for ${request.method} ${url.pathname}`
          );
          return {
            wallet: normalizeWallet(fallbackWallet),
            claims: undefined,
            via: "permissive_query"
          };
        }
      }
      throw new AuthenticationError("Authentication required.", "missing_token");
    }

    if (!allowQueryToken && queryToken && !headerToken) {
      logger.warn?.(
        `[auth] token supplied via query param on non-SSE route ${request.method} ${url.pathname}; prefer Authorization header.`
      );
    }

    const claims = verifyToken(token, { secrets: authConfig.secrets });
    if (!claims?.sub) {
      throw new AuthenticationError("Token missing subject claim.", "missing_subject");
    }

    return {
      wallet: normalizeWallet(claims.sub),
      claims,
      via: headerToken ? "header" : "query_token"
    };
  };
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
