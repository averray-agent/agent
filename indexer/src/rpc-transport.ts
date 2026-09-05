import { createTransport, fallback, http, HttpRequestError, TimeoutError, type Transport } from "viem";

export const INDEXER_RPC_PROBE_RETRY_DELAYS_MS = [5_000, 15_000] as const;

const RPC_PROBE_ATTEMPT_TIMEOUT_MS = 10_000;
const RPC_PROBE_TRANSPORT_TIMEOUT_MS = 55_000;

type RpcFetchOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  attemptTimeoutMs?: number;
};

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs));

/**
 * Ponder performs an eth_chainId diagnostic before starting the indexer. Its
 * built-in transport deliberately does not retry HTTP 404, so a transient RPC
 * edge response can abort an otherwise healthy deploy. Retry only that boot
 * diagnostic; normal indexing traffic retains its existing retry behavior.
 */
export function createIndexerRpcFetch({
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  retryDelaysMs = INDEXER_RPC_PROBE_RETRY_DELAYS_MS,
  attemptTimeoutMs = RPC_PROBE_ATTEMPT_TIMEOUT_MS
}: RpcFetchOptions = {}): typeof fetch {
  return async (input, init) => {
    if (!isChainIdDiagnostic(init?.body)) {
      return fetchImpl(input, init);
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetchWithTimeout(fetchImpl, input, init, attemptTimeoutMs);
        if (!isRetryableProbeStatus(response.status) || attempt >= retryDelaysMs.length) {
          return response;
        }
      } catch (error) {
        if (!isAttemptTimeout(error) || init?.signal?.aborted || attempt >= retryDelaysMs.length) {
          throw error;
        }
      }

      await sleep(retryDelaysMs[attempt] ?? 0);
    }
  };
}

export function createIndexerRpcTransport(
  rpcUrls: readonly string[],
  options: RpcFetchOptions = {}
): Transport {
  if (rpcUrls.length === 0) throw new Error("Ponder: at least one RPC URL is required.");
  // Each attempt budgets 10s for the WHOLE provider chain, not 10s per host.
  // Three chains + 5s/15s waits stay within the existing 50s probe budget.
  const perUrlTimeoutMs = Math.max(1, Math.floor(
    (options.attemptTimeoutMs ?? RPC_PROBE_ATTEMPT_TIMEOUT_MS) / rpcUrls.length
  ));
  const providerChain = fallback(rpcUrls.map((url) => http(url, {
    fetchFn: createIndexerRpcFetch({ ...options, retryDelaysMs: [], attemptTimeoutMs: perUrlTimeoutMs }),
    retryCount: 0,
    timeout: RPC_PROBE_TRANSPORT_TIMEOUT_MS
  })), { retryCount: 0, rank: false });
  const sleep = options.sleep ?? defaultSleep;
  const retryDelaysMs = options.retryDelaysMs ?? INDEXER_RPC_PROBE_RETRY_DELAYS_MS;

  return (parameters) => {
    const chain = providerChain(parameters);
    return createTransport({
      ...chain.config,
      retryCount: 0,
      request: (async (args: Parameters<typeof chain.request>[0]) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await chain.request(args);
          } catch (error) {
            if (args.method !== "eth_chainId" || !isRetryableProbeError(error) || attempt >= retryDelaysMs.length) {
              throw error;
            }
          }
          await sleep(retryDelaysMs[attempt] ?? 0);
        }
      }) as typeof chain.request
    }, chain.value);
  };
}

/** Backend names first; retain existing aliases as ordered fallback providers. */
export function resolveIndexerRpcUrls(id: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const aliases = [env.RPC_URL, env.DWELLER_RPC_URL, env.POLKADOT_RPC_URL, env[`PONDER_RPC_URL_${id}`]]
    .map((url) => url?.trim()).filter((url): url is string => Boolean(url));
  const backups = env.RPC_BACKUP_URLS?.split(/[\s,]+/u).filter(Boolean) ?? [];
  const urls = [...new Set([aliases[0], ...backups, ...aliases.slice(1)].filter((url): url is string => Boolean(url)))];
  if (urls.length > 0) return urls;
  if (id === 420420417) return ["https://eth-rpc-testnet.polkadot.io/"];
  throw new Error(`Ponder: no RPC URL configured for chain id ${id}. Set RPC_URL + RPC_BACKUP_URLS, DWELLER_RPC_URL, POLKADOT_RPC_URL, or PONDER_RPC_URL_${id}.`);
}

function isRetryableProbeError(error: unknown): boolean {
  if (error instanceof TimeoutError || isAttemptTimeout(error)) return true;
  if (error instanceof HttpRequestError) {
    return (error.status !== undefined && isRetryableProbeStatus(error.status)) || isRetryableProbeError(error.cause);
  }
  return false;
}

function isChainIdDiagnostic(body: RequestInit["body"]): boolean {
  if (typeof body !== "string") return false;
  try {
    const payload = JSON.parse(body) as { method?: unknown } | Array<{ method?: unknown }>;
    if (Array.isArray(payload)) {
      return payload.length > 0 && payload.every((request) => request?.method === "eth_chainId");
    }
    return payload.method === "eth_chainId";
  } catch {
    return false;
  }
}

function isRetryableProbeStatus(status: number): boolean {
  // 404 is included because it is the observed transient response from the
  // public Polkadot RPC edge. This exception is confined to eth_chainId boot.
  return status === 404 || status >= 500;
}

const RPC_ATTEMPT_TIMEOUT = Symbol("rpc-attempt-timeout");

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const outerSignal = init?.signal;
  const abortFromOuter = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) abortFromOuter();
  else outerSignal?.addEventListener("abort", abortFromOuter, { once: true });

  const timer = setTimeout(() => controller.abort(RPC_ATTEMPT_TIMEOUT), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.reason === RPC_ATTEMPT_TIMEOUT) {
      throw RPC_ATTEMPT_TIMEOUT;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abortFromOuter);
  }
}

function isAttemptTimeout(error: unknown): boolean {
  return error === RPC_ATTEMPT_TIMEOUT;
}
