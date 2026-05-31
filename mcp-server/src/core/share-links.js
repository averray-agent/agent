import { createHmac, timingSafeEqual } from "node:crypto";
import { ValidationError, AuthorizationError } from "./errors.js";

export const SHARE_TOKEN_VERSION = 1;
export const DEFAULT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

export const SHARE_SURFACES = Object.freeze({
  agent: "agent",
  session: "session",
  dispute: "dispute",
  policy: "policy"
});

const SURFACE_ALIASES = new Map([
  ["agent", SHARE_SURFACES.agent],
  ["agent_profile", SHARE_SURFACES.agent],
  ["profile", SHARE_SURFACES.agent],
  ["session", SHARE_SURFACES.session],
  ["session_audit", SHARE_SURFACES.session],
  ["audit_trail", SHARE_SURFACES.session],
  ["dispute", SHARE_SURFACES.dispute],
  ["dispute_snapshot", SHARE_SURFACES.dispute],
  ["policy", SHARE_SURFACES.policy],
  ["policy_snapshot", SHARE_SURFACES.policy]
]);

export function normalizeShareSurface(value) {
  const surface = SURFACE_ALIASES.get(String(value ?? "").trim().toLowerCase());
  if (!surface) {
    throw new ValidationError("share surface must be agent, session, dispute, or policy.");
  }
  return surface;
}

export function normalizeShareId(value) {
  const id = String(value ?? "").trim();
  if (!id) {
    throw new ValidationError("share id is required.");
  }
  if (id.includes("\n") || id.includes("\r")) {
    throw new ValidationError("share id must be a single line.");
  }
  if (id.length > 240) {
    throw new ValidationError("share id is too long.");
  }
  return id;
}

export function normalizeShareTtlSeconds(value, fallback = DEFAULT_SHARE_TTL_SECONDS) {
  const raw = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new ValidationError("ttlSeconds must be a positive number.");
  }
  return Math.min(Math.trunc(raw), MAX_SHARE_TTL_SECONDS);
}

export function resolveShareSecret({ explicitSecret, authConfig, env = process.env } = {}) {
  const secret = String(
    explicitSecret ??
      env.SHARE_URL_SECRET ??
      authConfig?.signingSecret ??
      ""
  ).trim();
  if (secret.length >= 32) {
    return secret;
  }
  if (env.NODE_ENV === "production" || authConfig?.strict) {
    throw new AuthorizationError("Share URL signing secret is not configured.", "share_secret_missing");
  }
  return "development-share-url-secret-not-for-production";
}

export function issueShareToken({
  surface,
  id,
  secret,
  ttlSeconds = DEFAULT_SHARE_TTL_SECONDS,
  now = new Date()
}) {
  const issuedAt = new Date(now);
  if (!Number.isFinite(issuedAt.getTime())) {
    throw new ValidationError("share issue time must be a valid date.");
  }
  const payload = {
    v: SHARE_TOKEN_VERSION,
    surface: normalizeShareSurface(surface),
    id: normalizeShareId(id),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + normalizeShareTtlSeconds(ttlSeconds) * 1000).toISOString()
  };
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(body, secret);
  return {
    token: `${body}.${signature}`,
    payload
  };
}

export function verifyShareToken(token, { secret, now = new Date() }) {
  const raw = String(token ?? "").trim();
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ValidationError("share token is malformed.");
  }
  const [body, signature] = parts;
  const expected = sign(body, secret);
  if (!safeEqual(signature, expected)) {
    throw new AuthorizationError("Share token signature is invalid.", "invalid_share_token");
  }
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString("utf8"));
  } catch {
    throw new ValidationError("share token payload is malformed.");
  }
  const normalized = {
    v: Number(payload?.v),
    surface: normalizeShareSurface(payload?.surface),
    id: normalizeShareId(payload?.id),
    issuedAt: requireIso(payload?.issuedAt, "issuedAt"),
    expiresAt: requireIso(payload?.expiresAt, "expiresAt")
  };
  if (normalized.v !== SHARE_TOKEN_VERSION) {
    throw new ValidationError("share token version is unsupported.");
  }
  const nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime())) {
    throw new ValidationError("share verification time must be a valid date.");
  }
  if (Date.parse(normalized.expiresAt) <= nowDate.getTime()) {
    throw new AuthorizationError("Share token has expired.", "share_token_expired");
  }
  return normalized;
}

function requireIso(value, path) {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new ValidationError(`share token ${path} must be an ISO-8601 date/time.`);
  }
  return new Date(Date.parse(raw)).toISOString();
}

function sign(body, secret) {
  return createHmac("sha256", resolveShareSecret({ explicitSecret: secret }))
    .update(body)
    .digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url");
}
