import { randomUUID } from "node:crypto";

import { getAddress, id, isAddress } from "ethers";

import { DEFAULT_ESCROW_ASSET } from "./assets.js";
import { canonicalizeContent, hashCanonicalContent } from "./canonical-content.js";
import { normalizeJobInput } from "./job-catalog-normalization.js";
import {
  getBuiltinJobSchema,
  isBuiltinJobSchemaRef,
  validateAgainstSchema
} from "./job-schema-registry.js";
import {
  AuthorizationError,
  ConfigError,
  ConflictError,
  NotFoundError,
  ValidationError
} from "./errors.js";
import { decimalToBaseUnits } from "./platform-service-helpers.js";
import {
  EXTERNAL_JOB_LIFECYCLE_LOCK_TTL_SECONDS,
  EXTERNAL_JOB_TRANSITION_REASON,
  externalJobLifecycleLockId
} from "./external-job-lifecycle.js";

export const EXTERNAL_DRAFT_FUNDING_NOTE =
  "Awaiting a matching finalized escrow creation from the platform indexer.";
export const EXTERNAL_POSTING_MODES = new Set(["closed", "allowlist", "open"]);
export const CREATE_SINGLE_PAYOUT_SIGNATURE =
  "createSinglePayoutJob(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32)";

const DEFAULT_MIN_REWARD_USDC = "1";
const DEFAULT_DRAFT_TTL_HOURS = 72;
const DEFAULT_MAX_OPEN_DRAFTS = 10;
export const DEFAULT_POSTER_REVIEW_WINDOW_HOURS = 7 * 24;
export const MIN_EXTERNAL_CLAIM_TTL_SECONDS = 60;
const USDC_DECIMALS = 6;

class ExternalPostingValidationError extends ValidationError {
  constructor(message, code, details = undefined) {
    super(message, details);
    this.name = "ExternalPostingValidationError";
    this.code = code;
  }
}

export function resolveExternalPostingConfig(env = process.env) {
  const mode = String(env.EXTERNAL_POSTING_MODE ?? "closed").trim().toLowerCase() || "closed";
  if (!EXTERNAL_POSTING_MODES.has(mode)) {
    throw new ConfigError(
      "EXTERNAL_POSTING_MODE must be one of closed, allowlist, or open."
    );
  }

  const allowlist = parseWalletAllowlist(env.EXTERNAL_POSTING_ALLOWLIST);
  const minRewardUsdc = String(
    env.EXTERNAL_POSTING_MIN_REWARD_USDC ?? DEFAULT_MIN_REWARD_USDC
  ).trim();
  let minRewardRaw;
  try {
    minRewardRaw = decimalToBaseUnits(
      minRewardUsdc,
      USDC_DECIMALS,
      "EXTERNAL_POSTING_MIN_REWARD_USDC"
    );
  } catch (error) {
    throw new ConfigError(error.message);
  }
  if (minRewardRaw <= 0n) {
    throw new ConfigError("EXTERNAL_POSTING_MIN_REWARD_USDC must be greater than zero.");
  }

  const draftTtlHours = parsePositiveInteger(
    env.EXTERNAL_POSTING_DRAFT_TTL_HOURS,
    DEFAULT_DRAFT_TTL_HOURS,
    "EXTERNAL_POSTING_DRAFT_TTL_HOURS"
  );
  const maxOpenDrafts = parsePositiveInteger(
    env.EXTERNAL_POSTING_MAX_OPEN_DRAFTS,
    DEFAULT_MAX_OPEN_DRAFTS,
    "EXTERNAL_POSTING_MAX_OPEN_DRAFTS"
  );
  const reviewWindowHours = parsePositiveInteger(
    env.EXTERNAL_POSTING_REVIEW_WINDOW_HOURS,
    DEFAULT_POSTER_REVIEW_WINDOW_HOURS,
    "EXTERNAL_POSTING_REVIEW_WINDOW_HOURS"
  );
  const usdcAsset = resolveUsdcAsset(
    env.SUPPORTED_ASSETS_JSON,
    env.SUPPORTED_ASSETS,
    { required: mode !== "closed" }
  );
  const escrowCoreAddress = normalizeOptionalAddress(
    env.ESCROW_CORE_ADDRESS,
    "ESCROW_CORE_ADDRESS"
  );
  if (mode !== "closed" && !escrowCoreAddress) {
    throw new ConfigError(
      "ESCROW_CORE_ADDRESS is required when external posting is not closed."
    );
  }

  return Object.freeze({
    mode,
    allowlist,
    minRewardUsdc,
    minRewardRaw,
    draftTtlHours,
    maxOpenDrafts,
    reviewWindowHours,
    escrowCoreAddress,
    usdcAsset
  });
}

export function buildExternalJobIdCanonicalString(wallet, nonce) {
  return canonicalizeContent({
    domain: "averray.external-job.v1",
    nonce: String(nonce),
    poster: normalizeWallet(wallet)
  });
}

export function rebuildExternalDraftArtifacts(draft, config) {
  const wallet = normalizeWallet(draft?.wallet);
  const nonce = requireNonce(draft?.nonce);
  const definition = requirePlainObject(draft?.definition, "definition");
  const jobId = id(buildExternalJobIdCanonicalString(wallet, nonce));
  const specHash = hashCanonicalContent(definition);
  const terms = resolveOnChainTerms(definition, config);
  return {
    jobId,
    specHash,
    calldata: {
      to: requireEscrowCoreAddress(config),
      function: CREATE_SINGLE_PAYOUT_SIGNATURE,
      args: [
        jobId,
        config.usdcAsset.address,
        terms.rewardRaw.toString(),
        terms.opsReserveRaw.toString(),
        terms.contingencyReserveRaw.toString(),
        String(terms.claimTtlSeconds),
        id(terms.verifierMode),
        id(terms.category),
        specHash
      ],
      value: "0",
      valueSemantics:
        "Send no native token. EscrowCore snapshots its current protocolFeeBps and reserves that poster-side fee on top of reward, ops reserve, and contingency reserve from the caller's own AgentAccountCore USDC position."
    }
  };
}

export class ExternalPostingService {
  constructor({
    stateStore,
    platformService = undefined,
    config = resolveExternalPostingConfig(),
    now = () => new Date(),
    logger = console,
    eventBus = undefined
  } = {}) {
    if (!stateStore) {
      throw new ConfigError("ExternalPostingService requires a state store.");
    }
    this.stateStore = stateStore;
    this.platformService = platformService;
    this.config = config;
    this.now = now;
    this.logger = logger;
    this.eventBus = eventBus;
  }

  async createDraft(walletInput, payload) {
    const wallet = normalizeWallet(walletInput);
    const candidate = extractDefinitionCandidate(payload);
    const demand = extractDemandSignalFields(candidate);
    const now = this.currentTime();

    if (this.config.mode === "closed") {
      await this.recordDemandSignal({
        wallet,
        ...demand,
        decision: "mode_closed",
        attemptedAt: now.toISOString()
      });
      throw new AuthorizationError(
        "External posting is closed.",
        "external_posting_closed"
      );
    }
    if (this.config.mode === "allowlist" && !this.config.allowlist.has(wallet)) {
      await this.recordDemandSignal({
        wallet,
        ...demand,
        decision: "allowlist_rejected",
        attemptedAt: now.toISOString()
      });
      throw new AuthorizationError(
        "Wallet is not enabled for external posting.",
        "external_poster_not_allowed"
      );
    }

    let definition;
    try {
      definition = validateExternalJobDefinition(candidate, this.config);
    } catch (error) {
      await this.recordDemandSignal({
        wallet,
        ...demand,
        decision: error?.code === "external_reward_below_floor"
          ? "floor_rejected"
          : error?.code === "external_schema_not_supported"
            ? "schema_rejected"
            : "validation_rejected",
        attemptedAt: now.toISOString()
      });
      throw error;
    }

    const nonce = await this.stateStore.nextExternalDraftNonce(wallet);
    const draftId = id(canonicalizeContent({
      domain: "averray.external-draft.v1",
      nonce,
      poster: wallet
    }));
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + (this.config.draftTtlHours * 60 * 60 * 1000)
    ).toISOString();
    const artifacts = rebuildExternalDraftArtifacts(
      { wallet, nonce, definition },
      this.config
    );
    const draft = {
      draftId,
      wallet,
      nonce,
      definition,
      ...artifacts,
      createdAt,
      expiresAt,
      status: "awaiting_funding"
    };
    const stored = await this.stateStore.createExternalJobDraft(draft, {
      maxOpenDrafts: this.config.maxOpenDrafts,
      activeAfter: createdAt
    });
    if (!stored) {
      await this.recordDemandSignal({
        wallet,
        ...demand,
        decision: "cap_rejected",
        attemptedAt: createdAt
      });
      throw new ConflictError(
        `Wallet already has ${this.config.maxOpenDrafts} open external drafts.`,
        "external_draft_cap_reached",
        { maxOpenDrafts: this.config.maxOpenDrafts }
      );
    }

    await this.recordDemandSignal({
      wallet,
      ...demand,
      decision: "accepted",
      attemptedAt: createdAt
    });
    return presentDraft(draft, now);
  }

  async getDraft(walletInput, draftId) {
    const wallet = normalizeWallet(walletInput);
    const draft = await this.stateStore.getExternalJobDraft(String(draftId ?? ""));
    if (!draft) {
      throw new NotFoundError("External job draft not found.", "external_draft_not_found");
    }
    if (normalizeWallet(draft.wallet) !== wallet) {
      throw new AuthorizationError(
        "External job draft does not belong to the authenticated wallet.",
        "external_draft_not_owned"
      );
    }
    assertStoredDraftDeterminism(draft, this.config);
    const delisting = await this.stateStore.getExternalJobDelisting?.(draft.jobId);
    return presentDraft(draft, this.currentTime(), delisting);
  }

  async delistExternalJob(jobIdInput, {
    adminWallet,
    reason = "operator backstop"
  } = {}) {
    const jobId = normalizeBytes32(jobIdInput, "jobId");
    const record = {
      jobId,
      adminWallet: normalizeWallet(adminWallet),
      reason: String(reason ?? "").trim() || "operator backstop",
      delistedAt: this.currentTime().toISOString()
    };
    const lockId = externalJobLifecycleLockId(jobId);
    const lockOwner = randomUUID();
    const lockAcquired = await this.stateStore.acquireClaimLock?.(
      lockId,
      lockOwner,
      EXTERNAL_JOB_LIFECYCLE_LOCK_TTL_SECONDS
    );
    if (lockAcquired === false) {
      throw new ConflictError(
        `External job ${jobId} has another lifecycle transition in progress.`,
        EXTERNAL_JOB_TRANSITION_REASON,
        { jobId, operation: "delist" }
      );
    }

    try {
      await this.stateStore.upsertExternalJobDelisting(record);
      return {
        jobId,
        delisted: true,
        catalogProjectionRemoved: true,
        onChainEscrowTouched: false,
        reason: record.reason,
        delistedAt: record.delistedAt
      };
    } finally {
      await this.stateStore.releaseClaimLock?.(lockId, lockOwner);
    }
  }

  async reconcileFinalizedCreation(observationInput) {
    const observation = normalizeFinalizedCreation(observationInput);
    const draft = await this.stateStore.getExternalJobDraftByJobId?.(observation.jobId);
    if (!draft) {
      this.logger.warn?.(
        {
          event: "external_posting_unknown_job_observed",
          jobId: observation.jobId,
          poster: observation.poster,
          txHash: observation.txHash,
          blockNumber: observation.blockNumber
        },
        "external_posting.unknown_job_observed"
      );
      this.publishReconciliationEvent("unknown", observation);
      return { outcome: "unknown", jobId: observation.jobId, projected: false };
    }

    if (draft.status === "mismatch") {
      return {
        outcome: "mismatch",
        jobId: draft.jobId,
        field: draft.mismatchField,
        projected: false,
        permanent: true
      };
    }
    if (draft.status === "expired") {
      return {
        outcome: "expired",
        jobId: draft.jobId,
        projected: false,
        permanent: true
      };
    }
    if (draft.status === "live") {
      return this.projectConfirmedDraft(draft);
    }

    const mismatchField = firstCreationMismatch(draft, observation);
    if (mismatchField) {
      const updated = await this.stateStore.updateExternalJobDraft?.(draft.draftId, {
        status: "mismatch",
        mismatchField,
        mismatchObservedAt: this.currentTime().toISOString(),
        mismatchObservation: observation
      }) ?? {
        ...draft,
        status: "mismatch",
        mismatchField,
        mismatchObservation: observation
      };
      this.publishReconciliationEvent("mismatch", observation, { field: mismatchField });
      return {
        outcome: "mismatch",
        jobId: updated.jobId,
        field: mismatchField,
        projected: false,
        permanent: true
      };
    }

    if (Date.parse(observation.fundedAt) > Date.parse(draft.expiresAt)) {
      await this.stateStore.updateExternalJobDraft?.(draft.draftId, {
        status: "expired",
        fundedAfterExpiry: observation
      });
      this.publishReconciliationEvent("expired", observation, {
        reason: "funded_after_expiry"
      });
      return {
        outcome: "expired",
        jobId: draft.jobId,
        projected: false,
        permanent: true,
        reason: "funded_after_expiry"
      };
    }

    const confirmation = {
      fundedAt: observation.fundedAt,
      txHash: observation.txHash,
      blockNumber: observation.blockNumber
    };
    const updated = await this.stateStore.updateExternalJobDraft?.(draft.draftId, {
      status: "live",
      fundedAt: confirmation.fundedAt,
      fundingTxHash: confirmation.txHash,
      fundingBlockNumber: confirmation.blockNumber,
      confirmation
    }) ?? {
      ...draft,
      status: "live",
      fundedAt: confirmation.fundedAt,
      fundingTxHash: confirmation.txHash,
      fundingBlockNumber: confirmation.blockNumber,
      confirmation
    };
    this.publishReconciliationEvent("live", observation);
    return this.projectConfirmedDraft(updated);
  }

  async hydrateConfirmedProjections() {
    const drafts = await this.stateStore.listExternalJobDrafts?.({
      status: "live",
      limit: 10_000
    }) ?? [];
    const results = [];
    for (const draft of drafts) {
      results.push(await this.projectConfirmedDraft(draft));
    }
    return results;
  }

  async projectConfirmedDraft(draft) {
    if (await this.stateStore.isExternalJobDelisted(draft.jobId)) {
      return {
        outcome: "live",
        jobId: draft.jobId,
        projected: false,
        reason: "delisted"
      };
    }
    const confirmation = draft.confirmation ?? {
      fundedAt: draft.fundedAt,
      txHash: draft.fundingTxHash,
      blockNumber: draft.fundingBlockNumber
    };
    await this.platformService?.createExternalJobProjection?.(draft, confirmation);
    return {
      outcome: "live",
      jobId: draft.jobId,
      projected: Boolean(this.platformService?.createExternalJobProjection),
      fundedAt: confirmation.fundedAt,
      txHash: confirmation.txHash,
      blockNumber: confirmation.blockNumber
    };
  }

  async filterExternalCatalogProjection(jobs = []) {
    const visibility = await Promise.all(jobs.map(async (job) => {
      if (job?.source !== "external" && job?.source?.type !== "external") {
        return true;
      }
      const draft = await this.stateStore.getExternalJobDraftByJobId?.(job?.id);
      if (!isWatcherConfirmedDraft(draft)) {
        return false;
      }
      return !(await this.stateStore.isExternalJobDelisted(job?.id));
    }));
    return jobs.filter((_job, index) => visibility[index]);
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new ConfigError("ExternalPostingService clock returned an invalid date.");
    }
    return date;
  }

  async recordDemandSignal(signal) {
    return this.stateStore.appendExternalPostingDemandSignal({
      id: randomUUID(),
      wallet: signal.wallet,
      requestedReward: signal.requestedReward,
      schema: signal.schema,
      decision: signal.decision,
      attemptedAt: signal.attemptedAt
    });
  }

  publishReconciliationEvent(outcome, observation, extra = {}) {
    this.eventBus?.publish?.({
      id: `external-posting-reconciled-${observation.jobId}-${Date.now()}`,
      topic: `external_posting.${outcome}`,
      wallet: observation.poster,
      wallets: [observation.poster],
      jobId: observation.jobId,
      correlationId: observation.jobId,
      timestamp: this.currentTime().toISOString(),
      data: {
        jobId: observation.jobId,
        poster: observation.poster,
        txHash: observation.txHash,
        blockNumber: observation.blockNumber,
        fundedAt: observation.fundedAt,
        ...extra
      }
    });
  }
}

function validateExternalJobDefinition(candidate, config) {
  const definition = cloneJsonObject(requirePlainObject(candidate, "definition"));
  if ("id" in definition) {
    throw new ValidationError("definition.id is derived by the platform and must be omitted.");
  }
  if (
    definition.externalSchema !== undefined
    || definition.schemaRegistrations !== undefined
    || definition.schemaTrustPolicy !== undefined
  ) {
    throw externalValidationError(
      "External drafts only support platform-verified built-in schemas.",
      "external_schema_not_supported"
    );
  }
  if (
    definition.recurring === true
    || definition.recurringPolicy !== undefined
    || definition.schedule !== undefined
    || definition.milestones !== undefined
    || (definition.payoutMode !== undefined && definition.payoutMode !== "single")
  ) {
    throw externalValidationError(
      "External posting stage 1 only supports single-payout, non-recurring jobs.",
      "external_payout_mode_not_supported"
    );
  }

  const rewardAsset = String(definition.rewardAsset ?? "USDC").trim().toUpperCase();
  if (rewardAsset !== "USDC") {
    throw externalValidationError(
      "External posting stage 1 only supports USDC rewards.",
      "external_reward_asset_not_supported"
    );
  }
  definition.rewardAsset = "USDC";

  let rewardRaw;
  try {
    rewardRaw = decimalToBaseUnits(
      definition.rewardAmount,
      config.usdcAsset.decimals,
      "rewardAmount"
    );
  } catch (error) {
    throw new ValidationError(error.message);
  }
  if (rewardRaw < config.minRewardRaw) {
    throw externalValidationError(
      `External job reward must be at least ${config.minRewardUsdc} USDC.`,
      "external_reward_below_floor",
      {
        minimumRewardUsdc: config.minRewardUsdc,
        requestedReward: String(definition.rewardAmount ?? "")
      }
    );
  }

  const inputSchemaRef = String(
    definition.inputSchemaRef ?? `schema://jobs/${definition.category}-input`
  ).trim();
  const outputSchemaRef = String(
    definition.outputSchemaRef ?? `schema://jobs/${definition.category}-output`
  ).trim();
  if (!isBuiltinJobSchemaRef(inputSchemaRef) || !isBuiltinJobSchemaRef(outputSchemaRef)) {
    throw externalValidationError(
      "External drafts require platform-supported input and output schemas.",
      "external_schema_not_supported",
      { inputSchemaRef, outputSchemaRef }
    );
  }
  definition.inputSchemaRef = inputSchemaRef;
  definition.outputSchemaRef = outputSchemaRef;
  resolveExternalClaimTtlSeconds(definition);

  try {
    normalizeJobInput({ ...definition, id: "external-draft-validation" });
    if (definition.input !== undefined) {
      validateAgainstSchema(
        definition.input,
        getBuiltinJobSchema(inputSchemaRef),
        "definition.input"
      );
    }
  } catch (error) {
    if (/schema/iu.test(error?.message ?? "")) {
      throw externalValidationError(
        error.message,
        "external_schema_not_supported",
        { inputSchemaRef, outputSchemaRef }
      );
    }
    throw error;
  }
  resolveOnChainTerms(definition, config);
  return definition;
}

function resolveOnChainTerms(definition, config) {
  const rewardRaw = decimalToBaseUnits(
    definition?.rewardAmount,
    config.usdcAsset.decimals,
    "rewardAmount"
  );
  const opsReserveRaw = decimalToBaseUnits(
    definition?.opsReserve ?? "0",
    config.usdcAsset.decimals,
    "opsReserve"
  );
  const contingencyReserveRaw = decimalToBaseUnits(
    definition?.contingencyReserve ?? "0",
    config.usdcAsset.decimals,
    "contingencyReserve"
  );
  const claimTtlSeconds = resolveExternalClaimTtlSeconds(definition);
  const verifierMode = String(definition?.verifierMode ?? "").trim().toLowerCase();
  const category = String(definition?.category ?? "").trim().toLowerCase();
  return {
    rewardRaw,
    opsReserveRaw,
    contingencyReserveRaw,
    claimTtlSeconds,
    verifierMode,
    category
  };
}

function assertStoredDraftDeterminism(draft, config) {
  const rebuilt = rebuildExternalDraftArtifacts(draft, config);
  if (
    rebuilt.jobId !== draft.jobId
    || rebuilt.specHash !== draft.specHash
    || canonicalizeContent(rebuilt.calldata) !== canonicalizeContent(draft.calldata)
  ) {
    throw new ConflictError(
      "Stored external draft failed its deterministic integrity check.",
      "external_draft_integrity_mismatch",
      { draftId: draft.draftId }
    );
  }
}

function presentDraft(draft, now, delisting = undefined) {
  if (delisting) {
    const prior = presentDraft(draft, now);
    return {
      ...prior,
      status: "delisted",
      delisted: true,
      previousStatus: prior.status,
      delistedAt: delisting.delistedAt,
      delistReason: delisting.reason
    };
  }
  if (draft.status === "live") {
    return {
      draftId: draft.draftId,
      jobId: draft.jobId,
      specHash: draft.specHash,
      definition: cloneJsonObject(draft.definition),
      calldata: cloneJsonObject(draft.calldata),
      createdAt: draft.createdAt,
      expiresAt: draft.expiresAt,
      status: "live",
      fundedAt: draft.fundedAt,
      txHash: draft.fundingTxHash,
      blockNumber: draft.fundingBlockNumber
    };
  }
  if (draft.status === "mismatch") {
    return {
      draftId: draft.draftId,
      jobId: draft.jobId,
      specHash: draft.specHash,
      definition: cloneJsonObject(draft.definition),
      calldata: cloneJsonObject(draft.calldata),
      createdAt: draft.createdAt,
      expiresAt: draft.expiresAt,
      status: `mismatch(${draft.mismatchField})`,
      mismatchField: draft.mismatchField,
      permanent: true
    };
  }
  const expired = draft.status === "expired"
    || now.getTime() >= Date.parse(draft.expiresAt);
  return {
    draftId: draft.draftId,
    jobId: draft.jobId,
    specHash: draft.specHash,
    definition: cloneJsonObject(draft.definition),
    calldata: cloneJsonObject(draft.calldata),
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    status: expired ? "expired" : "awaiting_funding",
    ...(!expired ? { note: EXTERNAL_DRAFT_FUNDING_NOTE } : {})
  };
}

function resolveExternalClaimTtlSeconds(definition) {
  // External work uses the poster's explicit claim window rather than deriving
  // duration from tier/category: those labels describe access and task shape,
  // not how long an arbitrary repository task needs. Curated ingesters own
  // their source-specific TTLs; an external poster can deliberately choose a
  // longer window (and the positive floor below prevents zero-TTL lockups).
  const requested = definition?.claimTtlSeconds ?? 3600;
  const claimTtlSeconds = Number(requested);
  if (
    !Number.isInteger(claimTtlSeconds)
    || claimTtlSeconds < MIN_EXTERNAL_CLAIM_TTL_SECONDS
  ) {
    throw externalValidationError(
      `claimTtlSeconds must be an integer of at least ${MIN_EXTERNAL_CLAIM_TTL_SECONDS}.`,
      "external_claim_ttl_invalid",
      {
        minimumClaimTtlSeconds: MIN_EXTERNAL_CLAIM_TTL_SECONDS,
        requestedClaimTtlSeconds: Number.isFinite(claimTtlSeconds)
          ? claimTtlSeconds
          : String(requested ?? "")
      }
    );
  }
  return claimTtlSeconds;
}

function normalizeFinalizedCreation(value) {
  const source = requirePlainObject(value, "observation");
  if (source.finalized !== true) {
    throw new ValidationError("External job creation observation must be finalized.");
  }
  return {
    jobId: normalizeBytes32(source.jobId, "jobId"),
    specHash: normalizeBytes32(source.specHash, "specHash"),
    poster: normalizeWallet(source.poster),
    asset: normalizeAddress(source.asset, "asset"),
    reward: normalizeUint(source.reward, "reward"),
    opsReserve: normalizeUint(source.opsReserve, "opsReserve"),
    contingencyReserve: normalizeUint(source.contingencyReserve, "contingencyReserve"),
    fundedAt: normalizeIso(source.fundedAt, "fundedAt"),
    txHash: normalizeBytes32(source.txHash, "txHash"),
    blockNumber: normalizeUint(source.blockNumber, "blockNumber"),
    finalized: true
  };
}

function firstCreationMismatch(draft, observation) {
  const args = Array.isArray(draft?.calldata?.args) ? draft.calldata.args : [];
  const expected = {
    specHash: String(args[8] ?? draft?.specHash ?? "").toLowerCase(),
    poster: String(draft?.wallet ?? "").toLowerCase(),
    asset: String(args[1] ?? "").toLowerCase(),
    reward: String(args[2] ?? ""),
    opsReserve: String(args[3] ?? ""),
    contingencyReserve: String(args[4] ?? "")
  };
  for (const field of [
    "specHash",
    "poster",
    "asset",
    "reward",
    "opsReserve",
    "contingencyReserve"
  ]) {
    if (expected[field] !== observation[field]) {
      return field;
    }
  }
  return undefined;
}

function isWatcherConfirmedDraft(draft) {
  const confirmation = draft?.confirmation;
  return draft?.status === "live"
    && Boolean(confirmation?.fundedAt)
    && Boolean(confirmation?.txHash)
    && Boolean(confirmation?.blockNumber);
}

function normalizeAddress(raw, label) {
  if (!isAddress(String(raw ?? ""))) {
    throw new ValidationError(`${label} must be an EVM address.`);
  }
  return getAddress(String(raw)).toLowerCase();
}

function normalizeUint(raw, label) {
  const value = String(raw ?? "").trim();
  if (!/^\d+$/u.test(value)) {
    throw new ValidationError(`${label} must be an exact unsigned integer.`);
  }
  return BigInt(value).toString();
}

function normalizeIso(raw, label) {
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${label} must be an ISO-8601 timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function extractDefinitionCandidate(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "definition" in payload) {
    return payload.definition;
  }
  return payload;
}

function extractDemandSignalFields(candidate) {
  const object = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate
    : {};
  const reward = object.rewardAmount;
  const category = typeof object.category === "string"
    ? object.category.trim().toLowerCase()
    : "";
  return {
    requestedReward: reward === undefined || reward === null
      ? null
      : typeof reward === "string" || typeof reward === "number"
        ? reward
        : String(reward),
    schema: typeof object.outputSchemaRef === "string"
      ? object.outputSchemaRef
      : category
        ? `schema://jobs/${category}-output`
        : null
  };
}

function resolveUsdcAsset(rawAssets, rawLegacyAssets, { required } = {}) {
  let assets = [];
  if (typeof rawAssets === "string" && rawAssets.trim()) {
    try {
      assets = JSON.parse(rawAssets);
    } catch {
      throw new ConfigError("SUPPORTED_ASSETS_JSON must be valid JSON.");
    }
    if (!Array.isArray(assets)) {
      throw new ConfigError("SUPPORTED_ASSETS_JSON must decode to an array.");
    }
  } else if (typeof rawLegacyAssets === "string" && rawLegacyAssets.trim()) {
    assets = rawLegacyAssets
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf(":");
        if (separator < 1) {
          throw new ConfigError("SUPPORTED_ASSETS entries must use SYMBOL:address.");
        }
        return {
          symbol: entry.slice(0, separator),
          address: entry.slice(separator + 1),
          decimals: USDC_DECIMALS
        };
      });
  }
  const selected = assets.find((entry) =>
    String(entry?.symbol ?? "").trim().toUpperCase() === "USDC"
  );
  if (required && assets.length > 0 && !selected) {
    throw new ConfigError("USDC must be present in supported assets for external posting.");
  }
  const resolved = selected ?? DEFAULT_ESCROW_ASSET;
  const address = normalizeOptionalAddress(resolved.address, "USDC asset address");
  if (!address) {
    throw new ConfigError("USDC asset address is required for external posting.");
  }
  const decimals = Number(resolved.decimals ?? USDC_DECIMALS);
  if (decimals !== USDC_DECIMALS) {
    throw new ConfigError("External posting requires a 6-decimal USDC asset.");
  }
  return Object.freeze({ symbol: "USDC", address, decimals });
}

function parseWalletAllowlist(raw) {
  const entries = String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const wallets = new Set();
  for (const entry of entries) {
    if (!isAddress(entry)) {
      throw new ConfigError("EXTERNAL_POSTING_ALLOWLIST must contain EVM wallet addresses.");
    }
    wallets.add(getAddress(entry).toLowerCase());
  }
  return wallets;
}

function parsePositiveInteger(raw, fallback, label) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer.`);
  }
  return value;
}

function requireEscrowCoreAddress(config) {
  if (!config?.escrowCoreAddress) {
    throw new ConfigError(
      "ESCROW_CORE_ADDRESS is required to create an external job draft calldata template."
    );
  }
  return config.escrowCoreAddress;
}

function normalizeOptionalAddress(raw, label) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return "";
  }
  if (!isAddress(String(raw).trim())) {
    throw new ConfigError(`${label} must be an EVM address.`);
  }
  return getAddress(String(raw).trim());
}

function normalizeWallet(raw) {
  if (!isAddress(String(raw ?? ""))) {
    throw new ValidationError("Authenticated wallet must be an EVM address.");
  }
  return getAddress(String(raw)).toLowerCase();
}

function normalizeBytes32(raw, label) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(value)) {
    throw new ValidationError(`${label} must be a 32-byte hex value.`);
  }
  return value;
}

function requireNonce(raw) {
  const value = String(raw ?? "").trim();
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new ValidationError("draft nonce must be a positive integer string.");
  }
  return value;
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be a JSON object.`);
  }
  return value;
}

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function externalValidationError(message, code, details = undefined) {
  return new ExternalPostingValidationError(message, code, details);
}
