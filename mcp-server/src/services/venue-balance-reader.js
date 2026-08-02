import { ApiPromise, HttpProvider, WsProvider } from "@polkadot/api";
import { Contract, JsonRpcProvider } from "ethers";

import { ValidationError } from "../core/errors.js";

const ACCOUNT_ID32_RE = /^0x[a-fA-F0-9]{64}$/u;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;
const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"];

/**
 * Reads a raw balance from a venue-defined (endpoint, account, asset) triple.
 *
 * The ledger is part of the target on purpose. Hydration asset 22 is an ORML
 * Tokens balance while aUSDC is an ERC-20 balance; treating both as the same
 * storage family produced a truthful-looking zero during the gate-3 rehearsal.
 */
export class VenueBalanceReader {
  constructor({ substrateApiFactory = createSubstrateApi, evmProviderFactory = createEvmProvider } = {}) {
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
      pending = Promise.resolve(this.substrateApiFactory(endpoint));
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
    if (!ACCOUNT_ID32_RE.test(String(target.account ?? ""))) {
      throw new ValidationError("substrate_tokens target.account must be a 32-byte AccountId.");
    }
    const assetId = normalizeAssetId(target.assetId ?? target.asset);
    return {
      ledger,
      endpoint,
      account: String(target.account).toLowerCase(),
      assetId
    };
  }

  if (ledger === "erc20") {
    if (!ADDRESS_RE.test(String(target.contract ?? target.asset ?? ""))) {
      throw new ValidationError("erc20 target.contract must be a 20-byte address.");
    }
    const account = String(target.account ?? "");
    const accountTransform = String(target.accountTransform ?? "none").trim().toLowerCase();
    let evmAccount;
    if (accountTransform === "hydration_truncate20") {
      if (!ACCOUNT_ID32_RE.test(account)) {
        throw new ValidationError("hydration_truncate20 requires a 32-byte AccountId.");
      }
      evmAccount = `0x${account.slice(2, 42)}`.toLowerCase();
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
      account: account.toLowerCase(),
      accountTransform,
      evmAccount,
      contract: String(target.contract ?? target.asset).toLowerCase(),
      ...(target.chainId === undefined ? {} : { chainId: normalizeChainId(target.chainId) })
    };
  }

  throw new ValidationError('balance target ledger must be "substrate_tokens" or "erc20".');
}

function createSubstrateApi(endpoint) {
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
