import { keccak256, toUtf8Bytes } from "ethers";

import { NotFoundError, ValidationError } from "./errors.js";
import { hashCanonicalContent } from "./canonical-content.js";
import {
  DEFAULT_ESCROW_ASSET_SYMBOL,
  decimalsForAssetSymbol
} from "./assets.js";
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
const ZERO_ADDRESS_RE = /^0x0{40}$/u;
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/u;
const UINT_STRING_RE = /^[0-9]+$/u;
const VERIFIER_MODES = new Set(["benchmark", "deterministic", "human_fallback", "github_pr"]);
const SIGNER_ROLES = new Set(["operator", "verifier", "worker"]);
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
 * @param {Array<object>} [input.signers]     Optional real signer chain entries ({ role, wallet, at, status? })
 * @param {string} [input.metadataURI]        Self-reference (optional)
 * @param {string} [input.image]              Badge image URL (optional)
 * @param {string} [input.externalUrl]        Profile page URL override
 * @param {string} [input.publicBaseUrl]      Falls back to external_url = <base>/agents/<worker>
 * @param {object} [input.lineage]            Optional sub-contracting lineage:
 *                                            { parent?: { sessionId, jobId, wallet },
 *                                              children?: { count, jobIds?, sessionIds? } }
 *                                            See docs/schemas/agent-badge-v1.md and
 *                                            CORE_FRAMEWORK_ROADMAP §8 for the rule.
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
    signers,
    metadataURI,
    image,
    externalUrl,
    publicBaseUrl,
    lineage
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
  const normalizedSigners = normalizeBadgeSigners(signers);
  if (normalizedSigners.length > 0) {
    doc.signers = normalizedSigners;
  }
  const normalizedLineage = normalizeBadgeLineage(lineage);
  if (normalizedLineage) {
    doc.averray.lineage = normalizedLineage;
  }

  // Re-validate before handing back to the caller so we fail fast at the
  // construction site, not when the endpoint serves it.
  validateBadgeMetadata(doc);
  return doc;
}

/**
 * Strip noise / canonicalise the lineage block so only the keys we
 * accept survive. Returns `undefined` when nothing meaningful is
 * left, so the badge omits the lineage field entirely (the schema
 * treats lineage as optional rather than empty).
 */
function normalizeBadgeLineage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const lineage = {};
  if (raw.parent && typeof raw.parent === "object" && !Array.isArray(raw.parent)) {
    const parent = {};
    if (typeof raw.parent.sessionId === "string" && raw.parent.sessionId) {
      parent.sessionId = raw.parent.sessionId;
    }
    if (typeof raw.parent.jobId === "string" && raw.parent.jobId) {
      parent.jobId = raw.parent.jobId;
    }
    if (typeof raw.parent.wallet === "string" && ADDRESS_RE.test(raw.parent.wallet)) {
      parent.wallet = raw.parent.wallet.toLowerCase();
    }
    if (Object.keys(parent).length > 0) {
      lineage.parent = parent;
    }
  }
  if (raw.children && typeof raw.children === "object" && !Array.isArray(raw.children)) {
    const children = {};
    const count = Number(raw.children.count);
    if (Number.isFinite(count) && count >= 0) {
      children.count = Math.floor(count);
    }
    if (Array.isArray(raw.children.jobIds)) {
      const jobIds = raw.children.jobIds.filter((id) => typeof id === "string" && id);
      if (jobIds.length > 0) children.jobIds = jobIds;
    }
    if (Array.isArray(raw.children.sessionIds)) {
      const sessionIds = raw.children.sessionIds.filter((id) => typeof id === "string" && id);
      if (sessionIds.length > 0) children.sessionIds = sessionIds;
    }
    if (Object.keys(children).length > 0) {
      // If a count wasn't supplied, derive it from the lists so the
      // surface always carries an explicit "how many" value.
      if (children.count === undefined && Array.isArray(children.jobIds)) {
        children.count = children.jobIds.length;
      }
      lineage.children = children;
    }
  }
  return Object.keys(lineage).length > 0 ? lineage : undefined;
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
  if ("signers" in doc) {
    validateBadgeSigners(doc.signers);
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

  if ("lineage" in averray) {
    validateLineage(averray.lineage);
  }

  // Disallow unknown keys in `averray` so producers don't drift the schema
  // without bumping schemaVersion. `lineage` was added under v1 as a
  // purely-additive field — see docs/schemas/agent-badge-v1.md and
  // CORE_FRAMEWORK_ROADMAP §8.
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
    "metadataURI",
    "lineage"
  ]);
  for (const key of Object.keys(averray)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`averray.${key} is not a recognised field for schemaVersion ${BADGE_SCHEMA_VERSION}`);
    }
  }
}

function validateLineage(lineage) {
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) {
    throw new ValidationError("averray.lineage must be an object");
  }
  const allowed = new Set(["parent", "children"]);
  for (const key of Object.keys(lineage)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`averray.lineage.${key} is not a recognised lineage field`);
    }
  }
  if ("parent" in lineage) {
    const parent = lineage.parent;
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      throw new ValidationError("averray.lineage.parent must be an object");
    }
    const parentAllowed = new Set(["sessionId", "jobId", "wallet"]);
    for (const key of Object.keys(parent)) {
      if (!parentAllowed.has(key)) {
        throw new ValidationError(`averray.lineage.parent.${key} is not a recognised parent field`);
      }
    }
    if ("sessionId" in parent) {
      requireString(parent, "sessionId", { parent: "averray.lineage.parent" });
    }
    if ("jobId" in parent) {
      requireString(parent, "jobId", { parent: "averray.lineage.parent" });
    }
    if ("wallet" in parent && !ADDRESS_RE.test(parent.wallet ?? "")) {
      throw new ValidationError("averray.lineage.parent.wallet must be a 0x-prefixed 20-byte EVM address");
    }
  }
  if ("children" in lineage) {
    const children = lineage.children;
    if (!children || typeof children !== "object" || Array.isArray(children)) {
      throw new ValidationError("averray.lineage.children must be an object");
    }
    const childrenAllowed = new Set(["count", "jobIds", "sessionIds"]);
    for (const key of Object.keys(children)) {
      if (!childrenAllowed.has(key)) {
        throw new ValidationError(`averray.lineage.children.${key} is not a recognised children field`);
      }
    }
    if (!Number.isInteger(children.count) || children.count < 0) {
      throw new ValidationError("averray.lineage.children.count must be a non-negative integer");
    }
    if ("jobIds" in children) {
      if (!Array.isArray(children.jobIds)) {
        throw new ValidationError("averray.lineage.children.jobIds must be an array of strings");
      }
      for (const id of children.jobIds) {
        if (typeof id !== "string" || id.length === 0) {
          throw new ValidationError("averray.lineage.children.jobIds entries must be non-empty strings");
        }
      }
    }
    if ("sessionIds" in children) {
      if (!Array.isArray(children.sessionIds)) {
        throw new ValidationError("averray.lineage.children.sessionIds must be an array of strings");
      }
      for (const id of children.sessionIds) {
        if (typeof id !== "string" || id.length === 0) {
          throw new ValidationError("averray.lineage.children.sessionIds entries must be non-empty strings");
        }
      }
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

export function buildBadgeSigners({ session, verification, context = {} } = {}) {
  return normalizeBadgeSigners([
    {
      role: "operator",
      status: "posted",
      wallet: context.posterAddress,
      at: session?.claimedAt
    },
    {
      role: "verifier",
      status: "signed",
      wallet: verification?.verifier ?? verification?.signer ?? context.verifierAddress,
      at: verification?.resolvedAt ?? verification?.session?.resolvedAt ?? session?.resolvedAt
    },
    {
      role: "worker",
      status: "submitted",
      wallet: session?.wallet,
      at: session?.submittedAt
    }
  ]);
}

function normalizeBadgeSigners(signers) {
  if (!Array.isArray(signers)) return [];
  return signers
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const role = typeof entry.role === "string" ? entry.role.trim().toLowerCase() : "";
      const wallet = normalizeRealAddress(entry.wallet ?? entry.address);
      const at = normalizeIso(entry.at ?? entry.signedAt);
      if (!SIGNER_ROLES.has(role) || !wallet || !at) return null;
      const normalized = { role, wallet, at };
      if (typeof entry.status === "string" && entry.status.trim()) {
        normalized.status = entry.status.trim();
      }
      return normalized;
    })
    .filter(Boolean);
}

function validateBadgeSigners(signers) {
  if (!Array.isArray(signers)) {
    throw new ValidationError("signers must be an array");
  }
  signers.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ValidationError(`signers[${idx}] must be an object`);
    }
    if (!SIGNER_ROLES.has(entry.role)) {
      throw new ValidationError(`signers[${idx}].role must be one of ${Array.from(SIGNER_ROLES).join(", ")}`);
    }
    if (!normalizeRealAddress(entry.wallet)) {
      throw new ValidationError(`signers[${idx}].wallet must be a real 0x-prefixed 20-byte EVM address`);
    }
    if (!normalizeIso(entry.at)) {
      throw new ValidationError(`signers[${idx}].at must be a valid ISO-8601 date`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== "role" && key !== "wallet" && key !== "at" && key !== "status") {
        throw new ValidationError(`signers[${idx}].${key} is not a recognised signer field`);
      }
    }
  });
}

function normalizeRealAddress(raw) {
  if (typeof raw !== "string" || !ADDRESS_RE.test(raw)) return "";
  const lowered = raw.toLowerCase();
  return ZERO_ADDRESS_RE.test(lowered) ? "" : lowered;
}

function normalizeIso(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
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
 * @param {object} [params.job]                   Canonical job definition, when still retained
 * @param {object} [params.verification]          Verification result, if any. Session/verdict
 *                                                 snapshots supply badge facts after job pruning.
 * @param {object} [params.context]               { publicBaseUrl, posterAddress, verifierAddress, image, lineage }
 *                                                 `context.lineage` (optional) is the slim
 *                                                 sub-contracting block: `{ parent?, children? }`.
 *                                                 The HTTP layer assembles it by walking
 *                                                 `job.parentSessionId` (parent) and
 *                                                 `listJobsByParentSession(session.sessionId)`
 *                                                 (children) so this builder doesn't need
 *                                                 to reach into the catalog. Roadmap §8.
 */
export function buildBadgeFromSession({ session, job = undefined, verification, context = {} }) {
  if (!session) {
    throw new NotFoundError("Unknown session.", "session_not_found");
  }
  if (verification?.outcome !== "approved" && session.status !== "resolved") {
    throw new NotFoundError(
      `No badge for session ${session.sessionId}: outcome=${verification?.outcome ?? "pending"} status=${session.status ?? "pending"}.`,
      "badge_not_ready"
    );
  }

  const badgeFacts = resolveBadgeFacts({ session, job, verification });
  const rewardAsset = badgeFacts.rewardAsset ?? DEFAULT_ESCROW_ASSET_SYMBOL;
  const decimals = Number.isInteger(badgeFacts.rewardDecimals)
    ? badgeFacts.rewardDecimals
    : decimalsForAssetSymbol(rewardAsset);
  const rewardBase = toBaseUnits(badgeFacts.rewardAmount, decimals);
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
    category: badgeFacts.category,
    level: inferLevel(badgeFacts),
    verifierMode: badgeFacts.verifierMode,
    reward: { asset: rewardAsset, amount: rewardBase, decimals },
    claimStake: { asset: rewardAsset, amount: stakeBase, decimals },
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
    signers: buildBadgeSigners({ session, verification, context }),
    metadataURI: selfUrl,
    image: context.image,
    publicBaseUrl,
    lineage: context.lineage
  });
}

export function buildBadgeJobSnapshot(job) {
  if (!job || typeof job !== "object") return undefined;
  const snapshot = {
    category: job.category,
    tier: job.tier,
    level: job.level,
    rewardAsset: job.rewardAsset ?? job.reward?.asset,
    rewardAmount: job.rewardAmount ?? job.reward?.amount,
    rewardDecimals: job.rewardDecimals ?? job.reward?.decimals,
    verifierMode: job.verifierMode,
    payoutMode: job.payoutMode
  };
  const compact = Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== undefined));
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function resolveBadgeFacts({ session, job, verification }) {
  return {
    ...buildBadgeJobSnapshot(verification?.badgeSnapshot),
    ...buildBadgeJobSnapshot(verification?.session?.badgeSnapshot),
    ...buildBadgeJobSnapshot({
      category: verification?.category ?? verification?.reputationSignals?.category,
      rewardAsset: verification?.rewardAsset ?? verification?.reward?.asset,
      rewardAmount: verification?.rewardAmount ?? verification?.reward?.amount,
      rewardDecimals: verification?.rewardDecimals ?? verification?.reward?.decimals,
      verifierMode: verification?.verificationContract?.verifierMode ?? verification?.handler,
      level: verification?.level,
      payoutMode: verification?.payoutMode
    }),
    ...buildBadgeJobSnapshot({
      category: session.category ?? session.jobCategory,
      rewardAsset: session.rewardAsset ?? session.reward?.asset,
      rewardAmount: session.rewardAmount ?? session.reward?.amount,
      rewardDecimals: session.rewardDecimals ?? session.reward?.decimals,
      verifierMode: session.verifierMode ?? session.verificationSummary?.handler,
      level: session.level,
      payoutMode: session.payoutMode
    }),
    ...buildBadgeJobSnapshot(session.badgeSnapshot),
    ...buildBadgeJobSnapshot(job)
  };
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
  if (Number.isInteger(job?.level) && job.level > 0) return job.level;
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
