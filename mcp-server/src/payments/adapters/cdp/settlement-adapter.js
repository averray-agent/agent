import { createPrivateKey, randomBytes, sign } from "node:crypto";

import { getAddress, id, isAddress } from "ethers";
import { ConfigError } from "../../../core/errors.js";
import {
  PaymentSettlementError,
  PaymentSettlementOutcomeUnknownError,
  PaymentVerificationError
} from "../../settlement-adapter.js";

const CDP_DEFAULT_BASE_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const CDP_REQUEST_HOST = "api.cdp.coinbase.com";
const JWT_ISSUER = "cdp";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function resolveCdpSettlementConfig(env = process.env) {
  const baseUrl = new URL(
    String(env.X402_SETTLEMENT_API_URL ?? CDP_DEFAULT_BASE_URL).trim()
  );
  if (baseUrl.protocol !== "https:") {
    throw new ConfigError("X402_SETTLEMENT_API_URL must use HTTPS.");
  }
  const apiKeyId = String(env.X402_SETTLEMENT_API_KEY_ID ?? "").trim();
  const apiKeySecret = String(env.X402_SETTLEMENT_API_KEY_SECRET ?? "").trim();
  if (!apiKeyId || !apiKeySecret) {
    throw new ConfigError(
      "x402 settlement requires X402_SETTLEMENT_API_KEY_ID and X402_SETTLEMENT_API_KEY_SECRET."
    );
  }
  const timeoutMs = parsePositiveInteger(
    env.X402_SETTLEMENT_REQUEST_TIMEOUT_MS,
    10_000,
    "X402_SETTLEMENT_REQUEST_TIMEOUT_MS"
  );
  return Object.freeze({ baseUrl, apiKeyId, apiKeySecret, timeoutMs });
}

export class CdpSettlementAdapter {
  constructor({
    config,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    generateAuthorization = generateCdpAuthorization
  } = {}) {
    if (!config?.baseUrl || !config?.apiKeyId || !config?.apiKeySecret) {
      throw new ConfigError("CDP settlement adapter requires complete configuration.");
    }
    if (typeof fetchImpl !== "function") {
      throw new ConfigError("CDP settlement adapter requires fetch().");
    }
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.generateAuthorization = generateAuthorization;
  }

  async verify({ paymentProof, requirements, resource, extensions }) {
    const paymentPayload = enrichPaymentPayload(
      decodePaymentProof(paymentProof),
      { resource, extensions }
    );
    assertPaymentMatchesRequirements(paymentPayload, requirements);
    const { body } = await this.request("verify", paymentPayload, requirements, {
      outcomeUnknown: false
    });
    if (body?.isValid !== true) {
      const failure = normalizeVerificationFailure(body);
      throw new PaymentVerificationError(failure.message, failure.code, failure.details);
    }
    const authorizedPayer = normalizePayer(paymentPayload?.payload?.authorization?.from);
    const payer = normalizePayer(body?.payer ?? authorizedPayer);
    if (payer !== authorizedPayer) {
      throw new PaymentVerificationError(
        "The verifier returned a payer that does not match the signed authorization. No money moved. Request a fresh 402 response and rebuild the payment header.",
        "payment_payer_mismatch",
        { action: "retry_for_fresh_authorization", posterFunds: "unchanged" }
      );
    }
    const authorization = paymentPayload?.payload?.authorization ?? {};
    return {
      authorizationId: id([
        "x402",
        requirements.network,
        String(authorization.nonce ?? ""),
        payer
      ].join(":")),
      payer,
      expiresAt: normalizeAuthorizationExpiry(authorization.validBefore),
      verifiedAt: this.currentTime().toISOString()
    };
  }

  async settle({ paymentProof, requirements, resource, extensions }) {
    const paymentPayload = enrichPaymentPayload(
      decodePaymentProof(paymentProof),
      { resource, extensions }
    );
    assertPaymentMatchesRequirements(paymentPayload, requirements);
    const { body, headers } = await this.request("settle", paymentPayload, requirements, {
      outcomeUnknown: true
    });
    if (body?.success !== true) {
      const failure = normalizeSettlementFailure(body);
      throw new PaymentSettlementError(failure.message, failure.code, failure.details);
    }
    const authorizedPayer = normalizePayer(paymentPayload?.payload?.authorization?.from);
    const payer = normalizePayer(body?.payer ?? authorizedPayer, {
      settlementOutcomeUnknown: true
    });
    const amount = normalizeAmount(body?.amount ?? requirements.amount);
    if (payer !== authorizedPayer || amount !== String(requirements.amount)) {
      throw new PaymentSettlementOutcomeUnknownError(
        "Settlement reported success with details that do not match the signed authorization. The job was delisted; check the payer wallet and contact support before doing anything else.",
        { action: "check_wallet_and_contact_support", posterFunds: "unknown" }
      );
    }
    return {
      receiptId: normalizeReceiptId(body?.transaction),
      network: String(requirements.network),
      payer,
      amount,
      settledAt: this.currentTime().toISOString(),
      discovery: normalizeDiscoveryResponse(headers?.get?.("extension-responses"))
    };
  }

  async request(operation, paymentPayload, paymentRequirements, { outcomeUnknown }) {
    const path = `${this.config.baseUrl.pathname.replace(/\/$/u, "")}/${operation}`;
    const url = new URL(path, this.config.baseUrl.origin);
    const authorization = await this.generateAuthorization({
      apiKeyId: this.config.apiKeyId,
      apiKeySecret: this.config.apiKeySecret,
      requestMethod: "POST",
      requestHost: url.host,
      requestPath: url.pathname,
      now: this.currentTime()
    });
    let response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${authorization}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload,
          paymentRequirements
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });
    } catch {
      if (outcomeUnknown) {
        throw new PaymentSettlementOutcomeUnknownError(
          "The settlement service did not confirm whether payment completed. The job was delisted; do not submit another payment. Check the payer wallet on Base and contact support with the request ID.",
          { action: "check_wallet_and_contact_support", posterFunds: "unknown" }
        );
      }
      throw new PaymentVerificationError(
        "The payment verifier is temporarily unreachable. No money moved. Wait briefly, request a fresh 402 response, and retry.",
        "payment_verifier_unavailable",
        { action: "retry_for_fresh_challenge", posterFunds: "unchanged" }
      );
    }

    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      if (outcomeUnknown && response.status >= 500) {
        throw new PaymentSettlementOutcomeUnknownError(
          "The settlement service returned an indeterminate server error. The job was delisted; do not pay again. Check the payer wallet on Base and contact support with the request ID.",
          { action: "check_wallet_and_contact_support", posterFunds: "unknown" }
        );
      }
      if (outcomeUnknown) {
        const failure = normalizeSettlementFailure(body);
        throw new PaymentSettlementError(failure.message, failure.code, failure.details);
      }
      const failure = normalizeVerificationFailure(body);
      throw new PaymentVerificationError(failure.message, failure.code, failure.details);
    }
    return { body, headers: response.headers };
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new ConfigError("Settlement adapter clock returned an invalid date.");
    }
    return date;
  }
}

export async function generateCdpAuthorization({
  apiKeyId,
  apiKeySecret,
  requestMethod,
  requestHost = CDP_REQUEST_HOST,
  requestPath,
  now = new Date()
}) {
  const secret = decodeEd25519Secret(apiKeySecret);
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, secret.subarray(0, 32)]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = {
    alg: "EdDSA",
    kid: apiKeyId,
    nonce: randomBytes(16).toString("hex"),
    typ: "JWT"
  };
  const payload = {
    sub: apiKeyId,
    iss: JWT_ISSUER,
    uri: `${String(requestMethod).toUpperCase()} ${requestHost}${requestPath}`,
    nbf: issuedAt,
    iat: issuedAt,
    exp: issuedAt + 120
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function decodePaymentProof(value) {
  const encoded = String(value ?? "").trim();
  if (!encoded) {
    throw new PaymentVerificationError(
      "X-PAYMENT (or PAYMENT-SIGNATURE) is required. Sign the advertised payment requirements and retry.",
      "payment_proof_required",
      { action: "sign_payment_requirements", posterFunds: "unchanged" }
    );
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw new PaymentVerificationError(
      "The payment header is not valid base64-encoded x402 JSON. Rebuild it from the latest 402 response and retry.",
      "payment_proof_malformed",
      { action: "rebuild_payment_header", posterFunds: "unchanged" }
    );
  }
}

function enrichPaymentPayload(paymentPayload, { resource, extensions }) {
  return {
    ...paymentPayload,
    ...(resource ? { resource: cloneJson(resource) } : {}),
    ...(extensions ? {
      // Resource-server declarations are authoritative. Do not let a payer
      // add facilitator extensions that this route did not advertise.
      extensions: cloneJson(extensions)
    } : {})
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertPaymentMatchesRequirements(payload, requirements) {
  const accepted = payload?.accepted;
  const comparable = ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"];
  if (Number(payload?.x402Version) !== 2 || !accepted) {
    throw new PaymentVerificationError(
      "The payment payload is not x402 v2. Rebuild it from the latest 402 response.",
      "payment_version_unsupported",
      { action: "use_latest_402_response", posterFunds: "unchanged" }
    );
  }
  for (const field of comparable) {
    if (String(accepted[field] ?? "").toLowerCase() !== String(requirements?.[field] ?? "").toLowerCase()) {
      throw new PaymentVerificationError(
        `The payment payload changed the advertised ${field}. Rebuild it from the latest 402 response and do not edit payment terms.`,
        "payment_requirements_mismatch",
        { field, action: "use_unchanged_payment_requirements", posterFunds: "unchanged" }
      );
    }
  }
}

function normalizeVerificationFailure(body) {
  const reason = String(body?.invalidReason ?? body?.errorType ?? "").toLowerCase();
  if (reason === "insufficient_funds") {
    return {
      code: "payment_insufficient_funds",
      message: "The payer does not have enough USDC on the advertised network. No money moved. Fund that wallet or choose another one, then request a fresh 402 response.",
      details: { action: "fund_or_change_wallet", posterFunds: "unchanged" }
    };
  }
  if (/signature|authorization/u.test(reason)) {
    return {
      code: "payment_authorization_invalid",
      message: "The payment authorization is invalid or expired. No money moved. Request a fresh 402 response and sign its payment terms unchanged.",
      details: { action: "retry_for_fresh_authorization", posterFunds: "unchanged" }
    };
  }
  if (/unavailable|gateway|server/u.test(reason)) {
    return {
      code: "payment_verifier_unavailable",
      message: "The payment verifier is temporarily unavailable. No money moved. Wait briefly, request a fresh 402 response, and retry.",
      details: { action: "retry_for_fresh_challenge", posterFunds: "unchanged" }
    };
  }
  return {
    code: "payment_verification_failed",
    message: "The payment could not be verified. No money moved. Request a fresh 402 response, rebuild both headers exactly, and retry.",
    details: { action: "retry_for_fresh_challenge", posterFunds: "unchanged" }
  };
}

function normalizeSettlementFailure(body) {
  const reason = String(body?.errorReason ?? body?.errorType ?? "").toLowerCase();
  if (reason === "insufficient_funds") {
    return {
      code: "payment_settlement_insufficient_funds",
      message: "Settlement failed because the payer balance changed after verification. The job was delisted and Averray absorbed the Hub escrow exposure. Request a fresh 402 response before trying again.",
      details: {
        action: "retry_for_fresh_authorization",
        job: "delisted",
        lossOwner: "platform",
        posterFunds: "not_settled"
      }
    };
  }
  return {
    code: "payment_settlement_failed",
    message: "Settlement failed after Hub escrow creation. The job was delisted and Averray recorded the exposure as its own. Do not reuse this payment; request a fresh 402 response before retrying.",
    details: {
      action: "retry_for_fresh_authorization",
      job: "delisted",
      lossOwner: "platform",
      posterFunds: "not_settled"
    }
  };
}

function normalizePayer(value, { settlementOutcomeUnknown = false } = {}) {
  if (!isAddress(String(value ?? ""))) {
    if (settlementOutcomeUnknown) {
      throw new PaymentSettlementOutcomeUnknownError(
        "Settlement reported success without a valid payer. The job was delisted; check the payer wallet on Base and contact support before doing anything else.",
        { action: "check_wallet_and_contact_support", posterFunds: "unknown" }
      );
    }
    throw new PaymentVerificationError(
      "The payment authorization does not contain a valid payer address. No money moved. Request a fresh 402 response and rebuild the payment header.",
      "payment_payer_invalid",
      { action: "retry_for_fresh_authorization", posterFunds: "unchanged" }
    );
  }
  return getAddress(String(value)).toLowerCase();
}

function normalizeAuthorizationExpiry(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function normalizeReceiptId(value) {
  const receipt = String(value ?? "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(receipt)) {
    throw new PaymentSettlementOutcomeUnknownError(
      "Settlement reported success without a usable receipt. The job was delisted; check the payer wallet and contact support before doing anything else.",
      { action: "check_wallet_and_contact_support", posterFunds: "unknown" }
    );
  }
  return receipt;
}

function normalizeAmount(value) {
  const amount = String(value ?? "").trim();
  if (!/^\d+$/u.test(amount)) {
    throw new PaymentSettlementOutcomeUnknownError(
      "Settlement reported success without an exact amount. The job was delisted; check the payer wallet and contact support.",
      { action: "check_wallet_and_contact_support", posterFunds: "unknown" }
    );
  }
  return amount;
}

function normalizeDiscoveryResponse(value) {
  if (!value) return { discoverable: true, portable: true, status: "not_reported" };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    const status = new Set(["success", "processing", "rejected"]).has(parsed?.bazaar?.status)
      ? parsed.bazaar.status
      : "not_reported";
    return { discoverable: true, portable: true, status };
  } catch {
    return { discoverable: true, portable: true, status: "not_reported" };
  }
}

function decodeEd25519Secret(value) {
  let decoded;
  try {
    decoded = Buffer.from(String(value ?? ""), "base64");
  } catch {
    decoded = Buffer.alloc(0);
  }
  if (decoded.length < 32) {
    throw new ConfigError("X402_SETTLEMENT_API_KEY_SECRET must be a base64 Ed25519 secret.");
  }
  return decoded;
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
