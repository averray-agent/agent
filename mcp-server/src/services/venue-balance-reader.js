import { createHash } from "node:crypto";

import { base58 } from "@scure/base";
import { Contract, JsonRpcProvider } from "ethers";

import { ValidationError } from "../core/errors.js";

const ACCOUNT_ID32_RE = /^0x[a-fA-F0-9]{64}$/u;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/u;
const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"];
const SS58_HASH_PREFIX = Buffer.from("SS58PRE");

/**
 * Reads a raw balance from a venue-defined (endpoint, account, asset) triple.
 *
 * The ledger is part of the target on purpose. Hydration asset 22 is an ORML
 * Tokens balance while aUSDC is an ERC-20 balance; treating both as the same
 * storage family produced a truthful-looking zero during the gate-3 rehearsal.
 */
export class VenueBalanceReader {
  constructor({
    polkadotApiLoader = loadPolkadotApi,
    substrateApiFactory = createSubstrateApi,
    evmProviderFactory = createEvmProvider
  } = {}) {
    this.polkadotApiLoader = polkadotApiLoader;
    this.substrateApiFactory = substrateApiFactory;
    this.evmProviderFactory = evmProviderFactory;
    this.substrateApis = new Map();
    this.evmProviders = new Map();
  }

  async read(target) {
    const normalized = normalizeVenueBalanceTarget(target);
    if (normalized.ledger === "substrate_tokens") {
      const api = await this.getSubstrateApi(normalized.endpoint);
      const record = await api.query.tokens.accounts(normalized.account, normalized.assetId);
      const json = record?.toJSON?.() ?? record;
      return {
        raw: BigInt(json?.free ?? 0),
        asOf: new Date().toISOString(),
        target: normalized
      };
    }

    if (normalized.ledger === "substrate_system") {
      const api = await this.getSubstrateApi(normalized.endpoint);
      const record = await api.query.system.account(normalized.account);
      const json = record?.toJSON?.() ?? record;
      return {
        raw: BigInt(json?.data?.free ?? json?.free ?? 0),
        asOf: new Date().toISOString(),
        target: normalized
      };
    }

    const provider = this.getEvmProvider(normalized.endpoint, normalized.chainId);
    const contract = new Contract(normalized.contract, ERC20_BALANCE_ABI, provider);
    return {
      raw: BigInt(await contract.balanceOf(normalized.evmAccount)),
      asOf: new Date().toISOString(),
      target: normalized
    };
  }

  async getSubstrateApi(endpoint) {
    let pending = this.substrateApis.get(endpoint);
    if (!pending) {
      // Keep this dependency outside backend startup. A rejected import stays
      // attached to the read promise so the observer records the exact error,
      // retries it as a visible Pending, and eventually emits Failed.
      pending = this.polkadotApiLoader()
        .then((polkadotApi) => this.substrateApiFactory(endpoint, polkadotApi));
      this.substrateApis.set(endpoint, pending);
    }
    return pending;
  }

  getEvmProvider(endpoint, chainId) {
    const key = `${endpoint}|${chainId ?? "auto"}`;
    let provider = this.evmProviders.get(key);
    if (!provider) {
      provider = this.evmProviderFactory(endpoint, chainId);
      this.evmProviders.set(key, provider);
    }
    return provider;
  }

  async close() {
    const apis = await Promise.allSettled([...this.substrateApis.values()]);
    await Promise.allSettled(apis
      .filter((entry) => entry.status === "fulfilled")
      .map((entry) => entry.value?.disconnect?.()));
    this.substrateApis.clear();
    this.evmProviders.clear();
  }
}

export function normalizeVenueBalanceTarget(target = {}) {
  const ledger = String(target.ledger ?? "").trim().toLowerCase();
  const endpoint = requireEndpoint(target.endpoint);
  if (ledger === "substrate_tokens") {
    const account = normalizeAccountId32(
      target.account,
      "substrate_tokens target.account must be a 32-byte AccountId or SS58 address."
    );
    const assetId = normalizeAssetId(target.assetId ?? target.asset);
    return {
      ledger,
      endpoint,
      account,
      assetId
    };
  }

  if (ledger === "substrate_system") {
    const account = String(target.account ?? "");
    if (!ACCOUNT_ID32_RE.test(account) && !SS58_RE.test(account)) {
      throw new ValidationError(
        "substrate_system target.account must be a 32-byte AccountId or SS58 address."
      );
    }
    return {
      ledger,
      endpoint,
      account: ACCOUNT_ID32_RE.test(account) ? account.toLowerCase() : account
    };
  }

  if (ledger === "erc20") {
    if (!ADDRESS_RE.test(String(target.contract ?? target.asset ?? ""))) {
      throw new ValidationError("erc20 target.contract must be a 20-byte address.");
    }
    const account = String(target.account ?? "");
    const accountTransform = String(target.accountTransform ?? "none").trim().toLowerCase();
    let normalizedAccount = account;
    let evmAccount;
    if (accountTransform === "hydration_truncate20") {
      normalizedAccount = normalizeAccountId32(
        account,
        "hydration_truncate20 requires a 32-byte AccountId or SS58 address."
      );
      evmAccount = `0x${normalizedAccount.slice(2, 42)}`;
    } else if (accountTransform === "none" && ADDRESS_RE.test(account)) {
      evmAccount = account.toLowerCase();
    } else {
      throw new ValidationError(
        'erc20 target.account must be an H160, or use accountTransform="hydration_truncate20" with AccountId32.'
      );
    }
    return {
      ledger,
      endpoint,
      account: normalizedAccount.toLowerCase(),
      accountTransform,
      evmAccount,
      contract: String(target.contract ?? target.asset).toLowerCase(),
      ...(target.chainId === undefined ? {} : { chainId: normalizeChainId(target.chainId) })
    };
  }

  throw new ValidationError(
    'balance target ledger must be "substrate_tokens", "substrate_system", or "erc20".'
  );
}

function normalizeAccountId32(raw, message) {
  const account = String(raw ?? "");
  if (ACCOUNT_ID32_RE.test(account)) return account.toLowerCase();
  if (SS58_RE.test(account)) {
    try {
      return `0x${Buffer.from(decodeSs58AccountId32(account)).toString("hex")}`;
    } catch {
      // Fall through to the ledger-specific validation error below.
    }
  }
  throw new ValidationError(message);
}

function decodeSs58AccountId32(account) {
  const decoded = base58.decode(account);
  const prefixLength = (decoded[0] & 0b0100_0000) === 0 ? 1 : 2;
  const payloadEnd = decoded.length - 2;
  if (
    decoded.length !== prefixLength + 32 + 2
    || (decoded[0] & 0b1000_0000) !== 0
    || decoded[0] === 46
    || decoded[0] === 47
  ) {
    throw new Error("invalid SS58 AccountId32 length or prefix");
  }
  const checksum = createHash("blake2b512")
    .update(SS58_HASH_PREFIX)
    .update(decoded.subarray(0, payloadEnd))
    .digest();
  if (decoded[payloadEnd] !== checksum[0] || decoded[payloadEnd + 1] !== checksum[1]) {
    throw new Error("invalid SS58 checksum");
  }
  return decoded.subarray(prefixLength, payloadEnd);
}

function loadPolkadotApi() {
  return import("@polkadot/api");
}

function createSubstrateApi(endpoint, { ApiPromise, HttpProvider, WsProvider }) {
  const provider = endpoint.startsWith("http")
    ? new HttpProvider(endpoint)
    : new WsProvider(endpoint, 5_000);
  return ApiPromise.create({ provider, noInitWarn: true });
}

function createEvmProvider(endpoint, chainId) {
  return new JsonRpcProvider(
    endpoint,
    chainId === undefined ? undefined : chainId,
    chainId === undefined ? undefined : { staticNetwork: true }
  );
}

function requireEndpoint(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw ?? ""));
  } catch {
    throw new ValidationError("balance target endpoint must be an http(s) or ws(s) URL.");
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new ValidationError("balance target endpoint must be an http(s) or ws(s) URL.");
  }
  return parsed.toString();
}

function normalizeAssetId(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ValidationError("substrate_tokens target.assetId must be a uint32.");
  }
  return value;
}

function normalizeChainId(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError("erc20 target.chainId must be a positive safe integer.");
  }
  return value;
}
