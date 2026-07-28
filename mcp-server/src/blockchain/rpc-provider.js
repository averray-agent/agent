import {
  FallbackProvider,
  FetchRequest,
  JsonRpcProvider
} from "ethers";

const DEFAULT_RPC_FAILOVER_STALL_MS = 250;
const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 750;

/**
 * Build the backend's shared provider with an ordered primary/failover set.
 *
 * A short per-request timeout is important even though FallbackProvider starts
 * another runner after stallTimeout: its initial network sync inspects every
 * child provider. Without a bounded FetchRequest, a blackholed primary can
 * still hold gateway startup (and any cold read) for the transport default.
 */
export function createRpcProvider(config) {
  const urls = normalizeRpcUrls(config);
  const requestTimeoutMs = positiveInteger(
    config?.rpcRequestTimeoutMs,
    DEFAULT_RPC_REQUEST_TIMEOUT_MS
  );
  const providers = urls.map((url) => {
    const request = new FetchRequest(url);
    request.timeout = requestTimeoutMs;
    return new JsonRpcProvider(request);
  });
  if (providers.length === 1) {
    return providers[0];
  }

  const stallTimeout = positiveInteger(
    config?.rpcFailoverStallMs,
    DEFAULT_RPC_FAILOVER_STALL_MS
  );
  return new FallbackProvider(
    providers.map((provider, index) => ({
      provider,
      priority: index + 1,
      stallTimeout,
      weight: 1
    })),
    undefined,
    { quorum: 1 }
  );
}

function normalizeRpcUrls(config) {
  const candidates = Array.isArray(config?.rpcUrls) && config.rpcUrls.length > 0
    ? config.rpcUrls
    : [config?.rpcUrl, ...(config?.rpcBackupUrls ?? [])];
  const seen = new Set();
  const urls = candidates
    .map((value) => String(value ?? "").trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  if (urls.length === 0) {
    throw new Error("At least one blockchain RPC URL is required.");
  }
  return urls;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : fallback;
}
