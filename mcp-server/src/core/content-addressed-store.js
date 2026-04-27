import { hashCanonicalContent } from "./canonical-content.js";
import { AuthorizationError, ValidationError } from "./errors.js";

export const DEFAULT_AUTO_PUBLIC_DAYS = 180;

const HEX_32 = /^0x[a-fA-F0-9]{64}$/u;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/u;

export function buildContentRecord({
  payload,
  contentType = "submission",
  ownerWallet,
  verdict = null,
  createdAt = new Date().toISOString(),
  publishedAt = undefined,
  autoPublicAt = undefined
} = {}) {
  if (payload === undefined) {
    throw new ValidationError("payload is required.");
  }
  const normalizedType = normalizeContentType(contentType);
  const normalizedOwner = normalizeOwnerWallet(ownerWallet);
  const normalizedVerdict = normalizeVerdict(verdict);
  const normalizedCreatedAt = normalizeIsoTimestamp(createdAt, "createdAt");
  const normalizedPublishedAt = publishedAt === undefined || publishedAt === null || publishedAt === ""
    ? undefined
    : normalizeIsoTimestamp(publishedAt, "publishedAt");
  const normalizedAutoPublicAt = autoPublicAt === undefined || autoPublicAt === null || autoPublicAt === ""
    ? defaultAutoPublicAt(normalizedCreatedAt)
    : normalizeIsoTimestamp(autoPublicAt, "autoPublicAt");

  return {
    hash: hashCanonicalContent(payload).toLowerCase(),
    payload,
    contentType: normalizedType,
    ownerWallet: normalizedOwner,
    verdict: normalizedVerdict,
    createdAt: normalizedCreatedAt,
    publishedAt: normalizedPublishedAt,
    autoPublicAt: normalizedAutoPublicAt
  };
}

export function normalizeContentHash(hash) {
  if (typeof hash !== "string" || !HEX_32.test(hash.trim())) {
    throw new ValidationError("content hash must be a 0x-prefixed 32-byte hex value.");
  }
  return hash.trim().toLowerCase();
}

export function assertContentHashMatches(record) {
  const expected = hashCanonicalContent(record?.payload).toLowerCase();
  const actual = normalizeContentHash(record?.hash);
  if (actual !== expected) {
    throw new ValidationError("content hash does not match canonical payload.", { expected, actual });
  }
  return true;
}

export function resolveContentAccess(record, auth = undefined, { now = new Date() } = {}) {
  if (!record) {
    return { allowed: false, public: false, reason: "missing" };
  }
  const publicContent = isPublicContent(record, now);
  const owner = Boolean(auth?.wallet && sameWallet(auth.wallet, record.ownerWallet));
  const admin = hasRole(auth, "admin");
  const allowed = publicContent || owner || admin;
  return {
    allowed,
    public: publicContent,
    owner,
    admin,
    reason: allowed ? "allowed" : "private"
  };
}

export function requireContentAccess(record, auth = undefined, options = {}) {
  const access = resolveContentAccess(record, auth, options);
  if (!access.allowed) {
    throw new AuthorizationError("Content is not public yet and does not belong to the authenticated wallet.", "content_private");
  }
  return access;
}

export function publicContentHeaders(record, access, { now = new Date() } = {}) {
  if (access?.public) {
    return { "cache-control": "public, max-age=31536000, immutable" };
  }
  const autoPublicAt = Date.parse(record?.autoPublicAt ?? "");
  if (Number.isFinite(autoPublicAt) && autoPublicAt > now.getTime()) {
    const seconds = Math.max(0, Math.min(Math.floor((autoPublicAt - now.getTime()) / 1000), 3600));
    return { "cache-control": `private, max-age=${seconds}` };
  }
  return { "cache-control": "private, no-store" };
}

export function contentResponse(record, access) {
  return {
    hash: record.hash,
    contentType: record.contentType,
    ownerWallet: record.ownerWallet,
    verdict: record.verdict,
    createdAt: record.createdAt,
    publishedAt: record.publishedAt,
    autoPublicAt: record.autoPublicAt,
    visibility: access?.public ? "public" : "owner_only",
    payload: record.payload
  };
}

export function defaultAutoPublicAt(createdAt = new Date().toISOString()) {
  const base = new Date(normalizeIsoTimestamp(createdAt, "createdAt"));
  base.setUTCDate(base.getUTCDate() + DEFAULT_AUTO_PUBLIC_DAYS);
  return base.toISOString();
}

function isPublicContent(record, now) {
  if (record.contentType === "job_spec") return true;
  if (record.publishedAt) return true;
  const autoPublicAt = Date.parse(record.autoPublicAt ?? "");
  if (Number.isFinite(autoPublicAt) && autoPublicAt <= now.getTime()) return true;
  return record.verdict === "pass";
}

function normalizeContentType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_:-]{1,63}$/u.test(type)) {
    throw new ValidationError("contentType must be a stable lowercase identifier.");
  }
  return type;
}

function normalizeOwnerWallet(value) {
  const wallet = String(value ?? "").trim();
  if (!ADDRESS.test(wallet)) {
    throw new ValidationError("ownerWallet must be a 0x-prefixed 20-byte address.");
  }
  return wallet.toLowerCase();
}

function normalizeVerdict(value) {
  if (value === undefined || value === null || value === "") return null;
  const verdict = String(value).trim().toLowerCase();
  if (!["pass", "fail"].includes(verdict)) {
    throw new ValidationError("verdict must be pass or fail when provided.");
  }
  return verdict;
}

function normalizeIsoTimestamp(value, label) {
  const text = String(value ?? "").trim();
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${label} must be an ISO timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function sameWallet(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function hasRole(auth, role) {
  return Array.isArray(auth?.claims?.roles) && auth.claims.roles.includes(role);
}
