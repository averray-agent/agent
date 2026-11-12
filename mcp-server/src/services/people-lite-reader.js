import { AppError, ValidationError } from "../core/errors.js";
import {
  AVERRAY_PERSONHOOD_CONTEXT,
  PEOPLE_LITE_FIXTURE_AT,
  PEOPLE_LITE_FIXTURES,
  PERSONHOOD_PRECOMPILE_ADDRESS,
  POLKADOT_HUB_CHAIN_ID,
  decodePersonhoodStatusResult,
  encodePersonhoodStatusCall,
  normalizePeopleWallet,
  projectPeopleLite,
  unavailablePersonhood
} from "../core/people-lite.js";

const KNOWN_SOURCES = new Set(["", "off", "disabled", "fixtures", "hub"]);

/**
 * Server-side personhood reader.
 *
 * `fixtures` answers from the pinned Paseo-shaped set and never calls a node.
 * `hub` pins one finalized Polkadot Hub block, then eth_calls the Revive
 * personhood precompile at that block hash. It does not cache the result.
 * `off` refuses rather than inventing a tier.
 */
export function peopleLiteReaderFromEnv(env = process.env, deps = {}) {
  const requested = String(env.PEOPLE_LITE_SOURCE ?? "").trim().toLowerCase();
  if (!KNOWN_SOURCES.has(requested)) {
    return createPeopleLiteReader({
      source: "off",
      reason: "personhood_source_unknown",
      logger: deps.logger
    });
  }
  if (requested === "off" || requested === "disabled") {
    return createPeopleLiteReader({ source: "off", reason: "personhood_disabled", logger: deps.logger });
  }
  if (requested === "fixtures") {
    return createPeopleLiteReader({ source: "fixtures", logger: deps.logger, fetchImpl: deps.fetchImpl });
  }
  const rpcUrl = resolveHubRpcUrl(env);
  if (!rpcUrl) {
    return createPeopleLiteReader({
      source: "off",
      reason: "hub_eth_rpc_unconfigured",
      logger: deps.logger
    });
  }
  return createPeopleLiteReader({
    source: "hub",
    rpcUrl,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    logger: deps.logger
  });
}

export function createPeopleLiteReader({
  source,
  reason = null,
  rpcUrl = "",
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
  logger = null,
  fixtures = PEOPLE_LITE_FIXTURES,
  fixtureAt = PEOPLE_LITE_FIXTURE_AT
} = {}) {
  if (source !== "off" && source !== "fixtures" && source !== "hub") {
    throw new TypeError("people lite source must be off, fixtures, or hub.");
  }

  async function read(wallet) {
    assertEnabled();
    const normalized = requireWallet(wallet);
    if (source === "fixtures") return readFixture(normalized);
    const pinned = await pinHub();
    return readHubWallet(normalized, pinned);
  }

  async function readMany(wallets) {
    assertEnabled();
    const normalized = wallets.map((wallet) => requireWallet(wallet));
    if (source === "fixtures") {
      return {
        at: { ...fixtureAt },
        source: "fixture:paseo-individuality",
        results: normalized.map((wallet) => readFixture(wallet))
      };
    }
    const pinned = await pinHub();
    const results = await mapPool(normalized, 8, (wallet) => readHubWallet(wallet, pinned));
    return {
      at: pinned.at,
      source: "polkadot-hub-precompile",
      results
    };
  }

  function assertEnabled() {
    if (source === "off") {
      throw new AppError("Personhood reads are not configured.", {
        code: reason ?? "personhood_disabled",
        statusCode: 503
      });
    }
  }

  function readFixture(wallet) {
    const known = fixtures[wallet];
    const snapshot = known
      ? { ...known, recognized: true }
      : { kind: "sdk", sdkTag: "NotEnrolled", fullUsername: null, liteUsername: null, recognized: false };
    return projectPeopleLite({ wallet, at: fixtureAt, snapshot });
  }

  async function pinHub() {
    const chainIdHex = await rpc("eth_chainId", []);
    const chainId = Number.parseInt(String(chainIdHex), 16);
    if (!Number.isInteger(chainId) || chainId < 0) {
      throw hubError("Hub eth_chainId was not an integer.");
    }
    const block = await rpc("eth_getBlockByNumber", ["finalized", false]);
    const blockHash = typeof block?.hash === "string" ? block.hash : "";
    const blockNumber = Number.parseInt(String(block?.number ?? ""), 16);
    if (!/^0x[0-9a-fA-F]{64}$/u.test(blockHash) || !Number.isInteger(blockNumber) || blockNumber < 0) {
      throw hubError("Hub finalized block was missing a hash or number.");
    }
    return {
      at: {
        blockHash: blockHash.toLowerCase(),
        blockNumber,
        chain: chainId === POLKADOT_HUB_CHAIN_ID ? "polkadot-hub" : `evm:${chainId}`,
        chainId
      }
    };
  }

  async function readHubWallet(wallet, pinned) {
    try {
      const data = encodePersonhoodStatusCall(wallet, AVERRAY_PERSONHOOD_CONTEXT);
      const raw = await rpc("eth_call", [{
        to: PERSONHOOD_PRECOMPILE_ADDRESS,
        data
      }, pinned.at.blockHash]);
      const decoded = decodePersonhoodStatusResult(raw);
      if (!decoded) {
        return unavailablePersonhood({
          wallet,
          at: pinned.at,
          reason: "precompile_result_undecodable",
          source: "polkadot-hub-precompile"
        });
      }
      return projectPeopleLite({
        wallet,
        at: pinned.at,
        snapshot: {
          kind: "precompile",
          status: decoded.status,
          contextAlias: decoded.contextAlias,
          context: AVERRAY_PERSONHOOD_CONTEXT
        }
      });
    } catch (error) {
      logger?.warn?.({ err: error, wallet }, "people_lite.wallet_read_failed");
      return unavailablePersonhood({
        wallet,
        at: pinned.at,
        reason: "precompile_call_failed",
        source: "polkadot-hub-precompile"
      });
    }
  }

  async function rpc(method, params) {
    let response;
    try {
      response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw hubError(`Hub RPC ${method} failed.`, { cause: error?.message ?? "network" });
    }
    if (!response?.ok) {
      throw hubError(`Hub RPC ${method} returned HTTP ${response?.status ?? "unknown"}.`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw hubError(`Hub RPC ${method} did not return JSON.`);
    }
    if (body?.error) {
      const message = typeof body.error?.message === "string" ? body.error.message : "rpc_error";
      throw hubError(`Hub RPC ${method} error: ${message}`);
    }
    return body?.result;
  }

  return {
    mode: source,
    reason,
    read,
    readMany
  };
}

export function resolveHubRpcUrl(env = process.env) {
  const candidates = [
    env.PEOPLE_LITE_HUB_RPC_URL,
    env.DWELLER_RPC_URL,
    env.POLKADOT_RPC_URL,
    env.RPC_URL
  ];
  for (const candidate of candidates) {
    const url = String(candidate ?? "").trim();
    if (/^https?:\/\//iu.test(url)) return url;
  }
  return "";
}

function requireWallet(wallet) {
  const normalized = normalizePeopleWallet(wallet);
  if (!normalized) {
    throw new ValidationError("wallet must be a 0x-prefixed 20-byte hex address.");
  }
  return normalized;
}

function hubError(message, details) {
  return new AppError(message, {
    code: "personhood_unavailable",
    statusCode: 502,
    details
  });
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
