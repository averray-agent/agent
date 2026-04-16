import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AuthenticationError, ConfigError } from "../core/errors.js";

const HEADER = { alg: "HS256", typ: "JWT" };
const CLOCK_SKEW_SECONDS = 60;

/**
 * Minimal JWT (HS256) implementation — no external dependency.
 *
 * Supports key rotation: pass an array of secrets; `verifyToken` accepts any,
 * `signToken` always uses the first (newest).
 */

export function signToken(payload, { secret, expiresInSeconds }) {
  if (!secret) {
    throw new ConfigError("JWT signing secret missing.");
  }
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new ConfigError("expiresInSeconds must be a positive integer.");
  }

  const now = nowSeconds();
  const fullPayload = {
    jti: randomUUID(),
    iat: now,
    exp: now + expiresInSeconds,
    ...payload
  };

  const headerPart = base64UrlEncode(JSON.stringify(HEADER));
  const payloadPart = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = sign(signingInput, secret);

  return {
    token: `${signingInput}.${signature}`,
    claims: fullPayload
  };
}

export function verifyToken(token, { secrets }) {
  if (!secrets || secrets.length === 0) {
    throw new ConfigError("At least one JWT secret is required for verification.");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new AuthenticationError("Missing token.", "missing_token");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthenticationError("Malformed token.", "malformed_token");
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const signingInput = `${headerPart}.${payloadPart}`;

  let header;
  try {
    header = JSON.parse(base64UrlDecode(headerPart).toString("utf8"));
  } catch {
    throw new AuthenticationError("Invalid token header.", "malformed_token");
  }
  if (header?.alg !== "HS256" || header?.typ !== "JWT") {
    throw new AuthenticationError("Unsupported token algorithm.", "unsupported_alg");
  }

  const matches = secrets.some((secret) => constantTimeEquals(sign(signingInput, secret), signaturePart));
  if (!matches) {
    throw new AuthenticationError("Token signature mismatch.", "bad_signature");
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8"));
  } catch {
    throw new AuthenticationError("Invalid token payload.", "malformed_token");
  }

  const now = nowSeconds();
  if (typeof payload.iat === "number" && payload.iat > now + CLOCK_SKEW_SECONDS) {
    throw new AuthenticationError("Token issued in the future.", "token_iat_future");
  }
  if (typeof payload.exp === "number" && payload.exp + CLOCK_SKEW_SECONDS < now) {
    throw new AuthenticationError("Token expired.", "token_expired");
  }

  return payload;
}

function sign(input, secret) {
  return base64UrlEncode(createHmac("sha256", secret).update(input).digest());
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buffer.toString("base64").replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function base64UrlDecode(input) {
  const padded = input.replace(/-/gu, "+").replace(/_/gu, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
