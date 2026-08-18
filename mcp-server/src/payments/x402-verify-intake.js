import { randomUUID } from "node:crypto";

import { getAddress, isAddress } from "ethers";

import { hashCanonicalContent } from "../core/canonical-content.js";
import {
  AppError,
  ConfigError,
  ConflictError,
  ExternalServiceError,
  ValidationError
} from "../core/errors.js";
import {
  VERIFY_PAYMENT_NETWORK,
  VERIFY_PRICE_RAW
} from "../services/verification-profile-registry.js";
import { validateGitPatchTestsRequest } from "../services/git-patch-tests-request.js";

const VERIFY_PATH = "/verify/runs";
const PAYMENT_LOCK_TTL_SECONDS = 30;

export function resolveX402VerifyConfig(env = process.env) {
  const mode = String(env.X402_VERIFY_MODE ?? "disabled").trim().toLowerCase();
  if (!new Set(["disabled", "enabled"]).has(mode)) {
    throw new ConfigError("X402_VERIFY_MODE must be disabled or enabled.");
  }
  if (mode === "disabled") return Object.freeze({ enabled: false, mode });
  const publicOrigin = normalizePublicOrigin(env.X402_PUBLIC_ORIGIN);
  const network = String(env.X402_PAYMENT_NETWORK ?? "").trim().toLowerCase();
  if (network !== VERIFY_PAYMENT_NETWORK) {
    throw new ConfigError("Averray Verify accepts x402 payment only on Base (eip155:8453).");
  }
  return Object.freeze({
    enabled: true,
    mode,
    publicOrigin,
    network,
    asset: requireAddress(env.X402_PAYMENT_ASSET_ADDRESS, "X402_PAYMENT_ASSET_ADDRESS"),
    payTo: requireAddress(env.X402_PAYMENT_PAY_TO, "X402_PAYMENT_PAY_TO"),
    assetEip712Name: requireDomainValue(
      env.X402_PAYMENT_ASSET_EIP712_NAME,
      "X402_PAYMENT_ASSET_EIP712_NAME"
    ),
    assetEip712Version: requireDomainValue(
      env.X402_PAYMENT_ASSET_EIP712_VERSION,
      "X402_PAYMENT_ASSET_EIP712_VERSION"
    ),
    maxTimeoutSeconds: optionalPositiveInteger(
      env.X402_VERIFY_PAYMENT_TIMEOUT_SECONDS,
      600,
      "X402_VERIFY_PAYMENT_TIMEOUT_SECONDS"
    )
  });
}

/**
 * Payment is the authorization to compute. This intake has no SIWE, Hub float,
 * bridge, escrow gateway, worker payout, or job-settlement dependency.
 */
export class X402VerifyIntake {
  constructor({ config, facilitator, verificationRunService, stateStore, now = () => new Date() } = {}) {
    if (!config?.enabled) throw new ConfigError("X402VerifyIntake requires enabled configuration.");
    if (!facilitator?.verify || !facilitator?.collect) {
      throw new ConfigError("X402VerifyIntake requires an x402 payment facilitator.");
    }
    if (!verificationRunService || !stateStore) {
      throw new ConfigError("X402VerifyIntake requires the run service and durable state.");
    }
    this.config = config;
    this.facilitator = facilitator;
    this.verificationRunService = verificationRunService;
    this.stateStore = stateStore;
    this.now = now;
  }

  paymentRequired(payload) {
    const profile = resolveRequestedProfile(this.verificationRunService, payload);
    const requirements = this.paymentRequirements(profile.price.amountRaw);
    const envelope = {
      x402Version: 2,
      error: `Payment required to run ${profile.name}@${profile.version}.`,
      resource: this.paymentResource(),
      accepts: [requirements],
      extensions: { bazaar: bazaarExtension(profile) },
      discoverable: true,
      portableListing: true
    };
    return { statusCode: 402, body: envelope, headers: paymentRequiredHeaders(envelope) };
  }

  async run({ payload, paymentProof }) {
    const profile = resolveRequestedProfile(this.verificationRunService, payload);
    const requirements = this.paymentRequirements(profile.price.amountRaw);
    const context = this.facilitatorContext(profile);
    // Verification checks the signed Base authorization but moves no money.
    const authorization = await this.facilitator.verify({
      paymentProof,
      requirements,
      ...context
    });
    const requestHash = hashCanonicalContent({
      profile: `${profile.name}@${profile.version}`,
      target: payload.target,
      inputs: payload.inputs
    });
    const reservation = await this.reserveAuthorization({ authorization, requestHash });
    if (reservation.status === "complete") {
      const run = await this.verificationRunService.getRun(reservation.runId);
      return responseFor(run, reservation.payment);
    }

    const evaluated = await this.verificationRunService.execute({
      profile: profile.name,
      profileVersion: profile.version,
      customer: authorization.payer,
      target: payload.target,
      inputs: payload.inputs
    });
    await this.stateStore.upsertVerificationPayment({
      ...reservation,
      status: "evaluated",
      runId: evaluated.runId,
      updatedAt: this.currentTime().toISOString()
    });

    if (["inconclusive", "platform_fault"].includes(evaluated.verdict?.outcome)) {
      const completed = await this.verificationRunService.finalize(evaluated.runId);
      const payment = {
        status: "not_billed",
        network: profile.price.network,
        amountRaw: "0",
        payer: authorization.payer
      };
      await this.stateStore.upsertVerificationPayment({
        ...reservation,
        status: "complete",
        runId: completed.runId,
        payment,
        updatedAt: this.currentTime().toISOString()
      });
      return responseFor(await this.verificationRunService.getRun(completed.runId), payment);
    }

    // Only a conclusive run collects the already-verified Base authorization.
    const collected = await this.facilitator.collect({
      paymentProof,
      requirements,
      ...context
    });
    const payment = {
      status: "settled",
      network: collected.network,
      amountRaw: collected.amount,
      payer: collected.payer,
      receiptId: collected.receiptId,
      settledAt: collected.settledAt
    };
    const completed = await this.verificationRunService.finalize(evaluated.runId, { payment });
    await this.stateStore.upsertVerificationPayment({
      ...reservation,
      status: "complete",
      runId: completed.runId,
      payment,
      updatedAt: this.currentTime().toISOString()
    });
    return responseFor(await this.verificationRunService.getRun(completed.runId), payment);
  }

  paymentRequirements(amountRaw) {
    if (String(amountRaw) !== VERIFY_PRICE_RAW) {
      throw new ValidationError("Published verification price must remain the ratified $5 flat fee.");
    }
    return {
      scheme: "exact",
      network: this.config.network,
      asset: this.config.asset,
      amount: String(amountRaw),
      payTo: this.config.payTo,
      maxTimeoutSeconds: this.config.maxTimeoutSeconds,
      extra: { name: this.config.assetEip712Name, version: this.config.assetEip712Version }
    };
  }

  paymentResource() {
    return {
      url: new URL(VERIFY_PATH, this.config.publicOrigin).toString(),
      description: "Run a pinned Averray verification profile against a customer-supplied artifact.",
      mimeType: "application/json",
      serviceName: "Averray",
      tags: ["agents", "verification", "tested-by-averray", "base"]
    };
  }

  facilitatorContext(profile) {
    return {
      resource: this.paymentResource(),
      extensions: { bazaar: bazaarExtension(profile) }
    };
  }

  async reserveAuthorization({ authorization, requestHash }) {
    const lockId = `verify-payment:${authorization.authorizationId}`;
    const owner = randomUUID();
    const acquired = await this.stateStore.acquireClaimLock(lockId, owner, PAYMENT_LOCK_TTL_SECONDS);
    if (acquired === false) {
      throw new ExternalServiceError(
        "This payment authorization is already starting a verification run. Retry the same request shortly.",
        "verification_payment_in_progress",
        { action: "retry_same_authorization", customerFunds: "unchanged" }
      );
    }
    try {
      const existing = await this.stateStore.getVerificationPayment(authorization.authorizationId);
      if (existing && existing.requestHash !== requestHash) {
        throw new ConflictError(
          "This payment authorization is already bound to a different verification request.",
          "verification_payment_already_used",
          { action: "inspect_existing_run", customerFunds: "unchanged_or_already_settled" }
        );
      }
      if (existing?.status === "complete") return existing;
      if (existing) {
        throw new ExternalServiceError(
          "This payment authorization already has a verification run in progress. Retry the same request shortly; no second run or payment was started.",
          "verification_payment_in_progress",
          { action: "retry_same_authorization", customerFunds: "unchanged" }
        );
      }
      const at = this.currentTime().toISOString();
      return this.stateStore.upsertVerificationPayment({
        id: authorization.authorizationId,
        status: "verified",
        requestHash,
        payer: authorization.payer,
        authorizationExpiresAt: authorization.expiresAt,
        verifiedAt: authorization.verifiedAt,
        createdAt: at,
        updatedAt: at
      });
    } finally {
      await this.stateStore.releaseClaimLock(lockId, owner);
    }
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new ConfigError("Verify intake clock is invalid.");
    return date;
  }
}

function resolveRequestedProfile(service, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Verification request body must be an object.");
  }
  const name = String(payload.profile ?? "").trim();
  const version = Number(payload.profileVersion ?? 1);
  const profile = service.listProfiles().find((candidate) => (
    candidate.name === name && candidate.version === version && candidate.status === "published"
  ));
  if (!profile) throw new ValidationError(`Unknown published verification profile ${name}@${version}.`);
  validateGitPatchTestsRequest(profile, payload.target, payload.inputs);
  return profile;
}

function responseFor(run, payment) {
  const body = { ...run, payment };
  if (payment?.status !== "settled") return { statusCode: 200, body, headers: {} };
  const encoded = Buffer.from(JSON.stringify({
    success: true,
    transaction: payment.receiptId,
    network: payment.network,
    payer: payment.payer,
    amount: payment.amountRaw
  })).toString("base64");
  return {
    statusCode: 200,
    body,
    headers: { "payment-response": encoded, "x-payment-response": encoded }
  };
}

function bazaarExtension(profile) {
  return {
    discoverable: true,
    portable: true,
    info: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        body: {
          profile: profile.name,
          profileVersion: profile.version,
          target: { repository: "github.com/example/repository", commit: "<40 lowercase hex>" },
          inputs: { bundle: "<hash-pinned HTTPS git bundle>", patch: "<hash-pinned HTTPS patch>", testCommand: ["npm", "test"] }
        }
      },
      output: { type: "json", example: { status: "complete", receiptId: "0x…" } }
    }
  };
}

function paymentRequiredHeaders(envelope) {
  const encoded = Buffer.from(JSON.stringify(envelope)).toString("base64");
  return { "payment-required": encoded, "x-payment-required": encoded };
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
  if (!isAddress(String(value ?? ""))) throw new ConfigError(`${label} must be an EVM address.`);
  return getAddress(String(value)).toLowerCase();
}

function requireDomainValue(value, label) {
  const raw = String(value ?? "");
  if (!raw.trim()) throw new ConfigError(`${label} is required when Averray Verify is enabled.`);
  return raw;
}

function optionalPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ConfigError(`${label} must be positive.`);
  return parsed;
}

export function actionableVerifyPaymentError(error) {
  if (error instanceof AppError && String(error.code).startsWith("payment_")) {
    const outcomeUnknown = error.code === "payment_settlement_outcome_unknown";
    const { posterFunds, ...details } = error.details ?? {};
    return new AppError(
      outcomeUnknown
        ? "The Base payment outcome is unknown. Do not authorize another payment; inspect the payer wallet and contact support."
        : "The standalone verification payment was not accepted. Follow the returned action before retrying.",
      {
        name: error.name,
        code: error.code,
        statusCode: error.statusCode,
        details: {
          ...details,
          customerFunds: posterFunds ?? (outcomeUnknown ? "unknown" : "unchanged")
        }
      }
    );
  }
  if (error instanceof AppError) return error;
  return new AppError(error?.message ?? "Averray Verify payment failed.", {
    name: "X402VerifyError",
    code: "x402_verify_failed",
    statusCode: 502,
    details: { action: "check_wallet_and_contact_support", customerFunds: "unknown" }
  });
}
