import { http, type Transport } from "viem";

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

export function createIndexerRpcTransport(rpcUrl: string): Transport {
  return http(rpcUrl, {
    fetchFn: createIndexerRpcFetch(),
    retryCount: 0,
    // Leave enough room for three 10s diagnostic attempts and 5s/15s waits.
    timeout: RPC_PROBE_TRANSPORT_TIMEOUT_MS
  });
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
