import {
  Contract,
  ZeroAddress,
  getAddress,
  verifyMessage
} from "ethers";

import { buildSiweMessage } from "../auth/siwe.js";
import { canonicalizeContent } from "../core/canonical-content.js";
import { ConfigError, ConflictError, ExternalServiceError, ValidationError } from "../core/errors.js";
import { hashLockedTierTerms } from "./locked-tier-service.js";

export const IDLE_BALANCE_ALLOCATION_ROUTE_LIVE_ENV = "IDLE_BALANCE_ALLOCATION_ROUTE_LIVE";
export const IDLE_BALANCE_AMOUNT_BASIS =
  "At each allocation attempt, only unreserved AAC liquid above the configured working-capital floor is eligible; this consent does not authorize a fixed amount.";
export const IDLE_BALANCE_ACTIVE_VENUE_DISCLOSURE =
  "Eligible idle USDC may be routed through the configured DepositPoolV2 strategy adapter and deployed from that pool to its configured external venue.";
export const IDLE_BALANCE_ACTIVE_FUNDS_MOVEMENT =
  "Funds leave position.liquid and are deployed through the configured DepositPoolV2 strategy adapter to an external venue. Principal is at risk, and return is not instant in all cases.";
export const IDLE_BALANCE_UNBOUND_VENUE_DISCLOSURE =
  "No external venue is bound and no venue deployment is active. Eligible idle USDC is held in the DepositPoolV2 buffer with no venue exposure and no venue yield today.";
export const IDLE_BALANCE_BOUND_INACTIVE_VENUE_DISCLOSURE =
  "An external venue is configured, but no venue deployment is active. Eligible idle USDC is held in the DepositPoolV2 buffer with no venue exposure and no venue yield today.";
export const IDLE_BALANCE_BUFFER_FUNDS_MOVEMENT =
  "Funds leave position.liquid and are held in the DepositPoolV2 buffer. There is no external venue exposure and no venue yield today. Principal is at risk, and return is not instant in all cases.";
export const IDLE_BALANCE_RETURN_TERMS =
  "Deallocation returns to position.liquid synchronously while the adapter's uncommitted balance covers it; otherwise it queues with a disclosed ETA.";

const IDLE_BALANCE_POOL_ABI = [
  "function venueAdapter() view returns (address)",
  "function activeVenueDeploymentId() view returns (uint256)"
];

const PRODUCT = "idle-balance allocation";
const QUOTE_TTL_MS = 10 * 60 * 1_000;
const CONSENT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const TERMS_FIELDS = new Set([
  "schemaVersion",
  "wallet",
  "product",
  "amountBasis",
  "asset",
  "venue",
  "venueDisclosure",
  "fundsMovement",
  "returnTerms",
  "consentNonce",
  "issuedAt",
  "quoteExpiresAt",
  "consentExpiresAt"
]);

export function loadIdleBalanceConsentConfig(env = process.env, {
  chainId,
  assetAddress,
  depositPoolAddress
} = {}) {
  const routeLive = parseBoolean(
    env[IDLE_BALANCE_ALLOCATION_ROUTE_LIVE_ENV],
    false,
    IDLE_BALANCE_ALLOCATION_ROUTE_LIVE_ENV
  );
  const config = {
    routeLive,
    chainId: Number(chainId),
    assetAddress: optionalAddress(assetAddress),
    depositPoolAddress: optionalAddress(depositPoolAddress)
  };
  if (routeLive) assertLiveRouteConfig(config);
  return config;
}

export class IdleBalanceConsentService {
  constructor({
    stateStore,
    config,
    provider,
    venueStateReader,
    chainId,
    siweDomain = "localhost",
    publicBaseUrl = "http://localhost",
    now = () => new Date()
  } = {}) {
    if (
      typeof stateStore?.getIdleBalanceConsent !== "function"
      || typeof stateStore?.putIdleBalanceConsent !== "function"
      || typeof stateStore?.revokeIdleBalanceConsent !== "function"
    ) {
      throw new ConfigError("Idle-balance consent requires its durable per-wallet state-store surface.");
    }
    this.stateStore = stateStore;
    this.config = {
      ...config,
      chainId: Number(config?.chainId ?? chainId)
    };
    if (this.config.routeLive) assertLiveRouteConfig(this.config);
    this.venueStateReader = venueStateReader
      ?? (provider ? new EvmIdleBalanceVenueStateReader(provider) : undefined);
    this.siweDomain = String(siweDomain);
    this.consentUri = new URL("/account/idle-allocation/consent", publicBaseUrl).toString();
    this.now = now;
  }

  async getStatus(walletInput) {
    const wallet = normalizeWallet(walletInput);
    const record = await this.stateStore.getIdleBalanceConsent(wallet);
    const assessment = this.config.routeLive
      ? this.#assessRecord(wallet, record)
      : refused("route_not_live");
    return {
      ...this.#availability(),
      consent: presentConsent(record, assessment)
    };
  }

  getCapability() {
    const availability = this.#availability();
    return {
      ...availability,
      endpoints: this.config.routeLive
        ? {
            status: { method: "GET", path: "/account/idle-allocation" },
            quote: { method: "POST", path: "/account/idle-allocation/quote" },
            consent: { method: "POST", path: "/account/idle-allocation/consent" },
            revoke: { method: "POST", path: "/account/idle-allocation/revoke" }
          }
        : {
            status: { method: "GET", path: "/account/idle-allocation" }
          }
    };
  }

  async quote(walletInput, input = {}) {
    if (!this.config.routeLive) return this.#availability();
    assertOnlyFields(input, new Set(["consentNonce"]));
    const wallet = normalizeWallet(walletInput);
    const consentNonce = consentNonceValue(input.consentNonce);
    const issuedAt = this.now();
    const quoteExpiresAt = new Date(issuedAt.getTime() + QUOTE_TTL_MS);
    const consentExpiresAt = new Date(issuedAt.getTime() + CONSENT_TTL_MS);
    const venueTerms = await this.#venueTerms();
    const terms = {
      schemaVersion: 1,
      wallet,
      product: PRODUCT,
      amountBasis: IDLE_BALANCE_AMOUNT_BASIS,
      asset: {
        address: this.config.assetAddress,
        symbol: "USDC",
        decimals: 6,
        chainId: this.config.chainId
      },
      venue: {
        route: "deposit_pool_v2",
        depositPool: this.config.depositPoolAddress,
        downstream: venueTerms.downstream
      },
      venueDisclosure: venueTerms.venueDisclosure,
      fundsMovement: venueTerms.fundsMovement,
      returnTerms: IDLE_BALANCE_RETURN_TERMS,
      consentNonce,
      issuedAt: issuedAt.toISOString(),
      quoteExpiresAt: quoteExpiresAt.toISOString(),
      consentExpiresAt: consentExpiresAt.toISOString()
    };
    const termsHash = hashIdleBalanceConsentTerms(terms);
    return {
      schemaVersion: 1,
      available: true,
      product: PRODUCT,
      terms,
      termsHash,
      consent: {
        required: true,
        method: "SIWE_EIP4361",
        message: this.#consentMessage(terms, termsHash),
        submit: { method: "POST", path: "/account/idle-allocation/consent" }
      },
      revocation: {
        immediateForFutureAllocation: true,
        unwindsExistingPosition: false,
        submit: { method: "POST", path: "/account/idle-allocation/revoke" }
      }
    };
  }

  async captureConsent(walletInput, input = {}) {
    this.#assertRouteLive();
    const wallet = normalizeWallet(walletInput);
    assertOnlyFields(input, new Set(["terms", "termsHash", "consentSignature"]));
    const terms = input.terms;
    if (!terms || typeof terms !== "object" || Array.isArray(terms)) {
      throw new ValidationError(
        "terms must be the unmodified object returned by the idle-balance allocation quote.",
        { field: "terms" }
      );
    }
    const termsHash = hashIdleBalanceConsentTerms(terms);
    if (bytes32(input.termsHash, "termsHash") !== termsHash) {
      throw new ConflictError(
        "The submitted idle-balance allocation terms no longer reproduce termsHash; request a fresh quote and sign it unchanged.",
        "idle_balance_consent_terms_hash_mismatch"
      );
    }
    const signature = signatureValue(input.consentSignature, "consentSignature");
    const consentMessage = this.#consentMessage(terms, termsHash);
    let recovered;
    try {
      recovered = getAddress(verifyMessage(consentMessage, signature));
    } catch {
      recovered = undefined;
    }
    if (recovered !== wallet) {
      throw new ConflictError(
        "The idle-balance consent signature does not bind these exact terms to the authenticated wallet.",
        "idle_balance_consent_signer_mismatch"
      );
    }
    this.#assertTermsBinding(wallet, terms);
    const existing = await this.stateStore.getIdleBalanceConsent(wallet);
    if (existing?.status === "active" && existing.termsHash === termsHash) {
      return {
        schemaVersion: 1,
        created: false,
        consent: presentConsent(existing, this.#assessRecord(wallet, existing))
      };
    }
    if (Date.parse(terms.quoteExpiresAt) < this.now().getTime()) {
      throw new ConflictError(
        "The idle-balance consent quote expired before it was submitted; request a fresh quote.",
        "idle_balance_consent_quote_expired"
      );
    }
    const storedAt = this.now().toISOString();
    const record = {
      schemaVersion: 1,
      kind: "idle_balance_allocation_consent_v1",
      wallet: wallet.toLowerCase(),
      status: "active",
      terms,
      termsHash,
      consentMessage,
      consentSignature: signature,
      consentedAt: storedAt,
      expiresAt: terms.consentExpiresAt,
      revokedAt: null
    };
    const stored = await this.stateStore.putIdleBalanceConsent(record);
    if (!stored.accepted) {
      throw new ConflictError(
        "This exact idle-balance consent was revoked and cannot be replayed; request and sign a fresh quote.",
        "idle_balance_consent_revoked"
      );
    }
    return {
      schemaVersion: 1,
      created: true,
      consent: presentConsent(stored.record, { allowed: true })
    };
  }

  async revokeConsent(walletInput) {
    const wallet = normalizeWallet(walletInput);
    const record = await this.stateStore.revokeIdleBalanceConsent(wallet, {
      revokedAt: this.now().toISOString()
    });
    if (!record) {
      return {
        schemaVersion: 1,
        revoked: false,
        reason: "idle_balance_consent_missing"
      };
    }
    return {
      schemaVersion: 1,
      revoked: true,
      consent: presentConsent(record, { allowed: false, reason: "idle_balance_consent_revoked" })
    };
  }

  /**
   * Future allocation code calls this at the movement boundary. It deliberately
   * performs a durable read on every call; no captured or cached verdict can
   * authorize a later movement.
   */
  async assessAllocationAttempt(walletInput) {
    const wallet = normalizeWallet(walletInput);
    if (!this.config.routeLive) return refused("route_not_live");
    const record = await this.stateStore.getIdleBalanceConsent(wallet);
    return this.#assessRecord(wallet, record);
  }

  #assessRecord(wallet, record) {
    if (!record) return refused("idle_balance_consent_missing");
    if (record.status === "revoked" || record.revokedAt) {
      return refused("idle_balance_consent_revoked", record);
    }
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      return refused("idle_balance_consent_expired", record);
    }
    if (!this.#recordIsValid(wallet, record)) {
      return refused("idle_balance_consent_invalid", record);
    }
    return {
      allowed: true,
      reason: null,
      termsHash: record.termsHash,
      consentedAt: record.consentedAt,
      expiresAt: record.expiresAt,
      checkedAt: this.now().toISOString()
    };
  }

  #availability() {
    return this.config.routeLive
      ? { schemaVersion: 1, available: true, product: PRODUCT }
      : { schemaVersion: 1, available: false, reason: "route_not_live", product: PRODUCT };
  }

  #assertRouteLive() {
    if (!this.config.routeLive) {
      throw new ConflictError(
        "Idle-balance allocation is not live, so consent cannot be captured yet.",
        "route_not_live"
      );
    }
  }

  #assertTermsBinding(wallet, terms) {
    const issuedAt = Date.parse(terms.issuedAt);
    const quoteExpiresAt = Date.parse(terms.quoteExpiresAt);
    const consentExpiresAt = Date.parse(terms.consentExpiresAt);
    const rootFieldsMatch = Object.keys(terms).length === TERMS_FIELDS.size
      && Object.keys(terms).every((field) => TERMS_FIELDS.has(field));
    const assetMatches = canonicalizeContent(terms.asset) === canonicalizeContent({
      address: this.config.assetAddress,
      symbol: "USDC",
      decimals: 6,
      chainId: this.config.chainId
    });
    const venueTermsMatch = validVenueTerms().some((variant) =>
      canonicalizeContent({
        venue: terms.venue,
        venueDisclosure: terms.venueDisclosure,
        fundsMovement: terms.fundsMovement
      }) === canonicalizeContent({
        venue: {
          route: "deposit_pool_v2",
          depositPool: this.config.depositPoolAddress,
          downstream: variant.downstream
        },
        venueDisclosure: variant.venueDisclosure,
        fundsMovement: variant.fundsMovement
      })
    );
    if (
      !rootFieldsMatch
      || Number(terms.schemaVersion) !== 1
      || getAddress(String(terms.wallet ?? "")) !== wallet
      || terms.product !== PRODUCT
      || terms.amountBasis !== IDLE_BALANCE_AMOUNT_BASIS
      || !assetMatches
      || !venueTermsMatch
      || terms.returnTerms !== IDLE_BALANCE_RETURN_TERMS
      || consentNonceValue(terms.consentNonce) !== terms.consentNonce
      || !Number.isFinite(issuedAt)
      || !Number.isFinite(quoteExpiresAt)
      || !Number.isFinite(consentExpiresAt)
      || quoteExpiresAt - issuedAt !== QUOTE_TTL_MS
      || consentExpiresAt - issuedAt !== CONSENT_TTL_MS
    ) {
      throw new ConflictError(
        "The signed idle-balance allocation terms are not bound to this wallet and the configured route.",
        "idle_balance_consent_binding_mismatch"
      );
    }
  }

  #recordIsValid(wallet, record) {
    try {
      if (
        record.kind !== "idle_balance_allocation_consent_v1"
        || record.status !== "active"
        || String(record.wallet).toLowerCase() !== wallet.toLowerCase()
        || hashIdleBalanceConsentTerms(record.terms) !== record.termsHash
        || record.expiresAt !== record.terms.consentExpiresAt
      ) return false;
      this.#assertTermsBinding(wallet, record.terms);
      const expectedMessage = this.#consentMessage(record.terms, record.termsHash);
      return expectedMessage === record.consentMessage
        && getAddress(verifyMessage(expectedMessage, record.consentSignature)) === wallet;
    } catch {
      return false;
    }
  }

  async #venueTerms() {
    if (typeof this.venueStateReader?.readVenueState !== "function") {
      throw new ExternalServiceError(
        "Current DepositPool venue state could not be read, so no idle-balance consent quote was issued.",
        "idle_balance_venue_state_unavailable"
      );
    }
    try {
      const state = await this.venueStateReader.readVenueState({
        depositPoolAddress: this.config.depositPoolAddress
      });
      return idleBalanceVenueTerms(state);
    } catch {
      throw new ExternalServiceError(
        "Current DepositPool venue state could not be read, so no idle-balance consent quote was issued.",
        "idle_balance_venue_state_unavailable"
      );
    }
  }

  #consentMessage(terms, termsHash) {
    return buildSiweMessage({
      domain: this.siweDomain,
      address: terms.wallet,
      statement: `Authorize Averray idle-balance allocation terms ${termsHash}. Terms JSON: ${canonicalizeContent(terms)}`,
      uri: this.consentUri,
      chainId: this.config.chainId,
      nonce: terms.consentNonce,
      issuedAt: terms.issuedAt,
      expirationTime: terms.quoteExpiresAt
    });
  }
}

export class EvmIdleBalanceVenueStateReader {
  constructor(provider) {
    this.provider = provider;
  }

  async readVenueState({ depositPoolAddress }) {
    const blockNumber = await this.provider.getBlockNumber();
    const pool = new Contract(depositPoolAddress, IDLE_BALANCE_POOL_ABI, this.provider);
    const blockTag = { blockTag: blockNumber };
    const [venueAdapter, activeVenueDeploymentId] = await Promise.all([
      pool.venueAdapter(blockTag),
      pool.activeVenueDeploymentId(blockTag)
    ]);
    return {
      blockNumber,
      venueAdapter: getAddress(venueAdapter),
      activeVenueDeploymentId: BigInt(activeVenueDeploymentId)
    };
  }
}

export function idleBalanceVenueTerms({ venueAdapter, activeVenueDeploymentId } = {}) {
  if (venueAdapter === undefined || activeVenueDeploymentId === undefined) {
    throw new TypeError("DepositPool venue state must include venueAdapter and activeVenueDeploymentId.");
  }
  const normalizedAdapter = getAddress(String(venueAdapter));
  const deploymentId = BigInt(activeVenueDeploymentId);
  if (normalizedAdapter !== ZeroAddress && deploymentId > 0n) {
    return {
      downstream: "configured external venue",
      venueDisclosure: IDLE_BALANCE_ACTIVE_VENUE_DISCLOSURE,
      fundsMovement: IDLE_BALANCE_ACTIVE_FUNDS_MOVEMENT
    };
  }
  return {
    downstream: "pool buffer",
    venueDisclosure: normalizedAdapter === ZeroAddress
      ? IDLE_BALANCE_UNBOUND_VENUE_DISCLOSURE
      : IDLE_BALANCE_BOUND_INACTIVE_VENUE_DISCLOSURE,
    fundsMovement: IDLE_BALANCE_BUFFER_FUNDS_MOVEMENT
  };
}

export function hashIdleBalanceConsentTerms(terms) {
  return hashLockedTierTerms(terms);
}

function validVenueTerms() {
  return [
    idleBalanceVenueTerms({ venueAdapter: ZeroAddress, activeVenueDeploymentId: 0n }),
    idleBalanceVenueTerms({
      venueAdapter: "0x1111111111111111111111111111111111111111",
      activeVenueDeploymentId: 0n
    }),
    idleBalanceVenueTerms({
      venueAdapter: "0x1111111111111111111111111111111111111111",
      activeVenueDeploymentId: 1n
    })
  ];
}

function presentConsent(record, assessment) {
  if (!record) return { status: "missing", reason: assessment?.reason ?? "idle_balance_consent_missing" };
  const status = record.status === "revoked"
    ? "revoked"
    : assessment?.reason === "idle_balance_consent_expired"
      ? "expired"
      : assessment?.reason === "idle_balance_consent_invalid"
        ? "invalid"
        : "active";
  return {
    status,
    termsHash: record.termsHash,
    consentedAt: record.consentedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt ?? null,
    ...(assessment?.reason ? { reason: assessment.reason } : {})
  };
}

function refused(reason, record = undefined) {
  return {
    allowed: false,
    reason,
    ...(record?.termsHash ? { termsHash: record.termsHash } : {})
  };
}

function assertLiveRouteConfig(config) {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) {
    throw new ConfigError("A live idle-balance allocation consent route requires a positive chainId.");
  }
  if (!config.assetAddress || !config.depositPoolAddress) {
    throw new ConfigError(
      "A live idle-balance allocation consent route requires the USDC and DepositPoolV2 addresses."
    );
  }
}

function optionalAddress(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  try {
    return getAddress(String(value));
  } catch {
    throw new ConfigError("Idle-balance allocation route addresses must be valid EVM addresses.");
  }
}

function normalizeWallet(value) {
  return getAddress(String(value ?? "").toLowerCase());
}

function parseBoolean(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${name} must be a boolean.`);
}

function consentNonceValue(value) {
  const nonce = String(value ?? "").trim();
  if (!/^[A-Za-z0-9]{8,128}$/u.test(nonce)) {
    throw new ValidationError(
      "consentNonce must be an opaque 8-128 character alphanumeric nonce.",
      { field: "consentNonce" }
    );
  }
  return nonce;
}

function bytes32(value, field) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(raw)) {
    throw new ValidationError(`${field} must be bytes32 hex.`, { field });
  }
  return raw;
}

function signatureValue(value, field) {
  const raw = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{130}$/u.test(raw)) {
    throw new ValidationError(`${field} must be a 65-byte hex signature.`, { field });
  }
  return raw;
}

function assertOnlyFields(input, allowed) {
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) throw new ValidationError(`Unsupported field '${key}'.`, { field: key });
  }
}
