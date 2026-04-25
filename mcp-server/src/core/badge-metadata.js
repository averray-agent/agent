import { keccak256, toUtf8Bytes } from "ethers";

import { NotFoundError, ValidationError } from "./errors.js";
import { hashCanonicalContent } from "./canonical-content.js";
import { extractSubmissionText } from "./submission.js";

/**
 * Sentinel returned in `averray.poster` and `averray.verifier` when the
 * platform does not have authoritative attribution data for the badge
 * (typical for dev/testnet deploys without `DEFAULT_POSTER_ADDRESS` /
 * `DEFAULT_VERIFIER_ADDRESS` set). Consumers MUST treat this value as
 * "unknown" — cross-reference the on-chain `JobCreated` and
 * `Verified` events from the Ponder indexer to get the real
 * addresses. See docs/schemas/agent-badge-v1.md for the full rule.
 *
 * Emitting the zero address is deliberately better than defaulting to
 * the worker's own wallet: the old fallback silently told consumers
 * "you posted and verified your own job", which is flat-out wrong and
 * misleading for any downstream credit or trust scoring.
 */
export const UNKNOWN_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Build + validate Averray agent-badge metadata documents.
 *
 * Source of truth for the shape: docs/schemas/agent-badge-v1.json.
 * This module does NOT load the JSON schema — we keep the check logic
 * in-code for two reasons:
 *   1. The project avoids non-essential deps (no ajv/json-schema).
 *   2. The schema is short and stable; duplicating the checks here makes
 *      the error messages more actionable (`reward.amount must be…`) than
 *      a stock schema-validator stack trace.
 * When the schema changes, update both files in lockstep.
 */

export const BADGE_SCHEMA_VERSION = "v1";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/u;
const UINT_STRING_RE = /^[0-9]+$/u;
const VERIFIER_MODES = new Set(["benchmark", "deterministic", "human_fallback", "github_pr"]);
const LEVEL_MIN = 1;
const LEVEL_MAX = 255;
const NAME_MAX = 140;
const DESCRIPTION_MAX = 1024;

/**
 * Build a schema-compliant metadata document from platform state.
 *
 * The caller passes in the union of session, job, verdict, and reward data
 * already at hand in `verifier-service.js` + `job-catalog-service.js`; the
 * builder fills in defaults (name/description/attributes) so call sites
 * don't have to repeat the string-formatting.
 *
 * @param {object} input
 * @param {string} input.jobId                Logical job id ("starter-coding-001")
 * @param {string} input.chainJobId           bytes32 job id on EscrowCore
 * @param {string} input.sessionId            Per-claim session id
 * @param {string} input.category             Skill category
 * @param {number} input.level                Completion level (1+)
 * @param {string} input.verifierMode         "benchmark" | "deterministic" | "human_fallback" | "github_pr"
 * @param {object} input.reward               { asset, amount, decimals }
 * @param {object} input.claimStake           { asset, amount, decimals }
 * @param {string} input.evidenceHash         bytes32 sha256 of canonical evidence
 * @param {string} input.completedAt          ISO-8601 UTC
 * @param {string} input.worker               0x EVM address
 * @param {string} input.poster               0x EVM address
 * @param {string} input.verifier             0x EVM address
 * @param {string} [input.metadataURI]        Self-reference (optional)
 * @param {string} [input.image]              Badge image URL (optional)
 * @param {string} [input.externalUrl]        Profile page URL override
 * @param {string} [input.publicBaseUrl]      Falls back to external_url = <base>/agents/<worker>
 * @returns {object} metadata document
 */
export function buildBadgeMetadata(input) {
  const {
    jobId,
    chainJobId,
    sessionId,
    category,
    level,
    verifierMode,
    reward,
    claimStake,
    evidenceHash,
    completedAt,
    worker,
    poster,
    verifier,
    metadataURI,
    image,
    externalUrl,
    publicBaseUrl
  } = input;

  const canonicalCategory = String(category ?? "").trim().toLowerCase() || "unknown";
  const canonicalMode = String(verifierMode ?? "").trim().toLowerCase();
  const lvl = Number(level);

  const doc = {
    name: `Averray Agent Badge — ${canonicalCategory} tier ${lvl}`,
    description: `Non-transferable proof that wallet ${worker} successfully completed the ${jobId} job on Averray.`,
    external_url:
      externalUrl ||
      (publicBaseUrl ? `${stripTrailingSlash(publicBaseUrl)}/agents/${worker}` : `https://averray.com/agents/${worker}`),
    attributes: [
      { trait_type: "Category", value: canonicalCategory },
      { trait_type: "Level", value: lvl },
      { trait_type: "Verifier", value: canonicalMode }
    ],
    averray: {
      schemaVersion: BADGE_SCHEMA_VERSION,
      jobId,
      chainJobId,
      sessionId,
      category: canonicalCategory,
      level: lvl,
      verifierMode: canonicalMode,
      reward,
      claimStake,
      evidenceHash,
      completedAt,
      worker,
      poster,
      verifier
    }
  };

  if (image) {
    doc.image = image;
  }
  if (metadataURI) {
    doc.averray.metadataURI = metadataURI;
  }

  // Re-validate before handing back to the caller so we fail fast at the
  // construction site, not when the endpoint serves it.
  validateBadgeMetadata(doc);
  return doc;
}

/**
 * Validate an arbitrary object against the v1 badge metadata schema.
 * Throws `ValidationError` on the first failure with a path-qualified
 * message. Returns the object on success so the call can be used inline:
 *   return respond(200, validateBadgeMetadata(loaded));
 */
export function validateBadgeMetadata(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ValidationError("badge metadata must be a JSON object");
  }

  requireString(doc, "name", { maxLength: NAME_MAX });
  requireString(doc, "description", { maxLength: DESCRIPTION_MAX });
  requireString(doc, "external_url", { urlLike: true });
  if ("image" in doc) {
    requireString(doc, "image", { urlLike: true });
  }
  requireAttributes(doc.attributes);
  requireAverray(doc.averray);

  return doc;
}

function requireAttributes(value) {
  if (!Array.isArray(value)) {
    throw new ValidationError("attributes must be an array");
  }
  value.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ValidationError(`attributes[${idx}] must be an object`);
    }
    if (typeof entry.trait_type !== "string" || entry.trait_type.length === 0) {
      throw new ValidationError(`attributes[${idx}].trait_type must be a non-empty string`);
    }
    if (!("value" in entry)) {
      throw new ValidationError(`attributes[${idx}].value is required`);
    }
  });
}

function requireAverray(averray) {
  if (!averray || typeof averray !== "object" || Array.isArray(averray)) {
    throw new ValidationError("averray namespace must be an object");
  }
  if (averray.schemaVersion !== BADGE_SCHEMA_VERSION) {
    throw new ValidationError(
      `averray.schemaVersion must be "${BADGE_SCHEMA_VERSION}", got: ${JSON.stringify(averray.schemaVersion)}`
    );
  }

  requireString(averray, "jobId", { parent: "averray" });
  requireBytes32(averray, "chainJobId");
  requireString(averray, "sessionId", { parent: "averray" });
  requireString(averray, "category", { parent: "averray" });

  const lvl = averray.level;
  if (!Number.isInteger(lvl) || lvl < LEVEL_MIN || lvl > LEVEL_MAX) {
    throw new ValidationError(`averray.level must be an integer in [${LEVEL_MIN}, ${LEVEL_MAX}], got: ${JSON.stringify(lvl)}`);
  }

  if (!VERIFIER_MODES.has(averray.verifierMode)) {
    throw new ValidationError(
      `averray.verifierMode must be one of ${Array.from(VERIFIER_MODES).join(", ")}; got: ${JSON.stringify(averray.verifierMode)}`
    );
  }

  requireAmount(averray.reward, "averray.reward");
  requireAmount(averray.claimStake, "averray.claimStake");
  requireBytes32(averray, "evidenceHash");
  requireIsoDateTime(averray, "completedAt");
  requireAddress(averray, "worker");
  requireAddress(averray, "poster");
  requireAddress(averray, "verifier");

  if ("metadataURI" in averray) {
    requireString(averray, "metadataURI", { parent: "averray", urlLike: true });
  }

  // Disallow unknown keys in `averray` so producers don't drift the schema
  // without bumping schemaVersion.
  const allowed = new Set([
    "schemaVersion",
    "jobId",
    "chainJobId",
    "sessionId",
    "category",
    "level",
    "verifierMode",
    "reward",
    "claimStake",
    "evidenceHash",
    "completedAt",
    "worker",
    "poster",
    "verifier",
    "metadataURI"
  ]);
  for (const key of Object.keys(averray)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`averray.${key} is not a recognised field for schemaVersion ${BADGE_SCHEMA_VERSION}`);
    }
  }
}

function requireAmount(amount, path) {
  if (!amount || typeof amount !== "object" || Array.isArray(amount)) {
    throw new ValidationError(`${path} must be an object with asset/amount/decimals`);
  }
  if (typeof amount.asset !== "string" || amount.asset.length === 0) {
    throw new ValidationError(`${path}.asset must be a non-empty string`);
  }
  if (typeof amount.amount !== "string" || !UINT_STRING_RE.test(amount.amount)) {
    throw new ValidationError(`${path}.amount must be a stringified non-negative integer`);
  }
  if (!Number.isInteger(amount.decimals) || amount.decimals < 0 || amount.decimals > 30) {
    throw new ValidationError(`${path}.decimals must be an integer in [0, 30]`);
  }
  // `asset`, `amount`, `decimals` only. Reject extras — keeps the surface
  // narrow so downstream consumers can trust the shape.
  const keys = Object.keys(amount);
  for (const k of keys) {
    if (k !== "asset" && k !== "amount" && k !== "decimals") {
      throw new ValidationError(`${path}.${k} is not a recognised amount field`);
    }
  }
}

function requireString(obj, key, { maxLength, urlLike = false, parent } = {}) {
  const path = parent ? `${parent}.${key}` : key;
  const value = obj?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${path} must be a non-empty string`);
  }
  if (maxLength && value.length > maxLength) {
    throw new ValidationError(`${path} must be ≤ ${maxLength} characters`);
  }
  if (urlLike && !/^https?:\/\/|^ipfs:\/\//u.test(value)) {
    throw new ValidationError(`${path} must be an http(s) or ipfs URI`);
  }
}

function requireAddress(obj, key) {
  const path = `averray.${key}`;
  if (!ADDRESS_RE.test(obj?.[key] ?? "")) {
    throw new ValidationError(`${path} must be a 0x-prefixed 20-byte EVM address`);
  }
}

function requireBytes32(obj, key) {
  const path = `averray.${key}`;
  if (!BYTES32_RE.test(obj?.[key] ?? "")) {
    throw new ValidationError(`${path} must be a 0x-prefixed 32-byte hex string`);
  }
}

function requireIsoDateTime(obj, key) {
  const path = `averray.${key}`;
  const value = obj?.[key];
  if (typeof value !== "string") {
    throw new ValidationError(`${path} must be an ISO-8601 string`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ValidationError(`${path} must be a valid ISO-8601 date, got: ${value}`);
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

/**
 * Adapt the in-memory platform state into a badge metadata document.
 *
 * This is the bridge between what our state store actually persists and
 * the schema's required fields. Several fields are not persisted at the
 * session level today (real on-chain evidenceHash, authoritative poster +
 * verifier addresses); we synthesise deterministic placeholders for them
 * and document the limitation. Consumers that need the authoritative
 * values should read the BadgeMinted / JobCreated / Verified events from
 * the chain or the Ponder indexer — per the schema doc, the metadata
 * body is descriptive, not authoritative.
 *
 * Throws NotFoundError if the session is missing or not a terminal-
 * approved completion (no badge exists yet).
 * Throws ValidationError if the state is inconsistent and can't produce
 * a schema-valid document.
 *
 * @param {object} params
 * @param {object} params.session                 Session object from the state store
 * @param {object} params.job                     Canonical job definition
 * @param {object} [params.verification]          Verification result, if any
 * @param {object} [params.context]               { publicBaseUrl, posterAddress, verifierAddress, image }
 */
export function buildBadgeFromSession({ session, job, verification, context = {} }) {
  if (!session) {
    throw new NotFoundError("Unknown session.", "session_not_found");
  }
  if (!job) {
    throw new NotFoundError(`Unknown job definition for session ${session.sessionId}.`, "job_not_found");
  }
  if (verification?.outcome !== "approved" && session.status !== "resolved") {
    throw new NotFoundError(
      `No badge for session ${session.sessionId}: outcome=${verification?.outcome ?? "pending"} status=${session.status ?? "pending"}.`,
      "badge_not_ready"
    );
  }

  const decimals = Number.isInteger(job.rewardDecimals) ? job.rewardDecimals : 18;
  const rewardBase = toBaseUnits(job.rewardAmount, decimals);
  const stakeBase = toBaseUnits(session.claimStake, decimals);
  const publicBaseUrl = context.publicBaseUrl ?? undefined;
  const selfUrl = publicBaseUrl
    ? `${stripTrailingSlash(publicBaseUrl)}/badges/${encodeURIComponent(session.sessionId)}`
    : undefined;
  const evidenceHash = deriveEvidenceHash(session);
  const chainJobId = normaliseChainJobId(session);

  return buildBadgeMetadata({
    jobId: session.jobId,
    chainJobId,
    sessionId: session.sessionId,
    category: job.category,
    level: inferLevel(job),
    verifierMode: job.verifierMode,
    reward: { asset: job.rewardAsset ?? "DOT", amount: rewardBase, decimals },
    claimStake: { asset: job.rewardAsset ?? "DOT", amount: stakeBase, decimals },
    evidenceHash,
    completedAt: new Date(session.updatedAt ?? Date.now()).toISOString(),
    worker: requireLowerAddress(session.wallet, "session.wallet"),
    // Attribution fallbacks: when the operator hasn't wired authoritative
    // poster/verifier addresses via context (or env DEFAULT_POSTER_ADDRESS
    // / DEFAULT_VERIFIER_ADDRESS), emit the zero address so consumers
    // recognise the field as "unknown, read the chain events" rather than
    // being misled into thinking the worker posted + verified their own
    // job. See UNKNOWN_ADDRESS docs above.
    poster: requireLowerAddress(context.posterAddress ?? UNKNOWN_ADDRESS, "context.posterAddress"),
    verifier: requireLowerAddress(context.verifierAddress ?? UNKNOWN_ADDRESS, "context.verifierAddress"),
    metadataURI: selfUrl,
    image: context.image,
    publicBaseUrl
  });
}

function deriveEvidenceHash(session) {
  const submitted = extractSubmissionText(session.submission);
  const input = submitted || `averray:badge:${session.sessionId}|${session.wallet}|${session.updatedAt ?? ""}`;
  return hashCanonicalContent(input);
}

function normaliseChainJobId(session) {
  const raw = session.chainJobId ?? session.jobId;
  if (typeof raw === "string" && /^0x[a-fA-F0-9]{64}$/u.test(raw)) {
    return raw;
  }
  return keccak256(toUtf8Bytes(`averray:jobId:${raw ?? session.jobId}`));
}

function inferLevel(job) {
  // level corresponds to the highest settlement stage achieved:
  //   single-payout approved → 1
  //   milestone job approved  → 2
  // Future levels reserved for multi-stage credentials.
  return job?.payoutMode === "milestone" ? 2 : 1;
}

function requireLowerAddress(raw, label) {
  if (typeof raw !== "string" || !/^0x[a-fA-F0-9]{40}$/u.test(raw)) {
    throw new ValidationError(`${label} must be a 0x-prefixed EVM address; got ${JSON.stringify(raw)}`);
  }
  return raw.toLowerCase();
}

function toBaseUnits(amount, decimals) {
  // The platform stores reward amounts as plain numbers (5, 25) meaning
  // "5 DOT". The schema requires integer base units. Multiply by
  // 10**decimals using BigInt to avoid float drift on 18-decimal assets.
  if (amount === undefined || amount === null || amount === "") {
    return "0";
  }
  const asString = typeof amount === "string" ? amount : String(amount);
  const [whole, fraction = ""] = asString.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/u, "");
  if (!/^[0-9]+$/u.test(combined)) {
    throw new ValidationError(`amount must be numeric; got ${asString}`);
  }
  return combined;
}
