import {
  Contract,
  JsonRpcProvider,
  Signature,
  TypedDataEncoder,
  Wallet,
  getAddress,
  isAddress,
  verifyTypedData
} from "ethers";

import { hashCanonicalContent } from "../core/canonical-content.js";
import { ConfigError } from "../core/errors.js";
import { KmsSigner } from "../blockchain/kms-signer.js";
import {
  buildKmsCredentialsProvider,
  PROFILE_BLOCKCHAIN_SIGNER
} from "../services/aws-credentials.js";
import { PaymentVerificationError } from "./payment-errors.js";
import {
  assertX402PaymentMatchesRequirements,
  decodeX402PaymentProof,
  paymentRequiredHeaders
} from "./x402-payment-primitives.js";

export const VERIFY_X402_NETWORK = "eip155:8453";
export const VERIFY_X402_CHAIN_ID = 8453;
export const VERIFY_X402_CAPTURE_MARGIN_SECONDS = 10 * 60;

const VERIFY_PATH = "/verify/runs";
const BYTES32_RE = /^0x[a-fA-F0-9]{64}$/u;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/u;
const UINT_RE = /^\d+$/u;
const TOKEN_ABI = [
  "function name() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)"
];
const TRANSFER_WITH_AUTHORIZATION_TYPES = Object.freeze({
  TransferWithAuthorization: Object.freeze([
    Object.freeze({ name: "from", type: "address" }),
    Object.freeze({ name: "to", type: "address" }),
    Object.freeze({ name: "value", type: "uint256" }),
    Object.freeze({ name: "validAfter", type: "uint256" }),
    Object.freeze({ name: "validBefore", type: "uint256" }),
    Object.freeze({ name: "nonce", type: "bytes32" })
  ])
});

export function resolveX402VerificationPaymentConfig(env = process.env) {
  const mode = String(env.X402_VERIFY_MODE ?? "disabled").trim().toLowerCase();
  if (!new Set(["disabled", "enabled"]).has(mode)) {
    throw new ConfigError("X402_VERIFY_MODE must be disabled or enabled.");
  }
  if (mode === "disabled") return Object.freeze({ enabled: false, mode });

  const network = String(env.X402_PAYMENT_NETWORK ?? "").trim().toLowerCase();
  if (network !== VERIFY_X402_NETWORK) {
    throw new ConfigError("X402_PAYMENT_NETWORK must be eip155:8453 (Base) for standalone Verify.");
  }
  const rpcUrl = requireHttpUrl(env.BASE_RPC_URL, "BASE_RPC_URL");
  const asset = requireAddress(env.X402_PAYMENT_ASSET_ADDRESS, "X402_PAYMENT_ASSET_ADDRESS");
  const payTo = requireAddress(env.X402_PAYMENT_PAY_TO, "X402_PAYMENT_PAY_TO");
  const assetEip712Name = requireExactString(
    env.X402_PAYMENT_ASSET_EIP712_NAME,
    "X402_PAYMENT_ASSET_EIP712_NAME"
  );
  const assetEip712Version = requireExactString(
    env.X402_PAYMENT_ASSET_EIP712_VERSION,
    "X402_PAYMENT_ASSET_EIP712_VERSION"
  );
  const publicOrigin = requireOrigin(
    env.X402_PUBLIC_ORIGIN ?? env.PUBLIC_BASE_URL,
    "X402_PUBLIC_ORIGIN or PUBLIC_BASE_URL"
  );
  const captureMarginSeconds = optionalPositiveInteger(
    env.X402_VERIFY_CAPTURE_MARGIN_SECONDS,
    VERIFY_X402_CAPTURE_MARGIN_SECONDS,
    "X402_VERIFY_CAPTURE_MARGIN_SECONDS"
  );
  return Object.freeze({
    enabled: true,
    mode,
    network,
    chainId: VERIFY_X402_CHAIN_ID,
    rpcUrl,
    asset,
    payTo,
    assetEip712Name,
    assetEip712Version,
    publicOrigin,
    captureMarginSeconds
  });
}

export function createConfiguredX402VerificationPaymentGate(
  env = process.env,
  { logger = console, submitter, provider, tokenContract, captureTokenContract, now } = {}
) {
  try {
    const config = resolveX402VerificationPaymentConfig(env);
    if (!config.enabled) return undefined;
    const baseProvider = provider ?? new JsonRpcProvider(config.rpcUrl, config.chainId);
    return new X402VerificationPaymentGate({
      config,
      provider: baseProvider,
      tokenContract,
      captureTokenContract,
      submitter: captureTokenContract
        ? submitter
        : submitter ?? createBaseSubmitter(env, baseProvider, logger),
      now
    });
  } catch (error) {
    logger.warn?.(
      { reasonCode: "x402_verify_configuration_unavailable", err: error },
      "verification_payment_gate.unavailable"
    );
    return undefined;
  }
}

export class X402VerificationPaymentGate {
  constructor({
    config,
    provider,
    tokenContract,
    captureTokenContract,
    submitter,
    now = () => new Date()
  } = {}) {
    if (!config?.enabled) throw new ConfigError("X402VerificationPaymentGate requires enabled configuration.");
    this.config = config;
    this.provider = provider ?? new JsonRpcProvider(config.rpcUrl, config.chainId);
    this.token = tokenContract ?? new Contract(config.asset, TOKEN_ABI, this.provider);
    if (!captureTokenContract && !submitter) {
      throw new ConfigError("X402VerificationPaymentGate requires a Base transaction submitter.");
    }
    this.captureToken = captureTokenContract ?? new Contract(config.asset, TOKEN_ABI, submitter);
    this.now = now;
    this.domainPromise = undefined;
  }

  async authorize({ paymentProof, price, profile, profileLimits, requestHash } = {}) {
    const domain = await this.eip712Domain();
    const requirements = this.paymentRequirements({ domain, price, profile, profileLimits, requestHash });
    if (!String(paymentProof ?? "").trim()) {
      const envelope = this.paymentEnvelope(requirements);
      throw new PaymentVerificationError(
        "Payment is required before this standalone verification run can start. No work ran and no money moved.",
        "verification_payment_required",
        {
          action: "sign_payment_requirements_and_retry",
          customerFunds: "unchanged",
          paymentRequired: envelope,
          paymentRequiredHeaders: paymentRequiredHeaders(envelope)
        }
      );
    }

    const payload = decodeX402PaymentProof(paymentProof, { fundsField: "customerFunds" });
    assertX402PaymentMatchesRequirements(payload, requirements, { fundsField: "customerFunds" });
    const authorization = normalizeAuthorization(payload?.payload?.authorization, requirements);
    const signature = String(payload?.payload?.signature ?? "");
    if (!SIGNATURE_RE.test(signature)) {
      throw paymentRefusal(
        "The EIP-3009 signature must be a 65-byte hex signature. No money moved; sign a fresh authorization.",
        "payment_signature_invalid"
      );
    }

    const nowSeconds = BigInt(Math.floor(this.currentTime().getTime() / 1000));
    if (authorization.validAfter >= nowSeconds) {
      throw paymentRefusal(
        "The payment authorization is not valid yet. No money moved; sign a fresh authorization whose validAfter has passed.",
        "payment_authorization_not_yet_valid"
      );
    }
    const timeoutSeconds = timeoutSecondsFor(profileLimits);
    const requiredValidBefore = nowSeconds + BigInt(timeoutSeconds + this.config.captureMarginSeconds);
    if (authorization.validBefore < requiredValidBefore) {
      throw new PaymentVerificationError(
        `The payment authorization expires too soon. validBefore must cover the ${timeoutSeconds}-second profile timeout plus a ${this.config.captureMarginSeconds}-second capture margin. No work ran and no money moved; sign a fresh authorization.`,
        "payment_authorization_expiry_margin_insufficient",
        {
          action: "sign_fresh_authorization_with_longer_validity",
          customerFunds: "unchanged",
          requiredValidBefore: requiredValidBefore.toString(),
          observedValidBefore: authorization.validBefore.toString()
        }
      );
    }

    let recovered;
    try {
      recovered = getAddress(verifyTypedData(
        domain,
        TRANSFER_WITH_AUTHORIZATION_TYPES,
        authorization,
        signature
      ));
    } catch {
      throw paymentRefusal(
        "The transferWithAuthorization signature is invalid for the token's live EIP-712 name and domain. No money moved; request fresh terms and sign them unchanged.",
        "payment_signature_invalid"
      );
    }
    if (recovered !== authorization.from) {
      throw paymentRefusal(
        "The transferWithAuthorization signature does not match the stated payer. No money moved; sign with the payer wallet.",
        "payment_payer_mismatch"
      );
    }

    let used;
    try {
      used = await this.token.authorizationState(authorization.from, authorization.nonce);
    } catch {
      throw paymentRefusal(
        "Averray could not confirm the EIP-3009 nonce state on Base. No work ran and no money moved; retry when Base reads recover.",
        "payment_nonce_state_unavailable"
      );
    }
    if (used === true) {
      throw paymentRefusal(
        "This EIP-3009 authorization nonce is already used. No work ran; sign a fresh authorization.",
        "payment_authorization_used"
      );
    }

    return Object.freeze({
      id: hashCanonicalContent({
        network: this.config.network,
        asset: this.config.asset,
        payer: authorization.from.toLowerCase(),
        nonce: authorization.nonce.toLowerCase()
      }),
      customer: authorization.from.toLowerCase(),
      amountRaw: requirements.amount,
      asset: String(price.asset),
      network: this.config.network,
      paymentProof: String(paymentProof),
      requirements,
      authorization,
      signature
    });
  }

  async capture({ authorization }) {
    const proof = authorization.authorization;
    const signature = Signature.from(authorization.signature);
    const transaction = await this.captureToken.transferWithAuthorization(
      proof.from,
      proof.to,
      proof.value,
      proof.validAfter,
      proof.validBefore,
      proof.nonce,
      signature.v,
      signature.r,
      signature.s
    );
    const receipt = await transaction.wait();
    if (!receipt || Number(receipt.status) !== 1) {
      throw new Error("Base transferWithAuthorization was not confirmed successfully.");
    }
    return {
      transactionHash: String(transaction.hash),
      payer: authorization.customer,
      amountRaw: authorization.amountRaw,
      network: this.config.network
    };
  }

  async release() {
    return { submitted: false };
  }

  async eip712Domain() {
    this.domainPromise ??= this.readEip712Domain().catch((error) => {
      this.domainPromise = undefined;
      throw error;
    });
    return this.domainPromise;
  }

  async readEip712Domain() {
    try {
      const [network, liveName, onchainSeparator] = await Promise.all([
        this.provider.getNetwork(),
        this.token.name(),
        this.token.DOMAIN_SEPARATOR()
      ]);
      if (BigInt(network.chainId) !== BigInt(this.config.chainId)) {
        throw new Error(`Base RPC returned chainId ${network.chainId}.`);
      }
      if (String(liveName) !== this.config.assetEip712Name) {
        throw new Error(
          `Configured EIP-712 name ${JSON.stringify(this.config.assetEip712Name)} does not match token name() ${JSON.stringify(liveName)}.`
        );
      }
      const domain = Object.freeze({
        name: String(liveName),
        version: this.config.assetEip712Version,
        chainId: this.config.chainId,
        verifyingContract: this.config.asset
      });
      const reproduced = TypedDataEncoder.hashDomain(domain);
      if (!BYTES32_RE.test(String(onchainSeparator)) || reproduced.toLowerCase() !== String(onchainSeparator).toLowerCase()) {
        throw new Error("Token name(), version, chainId, and address do not reproduce DOMAIN_SEPARATOR().");
      }
      return domain;
    } catch (error) {
      throw new PaymentVerificationError(
        `Averray could not reproduce the Base token's EIP-712 domain from name(): ${error?.message ?? String(error)} No work ran and no money moved.`,
        "payment_domain_unavailable",
        { action: "retry_when_base_domain_reads_recover", customerFunds: "unchanged" }
      );
    }
  }

  paymentRequirements({ domain, price, profile, profileLimits, requestHash }) {
    const timeoutSeconds = timeoutSecondsFor(profileLimits);
    return Object.freeze({
      scheme: "exact",
      network: this.config.network,
      asset: this.config.asset,
      amount: exactUint(price?.amountRaw, "profile price").toString(),
      payTo: this.config.payTo,
      maxTimeoutSeconds: timeoutSeconds + this.config.captureMarginSeconds,
      extra: Object.freeze({
        name: domain.name,
        version: domain.version,
        profile: String(profile),
        requestHash: String(requestHash)
      })
    });
  }

  paymentEnvelope(requirements) {
    return {
      x402Version: 2,
      error: "Payment required to run this Averray verification profile.",
      resource: this.paymentResource(),
      accepts: [requirements]
    };
  }

  paymentResource() {
    return {
      url: new URL(VERIFY_PATH, this.config.publicOrigin).toString(),
      description: "Run a pinned Averray verification profile. Inconclusive runs are never charged.",
      mimeType: "application/json",
      serviceName: "Averray Verify"
    };
  }

  currentTime() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new ConfigError("Verify payment clock returned an invalid date.");
    return date;
  }
}

function normalizeAuthorization(value, requirements) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw paymentRefusal("The payment proof is missing its EIP-3009 authorization. No money moved.", "payment_authorization_invalid");
  }
  if (!isAddress(String(value.from ?? "")) || !isAddress(String(value.to ?? ""))) {
    throw paymentRefusal("The payment authorization contains an invalid payer or recipient. No money moved.", "payment_authorization_invalid");
  }
  const from = getAddress(String(value.from));
  const to = getAddress(String(value.to));
  if (to.toLowerCase() !== String(requirements.payTo).toLowerCase()) {
    throw paymentRefusal("The payment authorization recipient is not Averray's configured Base receiver. No money moved.", "payment_recipient_mismatch");
  }
  const normalizedValue = authorizationUint(value.value, "authorization value");
  if (normalizedValue !== exactUint(requirements.amount, "required amount")) {
    throw new PaymentVerificationError(
      "The authorization value must equal the exact profile price; underpayment and overpayment are both refused. No money moved.",
      "payment_exact_price_required",
      {
        action: "sign_exact_advertised_amount",
        customerFunds: "unchanged",
        expectedAmountRaw: String(requirements.amount),
        observedAmountRaw: normalizedValue.toString()
      }
    );
  }
  if (!BYTES32_RE.test(String(value.nonce ?? ""))) {
    throw paymentRefusal("The payment authorization nonce must be bytes32. No money moved.", "payment_authorization_invalid");
  }
  return Object.freeze({
    from,
    to,
    value: normalizedValue,
    validAfter: authorizationUint(value.validAfter, "validAfter"),
    validBefore: authorizationUint(value.validBefore, "validBefore"),
    nonce: String(value.nonce)
  });
}

function paymentRefusal(message, code) {
  return new PaymentVerificationError(message, code, {
    action: "sign_fresh_authorization",
    customerFunds: "unchanged"
  });
}

function timeoutSecondsFor(profileLimits) {
  const timeoutMs = Number(profileLimits?.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError("Verification profile must publish a positive integer timeoutMs before payment can be accepted.");
  }
  return Math.ceil(timeoutMs / 1000);
}

function exactUint(value, label) {
  const normalized = String(value ?? "").trim();
  if (!UINT_RE.test(normalized)) throw new ConfigError(`${label} must be an exact unsigned integer.`);
  return BigInt(normalized);
}

function authorizationUint(value, label) {
  try {
    return exactUint(value, label);
  } catch {
    throw paymentRefusal(
      `The payment authorization ${label} must be an exact unsigned integer. No money moved.`,
      "payment_authorization_invalid"
    );
  }
}

function requireAddress(value, label) {
  if (!isAddress(String(value ?? ""))) throw new ConfigError(`${label} must be an EVM address.`);
  return getAddress(String(value)).toLowerCase();
}

function requireExactString(value, label) {
  const raw = String(value ?? "");
  if (raw.trim() === "") throw new ConfigError(`${label} is required when X402_VERIFY_MODE is enabled.`);
  return raw;
}

function requireHttpUrl(value, label) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ConfigError(`${label} must be an absolute HTTP(S) URL when X402_VERIFY_MODE is enabled.`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new ConfigError(`${label} must use HTTP or HTTPS.`);
  }
  return url.toString();
}

function requireOrigin(value, label) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ConfigError(`${label} must be an absolute origin when X402_VERIFY_MODE is enabled.`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError(`${label} must contain only scheme, host, and optional port.`);
  }
  return url.origin;
}

function optionalPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ConfigError(`${label} must be a positive integer.`);
  return parsed;
}

function createBaseSubmitter(env, provider, logger) {
  const backend = String(env.SIGNER_BACKEND ?? "local").trim().toLowerCase();
  if (backend === "kms") {
    const keyId = String(env.KMS_KEY_ID ?? "").trim();
    const region = String(env.AWS_REGION ?? "").trim();
    if (!keyId || !region) {
      throw new ConfigError("KMS_KEY_ID and AWS_REGION are required to submit Verify captures on Base.");
    }
    const credentialsProvider = buildKmsCredentialsProvider({
      profile: PROFILE_BLOCKCHAIN_SIGNER,
      env
    });
    return new KmsSigner({
      keyId,
      region,
      provider,
      logger,
      ...(credentialsProvider ? { credentialsProvider } : {})
    });
  }
  if (backend !== "local") {
    throw new ConfigError(`Unsupported SIGNER_BACKEND ${JSON.stringify(backend)} for Verify capture.`);
  }
  const privateKey = String(env.SIGNER_PRIVATE_KEY ?? "").trim();
  if (!privateKey) {
    throw new ConfigError("SIGNER_PRIVATE_KEY is required to submit Verify captures when SIGNER_BACKEND=local.");
  }
  return new Wallet(privateKey, provider);
}
