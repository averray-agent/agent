import {
  BaseError,
  createTransport,
  fallback,
  hexToNumber,
  http,
  HttpRequestError,
  TimeoutError,
  type Hex,
  type Transport
} from "viem";

export const INDEXER_RPC_PROBE_RETRY_DELAYS_MS = [5_000, 15_000] as const;
/**
 * Once one provider has answered an eth_getLogs request, how long the others
 * may still take before the cross-check proceeds without them. Below the 6s
 * Polkadot Hub block time so a consistently slow secondary cannot make the
 * realtime sync fall behind; a slow PRIMARY now costs at most this instead of
 * the full transport timeout it cost under plain fallback.
 */
export const INDEXER_RPC_LOGS_CROSS_CHECK_GRACE_MS = 5_000;

const RPC_PROBE_ATTEMPT_TIMEOUT_MS = 10_000;
const RPC_PROBE_TRANSPORT_TIMEOUT_MS = 55_000;
const ZERO_LOGS_BLOOM = `0x${"0".repeat(512)}`;
const WARN_PREFIX = "[indexer-rpc]";

type RpcFetchOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  attemptTimeoutMs?: number;
  /** Provider-defect sink. Defaults to console.warn so `docker logs` carries it. */
  warn?: (message: string) => void;
  logsCrossCheckGraceMs?: number;
};

type RpcRequestArgs = { method: string; params?: unknown };
type ProviderTransport = ReturnType<Transport>;
type Provider = { url: string; transport: ProviderTransport };

/**
 * A provider answered eth_getBlockBy* with an empty `transactions` array for a
 * block whose own header proves it executed transactions. Observed 2026-09-10
 * on services.polkadothub-rpc.com for mainnet block 20501734: the block header
 * (gasUsed, logsBloom) comes from the chain, the transaction list from the
 * provider's receipt store, and that store had a gap. Mixed with another
 * provider's eth_getLogs answer, Ponder rejected the pair as inconsistent and
 * retried inside one Postgres transaction until the connection was killed.
 * Failing the response here lets viem's fallback try the next provider instead.
 */
export class IncompleteBlockResponseError extends BaseError {
  override name = "IncompleteBlockResponseError";

  constructor({ url, method, block }: { url: string; method: string; block: IncompleteBlockShape }) {
    const number = block.number ? `${hexToNumber(block.number)} (${block.number})` : "unknown";
    super(
      `Provider ${url} answered ${method} for block ${number} with an empty 'transactions' array although the header reports gasUsed=${block.gasUsed} and a non-zero logsBloom.`,
      {
        metaMessages: [
          "This is the receipt-store gap documented in docs/INCIDENT_RESPONSE.md (\"Indexer sync stall from a provider block hole\").",
          `Block hash: ${block.hash ?? "unknown"}`
        ]
      }
    );
  }
}

/**
 * Two providers returned eth_getLogs answers where neither contains the other.
 * A finalized range cannot legitimately differ, so the transport refuses to
 * pick rather than index one provider's view of the chain.
 */
export class InconsistentLogsResponseError extends BaseError {
  override name = "InconsistentLogsResponseError";

  constructor({ params, answers }: { params: unknown; answers: LogsAnswer[] }) {
    super(
      `Providers disagree on eth_getLogs and neither answer contains the other: ${answers.map((answer) => `${answer.url} returned ${answer.keys.size} log(s)`).join("; ")}.`,
      {
        metaMessages: [
          `Request params: ${JSON.stringify(params)}`,
          ...answers.map((answer) => `${answer.url}: ${describeLogKeys([...answer.keys])}`)
        ]
      }
    );
  }
}

type IncompleteBlockShape = {
  number?: Hex;
  hash?: Hex;
  gasUsed?: Hex;
  logsBloom?: Hex;
  transactions?: unknown[];
};

type LogShape = { blockHash?: Hex; blockNumber?: Hex; logIndex?: Hex };
type LogsAnswer = { url: string; value: LogShape[]; keys: Set<string> };

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
  const warn = options.warn ?? ((message: string) => console.warn(`${WARN_PREFIX} ${message}`));
  const guardedProviders = rpcUrls.map((url) => guardProviderTransport(url, http(url, {
    fetchFn: createIndexerRpcFetch({ ...options, retryDelaysMs: [], attemptTimeoutMs: perUrlTimeoutMs }),
    retryCount: 0,
    timeout: RPC_PROBE_TRANSPORT_TIMEOUT_MS
  }), warn));
  const providerChain = fallback(guardedProviders, { retryCount: 0, rank: false });
  const sleep = options.sleep ?? defaultSleep;
  const retryDelaysMs = options.retryDelaysMs ?? INDEXER_RPC_PROBE_RETRY_DELAYS_MS;
  const logsCrossCheckGraceMs = options.logsCrossCheckGraceMs ?? INDEXER_RPC_LOGS_CROSS_CHECK_GRACE_MS;

  return (parameters) => {
    const chain = providerChain(parameters);
    // Same instantiation viem's fallback performs for each attempt, so the
    // cross-check and the fallback path share one provider configuration.
    const providers: Provider[] = guardedProviders.map((provider, index) => ({
      url: rpcUrls[index]!,
      transport: provider({ ...parameters, retryCount: 0 })
    }));
    return createTransport({
      ...chain.config,
      retryCount: 0,
      request: (async (args: Parameters<typeof chain.request>[0]) => {
        if (args.method === "eth_getLogs" && providers.length > 1) {
          return crossCheckLogs(providers, args, { warn, graceMs: logsCrossCheckGraceMs });
        }
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

/**
 * Wrap one provider so a self-inconsistent block answer is an error for THAT
 * provider. viem's fallback then moves to the next URL; only when every
 * provider serves the same hole does the error reach Ponder — loudly, naming
 * the provider and block, instead of as a mixed-provider retry storm.
 */
function guardProviderTransport(url: string, inner: Transport, warn: (message: string) => void): Transport {
  return (parameters) => {
    const transport = inner(parameters);
    return createTransport({
      ...transport.config,
      retryCount: 0,
      request: (async (args: RpcRequestArgs, requestOptions?: { signal?: AbortSignal }) => {
        const result = await transport.request(args as never, requestOptions);
        const incomplete = findIncompleteBlock(args.method, result);
        if (incomplete) {
          const error = new IncompleteBlockResponseError({ url, method: args.method, block: incomplete });
          warn(`${error.shortMessage} Rejecting this answer so the fallback chain can try another provider.`);
          throw error;
        }
        return result;
      }) as typeof transport.request
    }, transport.value);
  };
}

function findIncompleteBlock(method: string, result: unknown): IncompleteBlockShape | undefined {
  if (method !== "eth_getBlockByNumber" && method !== "eth_getBlockByHash") return undefined;
  if (result === null || typeof result !== "object") return undefined;
  const block = result as IncompleteBlockShape;
  if (!Array.isArray(block.transactions) || block.transactions.length > 0) return undefined;
  // Both header signals are chain-derived; either alone contradicts an empty
  // transaction list, but requiring both keeps the guard away from any block
  // whose logs Ponder would never need anyway (bloom zero ⇒ nothing to index).
  const gasUsed = typeof block.gasUsed === "string" ? safeBigInt(block.gasUsed) : 0n;
  const bloomSet = typeof block.logsBloom === "string" && block.logsBloom.toLowerCase() !== ZERO_LOGS_BLOOM;
  return gasUsed > 0n && bloomSet ? block : undefined;
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Ask every provider for the logs and answer with the one whose result
 * contains every other result. A provider with a receipt-store gap answers a
 * filtered range with fewer logs and nothing in that answer says so — after
 * the 2026-09-11 restart the mainnet index silently skipped the three
 * EscrowCore claim events of block 20501734 this way. Providers that fail or
 * outlast the grace are dropped from the comparison (warned), never guessed
 * around; genuinely conflicting answers are refused.
 */
async function crossCheckLogs(
  providers: Provider[],
  args: RpcRequestArgs,
  { warn, graceMs }: { warn: (message: string) => void; graceMs: number }
): Promise<unknown> {
  const controller = new AbortController();
  const settled = await settleWithGrace(
    providers.map((provider) => provider.transport.request(args as never, { signal: controller.signal })),
    graceMs,
    () => controller.abort()
  );

  const answers: LogsAnswer[] = [];
  let lastFailure: unknown;
  settled.forEach((outcome, index) => {
    const url = providers[index]!.url;
    if (outcome.status === "rejected") {
      lastFailure = outcome.reason;
      warn(`eth_getLogs cross-check degraded: ${url} did not answer (${describeError(outcome.reason)}); comparing the remaining providers only.`);
      return;
    }
    if (!Array.isArray(outcome.value)) {
      lastFailure = new Error(`${url} answered eth_getLogs with a non-array result`);
      warn(`eth_getLogs cross-check degraded: ${url} answered with a non-array result; comparing the remaining providers only.`);
      return;
    }
    const value = outcome.value as LogShape[];
    answers.push({ url, value, keys: new Set(value.map(logKey)) });
  });

  if (answers.length === 0) throw lastFailure;

  const best = answers.find((candidate) => answers.every((other) => isSuperset(candidate.keys, other.keys)));
  if (!best) throw new InconsistentLogsResponseError({ params: args.params, answers });

  for (const other of answers) {
    if (other === best || other.keys.size === best.keys.size) continue;
    const missing = [...best.keys].filter((key) => !other.keys.has(key));
    warn(`${other.url} omitted ${missing.length} log(s) present at ${best.url} for eth_getLogs ${JSON.stringify(args.params)}: ${describeLogKeys(missing)}. Report this block hole to the provider; the index used ${best.url}'s answer.`);
  }
  return best.value;
}

/**
 * Settle every promise, except that once one has FULFILLED the rest get at
 * most `graceMs`; then `abandon()` runs (aborting the in-flight requests) and
 * the laggards report as rejected. A rejection alone never starts the clock:
 * a fast failure must not shorten the wait for the provider that may answer.
 */
function settleWithGrace<T>(
  promises: Promise<T>[],
  graceMs: number,
  abandon: () => void
): Promise<PromiseSettledResult<T>[]> {
  return new Promise((resolve) => {
    const results: Array<PromiseSettledResult<T> | undefined> = promises.map(() => undefined);
    let pending = promises.length;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      if (pending > 0) abandon();
      resolve(results.map((result) => result ?? {
        status: "rejected",
        reason: new Error(`no answer within the ${graceMs}ms cross-check grace`)
      }));
    };
    promises.forEach((promise, index) => {
      promise.then(
        (value) => {
          results[index] = { status: "fulfilled", value };
          pending -= 1;
          if (pending === 0) finish();
          else if (timer === undefined) timer = setTimeout(finish, graceMs);
        },
        (reason: unknown) => {
          results[index] = { status: "rejected", reason };
          pending -= 1;
          if (pending === 0) finish();
        }
      );
    });
  });
}

function logKey(log: LogShape): string {
  return `${log.blockHash ?? "?"}:${log.blockNumber ?? "?"}:${log.logIndex ?? "?"}`;
}

function describeLogKeys(keys: string[]): string {
  return keys.map((key) => {
    const [, blockNumber, logIndex] = key.split(":");
    const number = blockNumber && blockNumber !== "?" ? hexToNumber(blockNumber as Hex) : "?";
    const index = logIndex && logIndex !== "?" ? hexToNumber(logIndex as Hex) : "?";
    return `${number}#${index}`;
  }).join(", ");
}

function isSuperset(candidate: Set<string>, other: Set<string>): boolean {
  for (const key of other) if (!candidate.has(key)) return false;
  return true;
}

function describeError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return String(error);
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
