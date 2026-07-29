import {
  createRpcProvider,
  createWriteRpcBroadcaster
} from "../../mcp-server/src/blockchain/rpc-provider.js";

export const POLKADOT_HUB_MAINNET_CHAIN_ID = 420420419;
export const POLKADOT_HUB_TESTNET_CHAIN_ID = 420420417;
export const CEREMONY_RPC_PREFLIGHT_TIMEOUT_MS = 3_000;
export const CEREMONY_RPC_READ_TIMEOUT_MS = 750;
export const CEREMONY_RPC_FAILOVER_STALL_MS = 250;
export const CEREMONY_RPC_WRITE_TIMEOUT_MS = 15_000;

function configuredRpcUrls(manifest) {
  const primary = String(manifest?.rpcUrl ?? "").trim();
  if (!primary) {
    throw new Error("Ceremony manifest must configure rpcUrl.");
  }
  const candidates = [
    primary,
    ...(Array.isArray(manifest?.rpcBackupUrls) ? manifest.rpcBackupUrls : [])
  ];
  const seen = new Set();
  const urls = candidates
    .map((value) => String(value ?? "").trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  return urls;
}

export function safeCeremonyRpcLabel(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid RPC URL";
  }
}

export function expectedCeremonyChainId(manifest) {
  if (Number.isInteger(manifest?.chainId) && manifest.chainId > 0) {
    return manifest.chainId;
  }
  if (manifest?.profile === "mainnet") {
    return POLKADOT_HUB_MAINNET_CHAIN_ID;
  }
  if (manifest?.profile === "testnet") {
    return POLKADOT_HUB_TESTNET_CHAIN_ID;
  }
  throw new Error(
    `Ceremony manifest profile ${JSON.stringify(manifest?.profile)} has no known chainId.`
  );
}

async function readChainId(url, {
  fetchImpl,
  timeoutMs
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: []
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText || "request failed"}`);
    }
    const payload = await response.json();
    if (payload?.error) {
      throw new Error(
        `JSON-RPC ${payload.error.code ?? "error"}: ${payload.error.message ?? "unknown error"}`
      );
    }
    if (!/^0x[0-9a-f]+$/iu.test(String(payload?.result ?? ""))) {
      throw new Error(`invalid eth_chainId result ${JSON.stringify(payload?.result)}`);
    }
    return Number(BigInt(payload.result));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Prove a configured endpoint is on the requested chain before a ceremony
 * performs any chain read, secret access, artifact load, or transaction
 * broadcast. The declared primary itself must pass: a backup must not mask a
 * stale, wrong-chain, or currently broken manifest source of truth. Backups
 * remain ordered for failures after this gate.
 */
export async function preflightCeremonyRpc({
  manifest,
  phase,
  expectedChainId,
  fetchImpl = globalThis.fetch,
  timeoutMs = CEREMONY_RPC_PREFLIGHT_TIMEOUT_MS
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Ceremony RPC preflight requires fetch.");
  }
  const requiredChainId = expectedChainId ?? expectedCeremonyChainId(manifest);
  const urls = configuredRpcUrls(manifest);
  const url = urls[0];
  const endpoint = safeCeremonyRpcLabel(url);
  let chainId;
  try {
    chainId = await readChainId(url, { fetchImpl, timeoutMs });
  } catch (error) {
    throw new Error(
      `Ceremony RPC preflight failed before phase ${phase}: ${endpoint}: ` +
        `${String(error?.message ?? error)}.\n` +
        "Refusing to continue before provider creation, secret access, or transaction broadcast."
    );
  }
  if (chainId !== requiredChainId) {
    throw new Error(
      `Ceremony RPC preflight failed before phase ${phase}: ${endpoint} answered ` +
      `wrong chainId ${chainId}; expected ${requiredChainId}.\n` +
      "Refusing to continue before provider creation, secret access, or transaction broadcast."
    );
  }
  return {
    chainId,
    selectedUrl: url,
    rpcUrls: urls,
    attempts: [{ endpoint, ok: true, chainId }]
  };
}

/**
 * Build the read provider and, only for a write phase, the patient ordered
 * broadcaster after the chain preflight has succeeded.
 */
export async function createCeremonyRpcContext({
  manifest,
  phase,
  write = false,
  fetchImpl = globalThis.fetch,
  expectedChainId,
  readProviderFactory = createRpcProvider,
  writeBroadcasterFactory = createWriteRpcBroadcaster
}) {
  const preflight = await preflightCeremonyRpc({
    manifest,
    phase,
    expectedChainId,
    fetchImpl
  });
  const config = {
    rpcUrls: preflight.rpcUrls,
    rpcRequestTimeoutMs: CEREMONY_RPC_READ_TIMEOUT_MS,
    rpcFailoverStallMs: CEREMONY_RPC_FAILOVER_STALL_MS,
    rpcWriteRequestTimeoutMs: CEREMONY_RPC_WRITE_TIMEOUT_MS
  };
  const provider = readProviderFactory(config);
  const writeBroadcaster = write ? writeBroadcasterFactory(config) : undefined;
  return { ...preflight, config, provider, writeBroadcaster };
}

export function printCeremonyRpcPreflight(context, log = console.log) {
  log(`rpc selected:          ${safeCeremonyRpcLabel(context.selectedUrl)}`);
  if (context.rpcUrls.length > 1) {
    log(
      `rpc failover order:   ${context.rpcUrls
        .map((url) => safeCeremonyRpcLabel(url))
        .join(" -> ")}`
    );
  }
  log(`rpc chain preflight:  ${context.chainId} ✓`);
}
