/**
 * HTTP-layer helpers for the refresh-token cookie flow.
 *
 * Phase 4b.5b per docs/PHASE_4B_KMS_JWT_PLAN.md §8. Kept in a small
 * dedicated module so the parsing + Set-Cookie construction can be
 * exercised in isolation and reused by /auth/verify (initial mint),
 * /auth/refresh (rotation), and /auth/logout (clear).
 *
 * Cookie attributes are fixed per the design doc:
 *   HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh
 *
 * Domain is intentionally NOT set → host-only cookie on api.averray.com
 * (resolved §12 of the design doc).
 */

import {
  REFRESH_COOKIE_NAME,
  DEFAULT_REFRESH_TTL_SECONDS,
} from "./refresh.js";

/**
 * Parse a single cookie value out of a Cookie header. Tolerates extra
 * spaces and other cookies in the same header.
 *
 * @param {string} cookieHeader  The raw value of `request.headers.cookie`.
 * @param {string} name  Cookie name to look up.
 * @returns {string | null}  The cookie's value, or null if not present.
 */
export function parseCookie(cookieHeader, name) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) {
    return null;
  }
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  const target = `${name}=`;
  // Split on `;` because a Cookie header concatenates multiple cookies
  // with `; ` (RFC 6265 §5.4). Trim whitespace per part.
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      // Reject empty values; reject obviously truncated/malformed inputs.
      if (value.length === 0) return null;
      // Cookie values may be quoted per RFC 6265 §4.1.1; strip surrounding
      // double-quotes if present.
      if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
        return value.slice(1, -1);
      }
      return value;
    }
  }
  return null;
}

/**
 * Build a Set-Cookie header value for issuing or rotating a refresh
 * token. The cookie is host-only (no Domain), HttpOnly, Secure,
 * SameSite=Strict, and scoped to Path=/auth/refresh.
 *
 * @param {string} rawToken  The base64url-encoded refresh token.
 * @param {object} [opts]
 * @param {number} [opts.maxAgeSeconds]  Cookie Max-Age (in seconds).
 *   Defaults to DEFAULT_REFRESH_TTL_SECONDS (30 days).
 * @returns {string}  Value to put in the `Set-Cookie` response header.
 */
export function buildSetCookieHeader(rawToken, { maxAgeSeconds = DEFAULT_REFRESH_TTL_SECONDS } = {}) {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    throw new Error("buildSetCookieHeader: rawToken must be a non-empty string");
  }
  // Disallow CR/LF in token (defense-in-depth; CSPRNG output is base64url
  // so this should never trigger, but a corrupted token from elsewhere
  // could enable header injection).
  if (/[\r\n]/.test(rawToken)) {
    throw new Error("buildSetCookieHeader: rawToken contains illegal CRLF");
  }
  const parts = [
    `${REFRESH_COOKIE_NAME}=${rawToken}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/auth/refresh",
    `Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`,
  ];
  return parts.join("; ");
}

/**
 * Build a Set-Cookie header value that immediately clears the refresh
 * cookie. Used by /auth/logout.
 *
 * @returns {string}
 */
export function buildClearCookieHeader() {
  return [
    `${REFRESH_COOKIE_NAME}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/auth/refresh",
    "Max-Age=0",
  ].join("; ");
}

/**
 * Adapter that exposes the state-store's `getRefreshRecord` /
 * `upsertRefreshRecord` methods as the generic `{ get, set }` interface
 * that `refresh.js` expects.
 *
 * Strips the `auth:refresh:` namespace prefix the refresh module
 * embeds in its keys (the state-store backend handles its own
 * namespacing).
 *
 * @param {object} stateStore  The state-store instance.
 * @returns {{ get: (key: string) => Promise<object|null>, set: (key: string, value: object, ttlSeconds: number) => Promise<void> }}
 */
export function makeRefreshStoreAdapter(stateStore) {
  if (!stateStore || typeof stateStore.getRefreshRecord !== "function") {
    throw new Error("makeRefreshStoreAdapter: stateStore missing getRefreshRecord");
  }
  if (typeof stateStore.upsertRefreshRecord !== "function") {
    throw new Error("makeRefreshStoreAdapter: stateStore missing upsertRefreshRecord");
  }
  const PREFIX = "auth:refresh:";
  function hashFromKey(key) {
    if (typeof key !== "string" || !key.startsWith(PREFIX)) {
      throw new Error(`makeRefreshStoreAdapter: expected key to start with ${PREFIX}, got ${key}`);
    }
    return key.slice(PREFIX.length);
  }
  return {
    async get(key) {
      return stateStore.getRefreshRecord(hashFromKey(key));
    },
    async set(key, value, ttlSeconds) {
      return stateStore.upsertRefreshRecord(hashFromKey(key), value, ttlSeconds);
    },
  };
}
