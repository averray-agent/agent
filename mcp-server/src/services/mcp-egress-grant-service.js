import { timingSafeEqual } from "node:crypto";

import { signTokenFromConfig, verifyTokenFromConfig } from "../auth/jwt.js";
import { AuthenticationError, ConfigError, ValidationError } from "../core/errors.js";
import { MCP_FAILURE_SEMANTICS_PROFILE_REF } from "./verification-profile-registry.js";

const ISSUER = "averray:mcp-egress";
const AUDIENCE = "averray:mcp-egress-proxy";
const PURPOSE = "mcp_endpoint_allowlist_v1";
const ROLE = "mcp_egress_grant";

export class McpEgressGrantService {
  constructor({ authConfig, now = () => new Date() } = {}) {
    if (!authConfig) throw new ConfigError("MCP egress grants require the configured JWT signer.");
    this.authConfig = authConfig;
    this.now = now;
  }

  async mint({ runId, profileRef, endpoint, timeoutMs }) {
    const authority = endpointAuthority(endpoint);
    const lifetimeSeconds = Math.ceil(Number(timeoutMs) / 1_000) + 15;
    if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 15 || lifetimeSeconds > 600) {
      throw new ValidationError("MCP egress grant lifetime is outside the bounded profile window.");
    }
    const payload = {
      purpose: PURPOSE,
      runId: String(runId),
      profileRef: String(profileRef),
      authority,
      iss: ISSUER,
      aud: AUDIENCE,
      sub: String(runId).toLowerCase(),
      roles: [ROLE]
    };
    const { token, claims } = await signTokenFromConfig(payload, {
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: payload.sub,
      role: [ROLE],
      expiresInSeconds: lifetimeSeconds
    }, this.authConfig);
    return Object.freeze({ token, authority, expiresAt: new Date(Number(claims.exp) * 1_000).toISOString() });
  }

  async verify({ token, authority, runId, profileRef = MCP_FAILURE_SEMANTICS_PROFILE_REF }) {
    const verified = await this.verifyBoundary({ token, authority });
    for (const [field, value] of Object.entries({ runId: String(runId), profileRef: String(profileRef) })) {
      if (!safeEqual(String(verified[field] ?? ""), value)) {
        throw new AuthenticationError(`MCP egress grant ${field} binding is invalid.`, "mcp_egress_grant_mismatched");
      }
    }
    return verified;
  }

  async verifyBoundary({ token, authority }) {
    let claims;
    try {
      claims = await verifyTokenFromConfig(token, this.authConfig, {
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        expectedRoles: [ROLE]
      });
    } catch {
      throw new AuthenticationError("MCP egress grant signature or lifetime is invalid.", "mcp_egress_grant_invalid");
    }
    const expected = {
      purpose: PURPOSE,
      authority: normalizeAuthority(authority),
      iss: ISSUER,
      aud: AUDIENCE,
      sub: String(claims?.runId ?? "").toLowerCase(),
      profileRef: MCP_FAILURE_SEMANTICS_PROFILE_REF
    };
    for (const [field, value] of Object.entries(expected)) {
      if (!safeEqual(String(claims?.[field] ?? ""), value)) {
        throw new AuthenticationError(`MCP egress grant ${field} binding is invalid.`, "mcp_egress_grant_mismatched");
      }
    }
    if (!String(claims?.runId ?? "").startsWith("verify-") || !safeEqual(String(claims.sub ?? ""), String(claims.runId).toLowerCase())) {
      throw new AuthenticationError("MCP egress grant run binding is invalid.", "mcp_egress_grant_mismatched");
    }
    if (!Array.isArray(claims.roles) || claims.roles.length !== 1 || !safeEqual(String(claims.roles[0]), ROLE)) {
      throw new AuthenticationError("MCP egress grant role binding is invalid.", "mcp_egress_grant_mismatched");
    }
    return Object.freeze({
      allowed: true,
      authority: expected.authority,
      runId: String(claims.runId),
      profileRef: String(claims.profileRef)
    });
  }
}

export function endpointAuthority(endpoint) {
  let parsed;
  try {
    parsed = new URL(String(endpoint));
  } catch {
    throw new ValidationError("MCP endpoint must be an absolute https or wss URL.");
  }
  if (!new Set(["https:", "wss:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
    throw new ValidationError("MCP endpoint must be an absolute https or wss URL without embedded credentials, query values, or fragments.");
  }
  return normalizeAuthority(parsed.host || `${parsed.hostname}:443`);
}

function normalizeAuthority(value) {
  const parsed = new URL(`https://${String(value ?? "")}`);
  if (!parsed.hostname || parsed.username || parsed.password || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new ValidationError("MCP egress authority is invalid.");
  }
  return `${parsed.hostname.toLowerCase()}:${parsed.port || "443"}`;
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
