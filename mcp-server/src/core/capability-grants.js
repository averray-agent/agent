import { keccak256, toUtf8Bytes } from "ethers";
import { ValidationError } from "./errors.js";

/**
 * Capability grants — operator-issued, scoped delegations of
 * platform capabilities to a subject wallet (a service token, an
 * automation bot, or a co-operator). Modelled after Polkadot's
 * Staking Operator Proxy: a strict subset of the issuer's
 * capabilities, no further delegation, revocable at any time.
 *
 * Grants live in the state store (`capability_grants` bucket) and
 * are merged into a subject's resolved capabilities at request time
 * by the auth middleware. Each grant + revoke writes a mutation
 * receipt so the audit log surfaces every change.
 */

export const GRANT_STATUS = Object.freeze({
  active: "active",
  revoked: "revoked"
});

const RESERVED_GRANT_CAPABILITIES = Object.freeze([
  // A grant cannot extend the grantor's permissions — explicit deny
  // on capability-management capabilities prevents delegation chains.
  "admin:capabilities:read",
  "admin:capabilities:grant",
  "admin:capabilities:revoke"
]);

export function isReservedCapability(capability) {
  return RESERVED_GRANT_CAPABILITIES.includes(String(capability ?? "").trim());
}

/**
 * Stable id for a grant. Hashed from `subject + scope + issuedAt +
 * nonce` so re-issuing a grant with the same shape generates a new
 * id and keeps the audit trail honest. The hash is truncated to 12
 * hex chars — same convention as `dispute-<hex12>`.
 */
export function grantIdForRecord({ subject, scope, issuedAt, nonce }) {
  const seed = [subject, scope ?? "", issuedAt, nonce ?? ""].join("|");
  return `grant-${keccak256(toUtf8Bytes(String(seed))).slice(2, 14)}`;
}

function normalizeWallet(value) {
  const trimmed = String(value ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/u.test(trimmed)) {
    throw new ValidationError("subject must be a 0x-prefixed 40-character wallet address.");
  }
  return trimmed.toLowerCase();
}

function normalizeCapabilityList(value, { knownCapabilities, label = "capabilities" } = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty array of capability strings.`);
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    const capability = String(entry ?? "").trim();
    if (!capability) {
      throw new ValidationError(`${label} entries must be non-empty capability strings.`);
    }
    if (isReservedCapability(capability)) {
      throw new ValidationError(`${label} cannot include capability-management capabilities (${capability}).`);
    }
    if (knownCapabilities && !knownCapabilities.has(capability)) {
      throw new ValidationError(`${label} includes unknown capability "${capability}".`, {
        capability
      });
    }
    if (!seen.has(capability)) {
      seen.add(capability);
      normalized.push(capability);
    }
  }
  return normalized.sort();
}

function normalizeOptionalString(value, label, { maxLength = 200 } = {}) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > maxLength) {
    throw new ValidationError(`${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function normalizeIssuedAt(value) {
  if (value === undefined || value === null || value === "") {
    return new Date().toISOString();
  }
  const t = Date.parse(String(value));
  if (!Number.isFinite(t)) {
    throw new ValidationError("issuedAt must be a valid ISO timestamp.");
  }
  return new Date(t).toISOString();
}

function normalizeExpiresAt(value, { issuedAt }) {
  if (value === undefined || value === null || value === "") return undefined;
  const t = Date.parse(String(value));
  if (!Number.isFinite(t)) {
    throw new ValidationError("expiresAt must be a valid ISO timestamp.");
  }
  if (t <= Date.parse(issuedAt)) {
    throw new ValidationError("expiresAt must be later than issuedAt.");
  }
  return new Date(t).toISOString();
}

/**
 * Build a brand-new grant record from operator input. Validates
 * subject + capability subset + optional expiry, fills in issuedAt
 * and a stable id. Throws `ValidationError` on any malformed field.
 */
export function buildCapabilityGrant(input = {}, { knownCapabilities, issuerWallet, now = () => new Date() } = {}) {
  const subject = normalizeWallet(input.subject);
  const capabilities = normalizeCapabilityList(input.capabilities, { knownCapabilities });
  const scope = normalizeOptionalString(input.scope, "scope", { maxLength: 60 });
  const note = normalizeOptionalString(input.note, "note", { maxLength: 500 });
  const issuedAt = normalizeIssuedAt(input.issuedAt ?? now().toISOString());
  const expiresAt = normalizeExpiresAt(input.expiresAt, { issuedAt });
  const issuedBy = issuerWallet ? normalizeWallet(issuerWallet) : normalizeWallet(input.issuedBy);
  const nonce = String(input.nonce ?? `${issuedAt}-${Math.random().toString(36).slice(2, 10)}`);
  const id = grantIdForRecord({ subject, scope, issuedAt, nonce });
  return {
    id,
    subject,
    capabilities,
    ...(scope ? { scope } : {}),
    ...(note ? { note } : {}),
    issuedBy,
    issuedAt,
    ...(expiresAt ? { expiresAt } : {}),
    status: GRANT_STATUS.active
  };
}

/**
 * Apply a revocation to an existing grant. Idempotent — calling
 * revoke twice is allowed (the second call is a no-op on the
 * record, but the caller still gets a stable receipt).
 */
export function applyRevocation(grant, { revokedBy, revokeNote, now = () => new Date() } = {}) {
  if (!grant || typeof grant !== "object") {
    throw new ValidationError("grant record is required for revocation.");
  }
  if (grant.status === GRANT_STATUS.revoked) {
    return { record: grant, alreadyRevoked: true };
  }
  const note = normalizeOptionalString(revokeNote, "revokeNote", { maxLength: 500 });
  const wallet = revokedBy ? normalizeWallet(revokedBy) : undefined;
  const record = {
    ...grant,
    status: GRANT_STATUS.revoked,
    revokedAt: now().toISOString(),
    ...(wallet ? { revokedBy: wallet } : {}),
    ...(note ? { revokeNote: note } : {})
  };
  return { record, alreadyRevoked: false };
}

/**
 * Treat grants whose `expiresAt` has passed as inactive. Storage
 * keeps them for audit, but middleware should not merge their
 * capabilities into a request.
 */
export function isGrantActive(grant, { now = () => new Date() } = {}) {
  if (!grant || typeof grant !== "object") return false;
  if (grant.status !== GRANT_STATUS.active) return false;
  if (!grant.expiresAt) return true;
  return Date.parse(grant.expiresAt) > now().getTime();
}

/**
 * Merge active, non-expired grants into a base capability list.
 * Used by the middleware to expand a subject's resolved
 * capabilities at request time. Returns a sorted, de-duplicated
 * array.
 */
export function mergeGrantCapabilities(baseCapabilities, grants, options = {}) {
  const merged = new Set(Array.isArray(baseCapabilities) ? baseCapabilities : []);
  if (Array.isArray(grants)) {
    for (const grant of grants) {
      if (!isGrantActive(grant, options)) continue;
      for (const capability of grant.capabilities ?? []) {
        if (typeof capability === "string" && capability && !isReservedCapability(capability)) {
          merged.add(capability);
        }
      }
    }
  }
  return [...merged].sort();
}

/**
 * Public projection of a grant — what we surface in /admin/...
 * responses and audit events. Hides internal-only fields (none
 * today, but keeps the projection a single source of truth).
 */
export function projectGrant(grant) {
  if (!grant || typeof grant !== "object") return undefined;
  return {
    id: grant.id,
    subject: grant.subject,
    capabilities: Array.isArray(grant.capabilities) ? [...grant.capabilities] : [],
    ...(grant.scope ? { scope: grant.scope } : {}),
    ...(grant.note ? { note: grant.note } : {}),
    issuedBy: grant.issuedBy,
    issuedAt: grant.issuedAt,
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    status: grant.status,
    ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
    ...(grant.revokedBy ? { revokedBy: grant.revokedBy } : {}),
    ...(grant.revokeNote ? { revokeNote: grant.revokeNote } : {})
  };
}
