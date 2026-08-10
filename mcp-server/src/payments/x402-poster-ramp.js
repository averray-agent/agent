import { randomUUID } from "node:crypto";

import { getAddress, isAddress } from "ethers";

import { SiwxAuthAdapter } from "../auth/siwx.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import {
  AppError,
  ConfigError,
  ConflictError,
  ExternalServiceError
} from "../core/errors.js";
import {
  EXTERNAL_FUNDING_RAILS
} from "../core/external-posting-service.js";
import { decimalToBaseUnits } from "../core/platform-service-helpers.js";
import { assertSettlementAdapter } from "./settlement-adapter.js";

const POSTING_PATH = "/jobs/x402";
const FLOAT_LOCK_ID = "external-payment-float";
const FLOAT_LOCK_TTL_SECONDS = 30;
/**
 * Commitments the pooled account's own balance does NOT yet reflect.
 *
 * The distinction is when the Hub moved, not whether the posting worked out:
 *
 *   reserved                        float promised, escrow not created — the
 *                                   balance still shows this money
 *   escrow_reconciliation_pending   we cannot prove whether the chain moved, so
 *                                   we assume it has not and count it
 *
 * Everything else — `escrow_created`, `settled`, `platform_loss` — has already
 * left the pool, so the live balance read in assertFloatCapacity accounts for
 * it. `settled` used to be in this set, which double-charged every completed
 * posting against a cap that could then only rise. Adding a status here means
 * "the chain has not moved yet", never "this posting was unsuccessful".
 */
const IN_FLIGHT_FLOAT_STATUSES = new Set([
  "reserved",
  "escrow_reconciliation_pending"
]);

export class X402FloatUnavailableError extends AppError {
  // `limitedBy` says which of the two ceilings refused, because they are fixed
  // by different people. The configured cap is ours to raise; the pooled
  // account's liquidity needs USDC moved from Base to Hub. Telling a poster to
  // "retry after rebalance" when the answer is a config value we control was
  // one of the ways this endpoint used to mislead.
  constructor({
    capRaw,
    committedRaw,
    requestedRaw,
    retryAfterSeconds,
    now,
    limitedBy = "configured_cap"
  }) {
    const retryAt = new Date(now.getTime() + (retryAfterSeconds * 1000)).toISOString();
    super(
      `Averray's x402 Hub float cannot cover this posting right now. No payment was verified or settled. Retry after ${retryAt}.`,
      {
        name: "X402FloatUnavailableError",
        code: "x402_float_exhausted",
        statusCode: 503,
        details: {
          reason: limitedBy === "pooled_account_liquidity"
            ? "pooled_account_liquidity_insufficient"
            : "configured_pooled_float_cap_exhausted",
          limitedBy,
          capRaw: capRaw.toString(),
          committedRaw: committedRaw.toString(),
          requestedRaw: requestedRaw.toString(),
          retryAfterSeconds,
          retryAt,
          action: "retry_after_rebalance",
          posterFunds: "unchanged"
        }
      }
    );
  }
}

export function resolveX402PosterRampConfig(env = process.env) {
  const mode = String(env.X402_POSTING_MODE ?? "disabled").trim().toLowerCase();
  if (!new Set(["disabled", "enabled"]).has(mode)) {
    throw new ConfigError("X402_POSTING_MODE must be disabled or enabled.");
  }
  if (mode === "disabled") return Object.freeze({ enabled: false, mode });

  const publicOrigin = normalizePublicOrigin(env.X402_PUBLIC_ORIGIN);
  const network = String(env.X402_PAYMENT_NETWORK ?? "").trim().toLowerCase();
  if (network !== "eip155:8453") {
    throw new ConfigError(
      "X402_PAYMENT_NETWORK must be eip155:8453 (Base) for this poster ramp. Polkadot Hub-native settlement and per-job bridging are not supported."
    );
  }
  const asset = requireAddress(env.X402_PAYMENT_ASSET_ADDRESS, "X402_PAYMENT_ASSET_ADDRESS");
  const payTo = requireAddress(env.X402_PAYMENT_PAY_TO, "X402_PAYMENT_PAY_TO");
  // The token's EIP-712 domain, which payers use to sign transferWithAuthorization.
  // It is a property of the asset, not of this service, and it is NOT the symbol:
  // Base USDC has symbol() "USDC" and name() "USD Coin". Required with no default —
  // a hardcoded "USDC" once made the ramp unable to accept a payment from anyone.
  const assetEip712Name = requireNonEmpty(
    env.X402_PAYMENT_ASSET_EIP712_NAME,
    "X402_PAYMENT_ASSET_EIP712_NAME",
    "read name() from the payment asset and confirm the pair reproduces its DOMAIN_SEPARATOR"
  );
  const assetEip712Version = requireNonEmpty(
    env.X402_PAYMENT_ASSET_EIP712_VERSION,
    "X402_PAYMENT_ASSET_EIP712_VERSION",
    "read version() from the payment asset and confirm the pair reproduces its DOMAIN_SEPARATOR"
  );
  const floatCapUsdc = String(env.X402_POSTING_FLOAT_CAP_USDC ?? "").trim();
  if (!floatCapUsdc) {
    throw new ConfigError(
      "X402_POSTING_FLOAT_CAP_USDC is required when x402 posting is enabled; the bank lane must choose it."
    );
  }
  let floatCapRaw;
  try {
    floatCapRaw = decimalToBaseUnits(floatCapUsdc, 6, "X402_POSTING_FLOAT_CAP_USDC");
  } catch (error) {
    throw new ConfigError(error.message);
  }
  if (floatCapRaw <= 0n) {
    throw new ConfigError("X402_POSTING_FLOAT_CAP_USDC must be greater than zero.");
  }
  const retryAfterSeconds = requiredPositiveInteger(
    env.X402_POSTING_FLOAT_RETRY_AFTER_SECONDS,
    "X402_POSTING_FLOAT_RETRY_AFTER_SECONDS"
  );
  const maxTimeoutSeconds = optionalPositiveInteger(
    env.X402_PAYMENT_TIMEOUT_SECONDS,
    60,
    "X402_PAYMENT_TIMEOUT_SECONDS"
  );
  const nonceTtlSeconds = optionalPositiveInteger(
    env.X402_SIGN_IN_NONCE_TTL_SECONDS,
    300,
    "X402_SIGN_IN_NONCE_TTL_SECONDS"
  );
  return Object.freeze({
    enabled: true,
    mode,
    publicOrigin,
    network,
    asset,
    payTo,
    assetEip712Name,
    assetEip712Version,
    floatCapUsdc,
    floatCapRaw,
    retryAfterSeconds,
    maxTimeoutSeconds,
    nonceTtlSeconds
  });
}

export class X402PosterRampService {
  constructor({
    config,
    settlementAdapter,
    externalPostingService,
    stateStore,
    gateway,
    siwxAdapter = undefined,
    now = () => new Date(),
    afterVerify = undefined
  } = {}) {
    if (!config?.enabled) {
      throw new ConfigError("X402PosterRampService requires enabled configuration.");
    }
    if (!externalPostingService || !stateStore || !gateway) {
      throw new ConfigError(
        "X402PosterRampService requires external posting, durable state, and the Hub gateway."
      );
    }
    this.config = config;
    this.settlementAdapter = assertSettlementAdapter(settlementAdapter);
    this.externalPostingService = externalPostingService;
    this.stateStore = stateStore;
    this.gateway = gateway;
    this.now = now;
    this.afterVerify = afterVerify;
    this.siwxAdapter = siwxAdapter ?? new SiwxAuthAdapter({
      stateStore,
      publicOrigin: config.publicOrigin,
      chainId: config.network,
      nonceTtlSeconds: config.nonceTtlSeconds,
      now
    });
  }

  async paymentRequired(payload) {
    const preview = await this.externalPostingService.previewFundingRequirement(payload);
    const requestedRaw = exactUint(
      preview.fundingRequirement.posterReservedRaw,
      "x402 posting price"
    );
    await this.assertFloatCapacity(requestedRaw);
    const binding = hashCanonicalContent(preview.definition);
    const signIn = await this.siwxAdapter.issueChallenge({
      resourcePath: POSTING_PATH,
      requestBinding: binding
    });
    const requirements = this.paymentRequirements(requestedRaw);
    const envelope = this.paymentEnvelope(requirements, signIn);
    return {
      statusCode: 402,
      body: envelope,
      headers: paymentRequiredHeaders(envelope)
    };
  }

  async post({ payload, paymentProof, signInProof }) {
    const preview = await this.externalPostingService.previewFundingRequirement(payload);
    const requestBinding = hashCanonicalContent(preview.definition);
    const identity = await this.siwxAdapter.verifyHeader(signInProof, {
      resourcePath: POSTING_PATH,
      requestBinding
    });
    const pooledAccount = await this.gateway.getPooledFundingAccount();
    const draftView = await this.externalPostingService.createDraft(
      identity.wallet,
      payload,
      {
        fundingRail: EXTERNAL_FUNDING_RAILS.X402,
        escrowPoster: pooledAccount
      }
    );
    const signal = await this.stateStore.getExternalPostingDemandSignal(draftView.draftId);
    const draft = signal?.quote;
    if (
      !draft
      || draft.fundingRail !== EXTERNAL_FUNDING_RAILS.X402
      || String(draft.escrowPoster).toLowerCase() !== pooledAccount
    ) {
      throw new ConflictError(
        "The x402 quote is no longer payable or belongs to a different funding rail. No payment was settled; inspect the returned draft status and submit different job content if it already exists.",
        "x402_quote_not_payable",
        { action: "inspect_draft_status", posterFunds: "unchanged" }
      );
    }
    const requestedRaw = exactUint(
      draft.fundingRequirement.posterReservedRaw,
      "x402 posting price"
    );
    const requirements = this.paymentRequirements(requestedRaw);
    const facilitatorContext = this.facilitatorContext();

    // Hard invariant: verify moves no money and is always completed before the
    // Hub create call. The test-only hook models a process death at this exact
    // boundary; no float reservation or job exists before it returns.
    const verification = await this.settlementAdapter.verify({
      paymentProof,
      requirements,
      ...facilitatorContext
    });
    if (String(verification.payer).toLowerCase() !== identity.wallet) {
      throw new ConflictError(
        "SIGN-IN-WITH-X and X-PAYMENT name different wallets. No money moved. Sign both headers with the same wallet and request a fresh 402 response.",
        "x402_payer_identity_mismatch",
        { action: "sign_both_headers_with_same_wallet", posterFunds: "unchanged" }
      );
    }
    await this.afterVerify?.({ verification, draft });

    const reservation = await this.reserveFloat({
      verification,
      draft,
      reservedRaw: requestedRaw,
      pooledAccount
    });
    let funding = reservation.record;

    if (reservation.resumeFrom === "settled") {
      await this.externalPostingService.confirmExternalPaymentSettlement(
        draft.draftId,
        funding.settlement
      );
      return this.completedResponse(identity.wallet, draft.draftId, funding.settlement);
    }

    let creation;
    if (reservation.resumeFrom !== "settle") {
      try {
        creation = await this.gateway.createEscrowFundedExternalJob(draft);
        await this.externalPostingService.reconcileFinalizedCreation(creation);
        funding = await this.updateFunding(funding.id, {
          status: "escrow_created",
          jobId: draft.jobId,
          hubTxHash: creation.txHash,
          hubBlockNumber: creation.blockNumber,
          escrowCreatedAt: creation.fundedAt
        });
      } catch (error) {
        const alreadyExists = error?.code === "external_escrow_job_exists";
        await this.updateFunding(funding.id, {
          status: alreadyExists ? "escrow_reconciliation_pending" : "create_failed",
          failure: normalizedFailure("create", error, {
            posterFunds: "unchanged",
            action: alreadyExists
              ? "retry_after_escrow_reconciliation"
              : "retry_for_fresh_challenge"
          })
        });
        throw new ExternalServiceError(
          alreadyExists
            ? "Payment was verified and the Hub job already exists, but its creation receipt is still being reconciled. Settlement was not called and the poster's funds were not touched. Wait briefly, then retry the same payment authorization."
            : "Payment was verified, but Hub escrow creation failed. Settlement was not called and the poster's funds were not touched. Wait for Hub health to recover, then request a fresh 402 response.",
          alreadyExists ? "x402_hub_reconciliation_pending" : "x402_hub_create_failed",
          {
            action: alreadyExists
              ? "retry_after_escrow_reconciliation"
              : "retry_when_hub_healthy",
            ...(alreadyExists ? { retryAfterSeconds: this.config.retryAfterSeconds } : {}),
            posterFunds: "unchanged",
            cause: String(error?.code ?? "hub_create_failed")
          }
        );
      }
    }

    let settlement;
    try {
      settlement = await this.settlementAdapter.settle({
        paymentProof,
        requirements,
        ...facilitatorContext
      });
    } catch (error) {
      const failure = normalizedFailure("settle", error, {
        posterFunds: error?.details?.posterFunds ?? "unknown",
        action: error?.details?.action ?? "check_wallet_and_contact_support"
      });
      await Promise.allSettled([
        this.updateFunding(funding.id, {
          status: "platform_loss",
          lossOwner: "platform",
          failure
        }),
        this.externalPostingService.recordExternalPaymentSettlementFailure(
          draft.draftId,
          error
        ),
        this.externalPostingService.delistExternalJob(draft.jobId, {
          adminWallet: pooledAccount,
          reason: `x402 settlement failure: ${failure.code}`
        })
      ]);
      throw error;
    }

    funding = await this.updateFunding(funding.id, {
      status: "settled",
      settlement,
      settledAt: settlement.settledAt
    });
    try {
      await this.externalPostingService.confirmExternalPaymentSettlement(
        draft.draftId,
        settlement
      );
    } catch (error) {
      throw new ExternalServiceError(
        "The payment settled and Hub escrow exists, but the job could not be published yet. Do not pay again. Retry the same authorization so Averray can finish publication, or contact support with the request ID.",
        "x402_publication_pending",
        {
          action: "retry_same_authorization_or_contact_support",
          posterFunds: "settled",
          paymentReceiptId: settlement.receiptId,
          cause: String(error?.code ?? "publication_failed")
        }
      );
    }
    return this.completedResponse(identity.wallet, draft.draftId, settlement);
  }

  async completedResponse(wallet, draftId, settlement) {
    const completed = await this.externalPostingService.getDraft(wallet, draftId);
    return {
      ...completed,
      fundingRail: EXTERNAL_FUNDING_RAILS.X402,
      payment: {
        status: "settled",
        network: settlement.network,
        amount: settlement.amount,
        receiptId: settlement.receiptId,
        discoverable: true,
        portableListing: true,
        discoveryStatus: settlement.discovery?.status ?? "not_reported"
      },
      headers: paymentResponseHeaders(settlement)
    };
  }

  paymentRequirements(amountRaw) {
    return {
      scheme: "exact",
      network: this.config.network,
      asset: this.config.asset,
      amount: amountRaw.toString(),
      payTo: this.config.payTo,
      maxTimeoutSeconds: this.config.maxTimeoutSeconds,
      // `extra` IS the payer's EIP-712 domain for transferWithAuthorization.
      // Anything wrong here is unrecoverable at the payer's end: they sign a
      // different digest, it recovers to a different address, and the facilitator
      // rejects it with no way to tell that our advertisement was at fault.
      extra: {
        name: this.config.assetEip712Name,
        version: this.config.assetEip712Version
      }
    };
  }

  paymentEnvelope(requirements, signIn) {
    const resource = this.paymentResource();
    return {
      x402Version: 2,
      error: "Payment required to create an escrow-funded Averray job.",
      resource,
      accepts: [requirements],
      extensions: {
        bazaar: bazaarExtension(),
        "sign-in-with-x": signIn
      },
      discoverable: true,
      portableListing: true
    };
  }

  paymentResource() {
    return {
      url: new URL(POSTING_PATH, this.config.publicOrigin).toString(),
      description: "Post a worker job on Averray without holding funds on Polkadot Hub.",
      mimeType: "application/json",
      serviceName: "Averray",
      tags: ["agents", "jobs", "escrow", "polkadot"]
    };
  }

  facilitatorContext() {
    return {
      resource: this.paymentResource(),
      extensions: { bazaar: bazaarExtension() }
    };
  }

  /**
   * Two questions, and they are not the same question.
   *
   *   1. Does the pooled account ACTUALLY still hold what we are about to front?
   *   2. Are we willing to have this much of it tied up in x402 at once?
   *
   * (1) is answered by reading the chain, never by a ledger. A settled posting
   * has already left the pool, so the live balance has already accounted for it;
   * the previous code summed those records too and charged us a second time. The
   * cap was therefore monotonic — it only ever went up — and after one 1.05 USDC
   * posting against a 2 USDC cap no job could ever be posted again, while the
   * 503 told posters to retry in fifteen minutes. Reading the balance is also
   * self-correcting: move USDC from Base to Hub and the door reopens by itself,
   * with no status to set and no bookkeeping to forget.
   *
   * (2) is the cap, and it still matters. The pooled account is also the reward
   * bank, so without a ceiling a busy hour of posting would quietly drain the
   * pot that pays workers.
   *
   * Only genuinely in-flight commitments are added on top: `reserved` (we have
   * promised float but not yet created escrow) and `escrow_reconciliation_pending`
   * (we cannot yet prove whether the chain moved). Everything past that point has
   * already moved the balance we just read.
   */
  async assertFloatCapacity(requestedRaw) {
    const inFlightRaw = await this.inFlightFloatRaw();
    if (inFlightRaw + requestedRaw > this.config.floatCapRaw) {
      throw new X402FloatUnavailableError({
        capRaw: this.config.floatCapRaw,
        committedRaw: inFlightRaw,
        requestedRaw,
        retryAfterSeconds: this.config.retryAfterSeconds,
        now: this.currentTime()
      });
    }

    const availableRaw = await this.pooledLiquidRaw();
    if (availableRaw === undefined) return;
    if (inFlightRaw + requestedRaw > availableRaw) {
      throw new X402FloatUnavailableError({
        capRaw: availableRaw,
        committedRaw: inFlightRaw,
        requestedRaw,
        retryAfterSeconds: this.config.retryAfterSeconds,
        now: this.currentTime(),
        limitedBy: "pooled_account_liquidity"
      });
    }
  }

  /**
   * The pooled account's live liquid position, or undefined when the chain
   * cannot be read.
   *
   * Undefined deliberately does NOT block. The configured cap above has already
   * bounded the exposure, and refusing a paying customer because our own RPC
   * blinked would be the worse failure — the poster's money is untouched either
   * way, but a needless 503 sends them somewhere else. A read failure that
   * mattered would show up as a create failure moments later, with the poster's
   * funds still unspent.
   */
  async pooledLiquidRaw() {
    try {
      const pooledAccount = await this.gateway.getPooledFundingAccount();
      const view = await this.gateway.getAccountPosition(pooledAccount, "USDC");
      const liquidRaw = view?.position?.liquidRaw;
      return liquidRaw === undefined ? undefined : exactUint(liquidRaw, "pooled account liquid");
    } catch {
      return undefined;
    }
  }

  async reserveFloat({ verification, draft, reservedRaw, pooledAccount }) {
    const owner = randomUUID();
    const acquired = await this.stateStore.acquireClaimLock(
      FLOAT_LOCK_ID,
      owner,
      FLOAT_LOCK_TTL_SECONDS
    );
    if (acquired === false) {
      throw new ExternalServiceError(
        "Another x402 posting is reserving pooled float. No money moved. Wait briefly, request a fresh 402 response, and retry.",
        "x402_float_reservation_busy",
        {
          action: "retry_for_fresh_challenge",
          retryAfterSeconds: this.config.retryAfterSeconds,
          posterFunds: "unchanged"
        }
      );
    }
    try {
      const existing = await this.stateStore.getExternalPaymentFunding(
        verification.authorizationId
      );
      if (existing && existing.draftId !== draft.draftId) {
        throw new ConflictError(
          "This payment authorization belongs to a different job. Do not pay again; inspect the existing job or contact support.",
          "x402_payment_already_used",
          { action: "inspect_existing_job", posterFunds: "unchanged_or_already_settled" }
        );
      }
      if (existing && (
        String(existing.posterWallet).toLowerCase() !== String(verification.payer).toLowerCase()
        || exactUint(existing.reservedRaw, "stored x402 reservation") !== reservedRaw
      )) {
        throw new ConflictError(
          "This payment authorization does not match the payer or amount recorded for the job. Do not pay again; contact support with the request ID.",
          "x402_payment_record_mismatch",
          { action: "contact_support", posterFunds: "unchanged_or_already_settled" }
        );
      }
      if (existing?.status === "settled") {
        return { record: existing, resumeFrom: "settled" };
      }
      if (existing?.status === "escrow_created") {
        return { record: existing, resumeFrom: "settle" };
      }
      if (existing?.status === "platform_loss") {
        throw new ConflictError(
          "This authorization already reached a failed settlement after Hub creation. Do not pay again. Check the payer wallet and contact support with the request ID.",
          "x402_payment_outcome_recorded",
          { action: "check_wallet_and_contact_support", posterFunds: "unknown" }
        );
      }
      if (existing && new Set(["reserved", "escrow_reconciliation_pending"]).has(existing.status)) {
        const materialized = await this.stateStore.getExternalJobDraft(draft.draftId);
        if (materialized?.status === "settlement_pending") {
          const recovered = await this.updateFunding(existing.id, {
            status: "escrow_created",
            jobId: draft.jobId,
            hubTxHash: materialized.fundingTxHash,
            hubBlockNumber: materialized.fundingBlockNumber,
            escrowCreatedAt: materialized.fundedAt
          });
          return { record: recovered, resumeFrom: "settle" };
        }
        const updatedAt = Date.parse(existing.updatedAt ?? existing.createdAt ?? "");
        if (Number.isFinite(updatedAt)
          && updatedAt + (FLOAT_LOCK_TTL_SECONDS * 1000) > this.currentTime().getTime()) {
          throw new ExternalServiceError(
            "This payment authorization is already creating or reconciling Hub escrow. No external payment has settled. Wait briefly, then retry the same authorization.",
            "x402_posting_in_progress",
            {
              action: "retry_same_authorization",
              retryAfterSeconds: FLOAT_LOCK_TTL_SECONDS,
              posterFunds: "unchanged"
            }
          );
        }
        const recovered = await this.updateFunding(existing.id, {
          status: "reserved",
          recoveryAttemptedAt: this.currentTime().toISOString()
        });
        return { record: recovered, resumeFrom: "create" };
      }
      await this.assertFloatCapacity(reservedRaw);
      const now = this.currentTime().toISOString();
      const record = {
        id: verification.authorizationId,
        fundingRail: EXTERNAL_FUNDING_RAILS.X402,
        status: "reserved",
        draftId: draft.draftId,
        jobId: draft.jobId,
        posterWallet: verification.payer,
        pooledAccount,
        reservedRaw: reservedRaw.toString(),
        authorizationExpiresAt: verification.expiresAt,
        verifiedAt: verification.verifiedAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      return {
        record: await this.stateStore.upsertExternalPaymentFunding(record),
        resumeFrom: "create"
      };
    } finally {
      await this.stateStore.releaseClaimLock(FLOAT_LOCK_ID, owner);
    }
  }

  async inFlightFloatRaw() {
    const now = this.currentTime().getTime();
    const pageSize = 1_000;
    let offset = 0;
    let total = 0n;
    while (true) {
      const records = await this.stateStore.listExternalPaymentFundings({
        limit: pageSize,
        offset
      });
      for (const record of records) {
        if (!IN_FLIGHT_FLOAT_STATUSES.has(record?.status)) continue;
        if (
          record.status === "reserved"
          && record.authorizationExpiresAt
          && Date.parse(record.authorizationExpiresAt) <= now
        ) {
          continue;
        }
        total += exactUint(record.reservedRaw, "stored x402 float commitment");
      }
      if (records.length < pageSize) return total;
      offset += records.length;
    }
  }

  async updateFunding(id, patch) {
    const existing = await this.stateStore.getExternalPaymentFunding(id);
    if (!existing) {
      throw new ExternalServiceError(
        "Durable x402 funding record disappeared. The job was not advertised; contact support with the request ID.",
        "x402_funding_record_missing",
        { action: "contact_support" }
      );
    }
    return this.stateStore.upsertExternalPaymentFunding({
      ...existing,
      ...patch,
      updatedAt: this.currentTime().toISOString()
    });
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new ConfigError("x402 poster ramp clock returned an invalid date.");
    }
    return date;
  }
}

export function createX402PosterRampService({
  env = process.env,
  settlementAdapter,
  externalPostingService,
  stateStore,
  gateway,
  now,
  afterVerify
} = {}) {
  const config = resolveX402PosterRampConfig(env);
  if (!config.enabled) return undefined;
  return new X402PosterRampService({
    config,
    settlementAdapter,
    externalPostingService,
    stateStore,
    gateway,
    now,
    afterVerify
  });
}

function bazaarExtension() {
  return {
    discoverable: true,
    portable: true,
    info: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        body: {
          definition: {
            category: "coding",
            rewardAsset: "USDC",
            rewardAmount: "1",
            verifierMode: "benchmark",
            input: { task: "Describe the worker task." }
          }
        }
      },
      output: {
        type: "json",
        example: {
          status: "live",
          fundingRail: "x402",
          payment: { status: "settled" }
        }
      }
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["POST"] },
            bodyType: { type: "string", enum: ["json"] },
            body: { type: "object" }
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false
        },
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: { type: "object" }
          },
          required: ["type"]
        }
      },
      required: ["input"]
    }
  };
}

function paymentRequiredHeaders(envelope) {
  const encoded = Buffer.from(JSON.stringify(envelope)).toString("base64");
  return {
    "payment-required": encoded,
    "x-payment-required": encoded
  };
}

function paymentResponseHeaders(settlement) {
  const response = {
    success: true,
    transaction: settlement.receiptId,
    network: settlement.network,
    payer: settlement.payer,
    amount: settlement.amount
  };
  const encoded = Buffer.from(JSON.stringify(response)).toString("base64");
  return {
    "payment-response": encoded,
    "x-payment-response": encoded
  };
}

function normalizedFailure(stage, error, defaults) {
  return {
    stage,
    code: String(error?.code ?? `${stage}_failed`),
    message: String(error?.message ?? `${stage} failed`),
    action: String(error?.details?.action ?? defaults.action),
    posterFunds: String(error?.details?.posterFunds ?? defaults.posterFunds),
    lossOwner: stage === "settle" ? "platform" : undefined
  };
}

function exactUint(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new ExternalServiceError(`${label} must be an exact unsigned integer.`);
  }
  return BigInt(normalized);
}

function normalizePublicOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ConfigError("X402_PUBLIC_ORIGIN must be an absolute http(s) origin.");
  }
  if (!new Set(["https:", "http:"]).has(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError("X402_PUBLIC_ORIGIN must contain only scheme, host, and optional port.");
  }
  return url.origin;
}

function requireAddress(value, label) {
  if (!isAddress(String(value ?? ""))) {
    throw new ConfigError(`${label} must be an EVM address.`);
  }
  return getAddress(String(value)).toLowerCase();
}

// Deliberately preserves the value verbatim — no trimming. An EIP-712 domain
// string is hashed byte for byte, so "helpfully" normalising one would produce a
// domain separator the token does not recognise.
function requireNonEmpty(value, label, howToFind) {
  const raw = String(value ?? "");
  if (raw.trim() === "") {
    throw new ConfigError(
      `${label} is required when x402 posting is enabled — ${howToFind}.`
    );
  }
  return raw;
}

function requiredPositiveInteger(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new ConfigError(`${label} is required when x402 posting is enabled.`);
  }
  return optionalPositiveInteger(value, undefined, label);
}

function optionalPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${label} must be a positive integer.`);
  }
  return parsed;
}
