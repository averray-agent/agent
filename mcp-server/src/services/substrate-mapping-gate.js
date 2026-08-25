import { getBytes } from "ethers";

import {
  accountId32FromSs58,
  isEvmDerivedAccountId32,
  parseWalletIdentity
} from "../core/wallet-identity.js";

export const SUBSTRATE_MAPPING_CACHE_TTL_MS_ENV = "SUBSTRATE_MAPPING_CACHE_TTL_MS";
export const SUBSTRATE_MAPPING_CACHE_DEFAULT_MS = 5 * 60 * 1_000;
export const SUBSTRATE_MAPPING_CACHE_CEILING_MS = 15 * 60 * 1_000;
export const SUBSTRATE_MAPPING_QUERY_TIMEOUT_MS = 5_000;

export function loadSubstrateMappingGateConfig(env = process.env, { logger = console } = {}) {
  const requestedCacheTtlMs = parseNonNegativeInteger(
    env[SUBSTRATE_MAPPING_CACHE_TTL_MS_ENV] ?? SUBSTRATE_MAPPING_CACHE_DEFAULT_MS,
    SUBSTRATE_MAPPING_CACHE_TTL_MS_ENV
  );
  const positiveCacheTtlMs = Math.min(
    requestedCacheTtlMs,
    SUBSTRATE_MAPPING_CACHE_DEFAULT_MS,
    SUBSTRATE_MAPPING_CACHE_CEILING_MS
  );
  if (requestedCacheTtlMs > SUBSTRATE_MAPPING_CACHE_DEFAULT_MS) {
    logger.warn?.(
      {
        configuredMs: requestedCacheTtlMs,
        effectiveMs: positiveCacheTtlMs,
        envMaximumMs: SUBSTRATE_MAPPING_CACHE_DEFAULT_MS,
        ceilingMs: SUBSTRATE_MAPPING_CACHE_CEILING_MS
      },
      "substrate_mapping.positive_cache_ttl_clamped"
    );
  }
  return Object.freeze({
    assetHubSubstrateEndpoint: String(env.BANK_XCM_ASSET_HUB_SUBSTRATE_RPC_URL ?? "").trim(),
    positiveCacheTtlMs,
    queryTimeoutMs: SUBSTRATE_MAPPING_QUERY_TIMEOUT_MS
  });
}

/**
 * Proves that the native signer controls its derived H160 before an earning
 * action can use that address. Positive mappings are cached briefly; absent,
 * mismatched, malformed, and unreadable results are never cached.
 */
export class SubstrateMappingGate {
  constructor({
    assetHubSubstrateEndpoint,
    balanceReader,
    positiveCacheTtlMs = SUBSTRATE_MAPPING_CACHE_DEFAULT_MS,
    queryTimeoutMs = SUBSTRATE_MAPPING_QUERY_TIMEOUT_MS,
    now = () => new Date(),
    logger = console
  } = {}) {
    this.assetHubSubstrateEndpoint = String(assetHubSubstrateEndpoint ?? "").trim();
    this.balanceReader = balanceReader;
    this.positiveCacheTtlMs = Math.min(
      requireNonNegativeInteger(positiveCacheTtlMs, "positiveCacheTtlMs"),
      SUBSTRATE_MAPPING_CACHE_CEILING_MS
    );
    this.queryTimeoutMs = requirePositiveInteger(queryTimeoutMs, "queryTimeoutMs");
    this.now = now;
    this.logger = logger;
    this.positiveCache = new Map();
    this.inFlight = new Map();
  }

  async check(walletIdentity) {
    const identity = normalizeNativeIdentity(walletIdentity);
    const accountId = accountId32FromSs58(identity.ss58);
    if (isEvmDerivedAccountId32(accountId)) {
      return mappingResult(identity, {
        mapped: true,
        mappingRequired: false,
        status: "not_required",
        reason: "evm_derived_identity",
        source: "identity"
      });
    }

    const key = `${identity.h160}:${Buffer.from(accountId).toString("hex")}`;
    const nowMs = this.now().getTime();
    const cached = this.positiveCache.get(key);
    if (cached && nowMs < cached.expiresAtMs) {
      return mappingResult(identity, {
        mapped: true,
        mappingRequired: true,
        status: "mapped",
        reason: "original_account_matched",
        source: "positive_cache",
        checkedAt: cached.checkedAt,
        cacheExpiresAt: new Date(cached.expiresAtMs).toISOString()
      });
    }
    this.positiveCache.delete(key);

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.#readMapping(identity, accountId, key);
      this.inFlight.set(key, pending);
      void pending.then(
        () => this.inFlight.delete(key),
        () => this.inFlight.delete(key)
      );
    }
    return pending;
  }

  async #readMapping(identity, accountId, key) {
    if (!this.assetHubSubstrateEndpoint || typeof this.balanceReader?.getSubstrateApi !== "function") {
      return mappingResult(identity, {
        mapped: false,
        mappingRequired: true,
        status: "unreadable",
        reason: "mapping_unreadable",
        failure: "endpoint_unavailable"
      });
    }

    try {
      const originalAccount = await withTimeout(
        this.#queryOriginalAccount(identity.h160),
        this.queryTimeoutMs
      );
      const mappedAccountId = decodeOriginalAccount(originalAccount);
      if (mappedAccountId === null) {
        return mappingResult(identity, {
          mapped: false,
          mappingRequired: true,
          status: "unmapped",
          reason: "mapping_absent",
          source: "chain"
        });
      }
      if (!Buffer.from(mappedAccountId).equals(Buffer.from(accountId))) {
        return mappingResult(identity, {
          mapped: false,
          mappingRequired: true,
          status: "unmapped",
          reason: "original_account_mismatch",
          source: "chain"
        });
      }

      const checkedAt = this.now().toISOString();
      const expiresAtMs = this.now().getTime() + this.positiveCacheTtlMs;
      if (this.positiveCacheTtlMs > 0) {
        this.positiveCache.set(key, { checkedAt, expiresAtMs });
      }
      return mappingResult(identity, {
        mapped: true,
        mappingRequired: true,
        status: "mapped",
        reason: "original_account_matched",
        source: "chain",
        checkedAt,
        ...(this.positiveCacheTtlMs > 0
          ? { cacheExpiresAt: new Date(expiresAtMs).toISOString() }
          : {})
      });
    } catch (error) {
      this.balanceReader.resetSubstrateApi?.(this.assetHubSubstrateEndpoint);
      const failure = error instanceof MappingQueryTimeoutError ? "timeout" : "malformed_or_unavailable";
      this.logger.warn?.(
        { h160: identity.h160, failure, error: error?.message ?? String(error) },
        "substrate_mapping.read_failed"
      );
      return mappingResult(identity, {
        mapped: false,
        mappingRequired: true,
        status: "unreadable",
        reason: "mapping_unreadable",
        failure
      });
    }
  }

  async #queryOriginalAccount(h160) {
    const api = await this.balanceReader.getSubstrateApi(this.assetHubSubstrateEndpoint);
    const query = api?.query?.revive?.originalAccount;
    if (typeof query !== "function") {
      throw new Error("revive.originalAccount is unavailable");
    }
    return query(h160);
  }
}

function normalizeNativeIdentity(value) {
  const parsed = value?.source === "ss58" && value?.ss58
    ? parseWalletIdentity(value.ss58)
    : parseWalletIdentity(value);
  if (parsed.source !== "ss58") {
    throw new TypeError("substrate mapping checks require an SS58 identity");
  }
  return parsed;
}

function decodeOriginalAccount(option) {
  if (option?.isNone === true) return null;
  if (option?.isSome !== true || typeof option?.unwrap !== "function") {
    throw new Error("revive.originalAccount returned a malformed Option<AccountId32>");
  }
  const account = option.unwrap();
  let bytes;
  if (typeof account?.toU8a === "function") {
    bytes = account.toU8a();
  } else if (typeof account?.toHex === "function") {
    bytes = getBytes(account.toHex());
  } else if (account instanceof Uint8Array) {
    bytes = account;
  } else {
    throw new Error("revive.originalAccount returned a malformed AccountId32");
  }
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error("revive.originalAccount returned a malformed AccountId32");
  }
  return bytes;
}

function mappingResult(identity, details) {
  return Object.freeze({
    ...details,
    h160: identity.h160,
    ss58: identity.ss58
  });
}

class MappingQueryTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`revive.originalAccount timed out after ${timeoutMs}ms`);
    this.name = "MappingQueryTimeoutError";
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new MappingQueryTimeoutError(timeoutMs)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function requireNonNegativeInteger(value, name) {
  return parseNonNegativeInteger(value, name);
}

function requirePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return parsed;
}
