import {
  AbstractSigner,
  FallbackProvider,
  FetchRequest,
  JsonRpcProvider,
  Transaction,
  TransactionResponse
} from "ethers";

const DEFAULT_RPC_FAILOVER_STALL_MS = 250;
const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 750;
const DEFAULT_RPC_WRITE_REQUEST_TIMEOUT_MS = 15_000;
const MINIMUM_RPC_WRITE_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_HISTORY = 256;
const RPC_PROVIDER_LABEL = Symbol("averray.rpcProviderLabel");
const RETRYABLE_BROADCAST_ERROR_CODES = new Set([
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "TIMEOUT"
]);

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
  const providers = urls.map((url) =>
    createLabeledJsonRpcProvider(url, requestTimeoutMs)
  );
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

/**
 * Build the mutation transport separately from the read provider.
 *
 * Each endpoint is an independent JsonRpcProvider with a patient request
 * timeout. Broadcasts are attempted serially, never through FallbackProvider:
 * before moving to another endpoint, WriteRpcBroadcaster proves that the
 * signed transaction is not already visible and that its nonce is still
 * available. The same signed bytes (and therefore the same hash and nonce)
 * are reused for every attempt.
 */
export function createWriteRpcBroadcaster(config) {
  const requestTimeoutMs = positiveInteger(
    config?.rpcWriteRequestTimeoutMs,
    DEFAULT_RPC_WRITE_REQUEST_TIMEOUT_MS
  );
  if (requestTimeoutMs < MINIMUM_RPC_WRITE_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `RPC write request timeout must be at least ${MINIMUM_RPC_WRITE_REQUEST_TIMEOUT_MS}ms.`
    );
  }
  const providers = normalizeRpcUrls(config).map((url) =>
    createLabeledJsonRpcProvider(url, requestTimeoutMs)
  );
  return new WriteRpcBroadcaster(providers);
}

/**
 * Keep signer reads (nonce, fee data, gas estimation) on the aggressive read
 * provider while routing only the signed broadcast through the patient write
 * transport. TransactionResponse.wait() remains pinned to the write endpoint
 * that accepted or already knew the transaction.
 */
export function bindSignerToWriteBroadcaster(signer, readProvider, broadcaster) {
  if (!signer) {
    return undefined;
  }
  return new PatientWriteSigner(signer.connect(readProvider), readProvider, broadcaster);
}

export function describeRpcProvider(provider) {
  try {
    if (provider?.[RPC_PROVIDER_LABEL]) {
      return provider[RPC_PROVIDER_LABEL];
    }
    const rawUrl = provider?._getConnection?.()?.url;
    if (!rawUrl) {
      return "unknown";
    }
    // Identify the selected endpoint without ever logging credentials, query
    // strings, or keyed-provider path segments.
    return new URL(rawUrl).origin;
  } catch {
    return "unknown";
  }
}

function createLabeledJsonRpcProvider(url, requestTimeoutMs) {
  const request = new FetchRequest(url);
  request.timeout = requestTimeoutMs;
  const provider = new JsonRpcProvider(request);
  Object.defineProperty(provider, RPC_PROVIDER_LABEL, {
    value: safeRpcOrigin(url),
    enumerable: false
  });
  return provider;
}

function safeRpcOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "unknown";
  }
}

export class WriteRpcBroadcaster {
  #providers;
  #providerByTransactionHash = new Map();

  constructor(providers) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error("WriteRpcBroadcaster requires at least one RPC provider.");
    }
    this.#providers = providers;
  }

  async broadcastTransaction(signedTransaction) {
    const transaction = Transaction.from(signedTransaction);
    if (!transaction.hash || !transaction.from) {
      throw new Error("Write broadcast requires a signed transaction with hash and sender.");
    }

    let lastError;
    for (let index = 0; index < this.#providers.length; index += 1) {
      const provider = this.#providers[index];
      if (index > 0) {
        const state = await inspectTransactionState(provider, transaction);
        const recovered = recoverKnownTransaction(state, transaction, provider);
        if (recovered) {
          return this.#recordProvider(recovered, provider, transaction.hash);
        }
        assertNonceAvailable(state, transaction);
      }

      try {
        const response = await provider.broadcastTransaction(signedTransaction);
        return this.#recordProvider(response, provider, transaction.hash);
      } catch (error) {
        if (!isRetryableBroadcastError(error)) {
          throw error;
        }
        lastError = error;
        const state = await inspectTransactionState(provider, transaction)
          .catch(() => undefined);
        if (state) {
          const recovered = recoverKnownTransaction(state, transaction, provider);
          if (recovered) {
            return this.#recordProvider(recovered, provider, transaction.hash);
          }
          assertNonceAvailable(state, transaction);
        }
      }
    }
    throw lastError ?? new Error(`Unable to broadcast transaction ${transaction.hash}.`);
  }

  takeProviderUsed(transactionHash) {
    const key = normalizeTransactionHash(transactionHash);
    if (!key) {
      return undefined;
    }
    const providerUsed = this.#providerByTransactionHash.get(key);
    this.#providerByTransactionHash.delete(key);
    return providerUsed;
  }

  #recordProvider(response, provider, transactionHash) {
    const key = normalizeTransactionHash(transactionHash);
    if (key) {
      this.#providerByTransactionHash.delete(key);
      this.#providerByTransactionHash.set(key, describeRpcProvider(provider));
      while (this.#providerByTransactionHash.size > MAX_PROVIDER_HISTORY) {
        const oldest = this.#providerByTransactionHash.keys().next().value;
        this.#providerByTransactionHash.delete(oldest);
      }
    }
    return response;
  }

  async destroy() {
    this.#providerByTransactionHash.clear();
    await Promise.all(this.#providers.map((provider) => provider.destroy?.()));
  }
}

function normalizeTransactionHash(value) {
  return typeof value === "string" && value.length > 0
    ? value.toLowerCase()
    : undefined;
}

class PatientWriteSigner extends AbstractSigner {
  #signer;
  #broadcaster;

  constructor(signer, readProvider, broadcaster) {
    super(readProvider);
    this.#signer = signer;
    this.#broadcaster = broadcaster;
  }

  connect(provider) {
    return new PatientWriteSigner(
      this.#signer.connect(provider),
      provider,
      this.#broadcaster
    );
  }

  getAddress() {
    return this.#signer.getAddress();
  }

  signTransaction(transaction) {
    return this.#signer.signTransaction(transaction);
  }

  signMessage(message) {
    return this.#signer.signMessage(message);
  }

  signTypedData(domain, types, value) {
    return this.#signer.signTypedData(domain, types, value);
  }

  async sendTransaction(transaction) {
    const populated = await this.populateTransaction(transaction);
    delete populated.from;
    const signedTransaction = await this.signTransaction(Transaction.from(populated));
    return this.#broadcaster.broadcastTransaction(signedTransaction);
  }
}

async function inspectTransactionState(provider, transaction) {
  const knownTransaction = await provider.getTransaction(transaction.hash);
  if (knownTransaction) {
    return { knownTransaction };
  }
  const receipt = await provider.getTransactionReceipt(transaction.hash);
  if (receipt) {
    return { receipt };
  }
  const [pendingNonce, latestNonce] = await Promise.all([
    provider.getTransactionCount(transaction.from, "pending"),
    provider.getTransactionCount(transaction.from, "latest")
  ]);
  return { pendingNonce, latestNonce };
}

function recoverKnownTransaction(state, transaction, provider) {
  if (state.knownTransaction) {
    return state.knownTransaction;
  }
  if (!state.receipt) {
    return undefined;
  }
  return new TransactionResponse({
    hash: transaction.hash,
    from: transaction.from,
    to: transaction.to,
    nonce: transaction.nonce,
    gasLimit: transaction.gasLimit,
    gasPrice: transaction.gasPrice,
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    maxFeePerGas: transaction.maxFeePerGas,
    maxFeePerBlobGas: transaction.maxFeePerBlobGas,
    data: transaction.data,
    value: transaction.value,
    chainId: transaction.chainId,
    signature: transaction.signature,
    accessList: transaction.accessList,
    blobVersionedHashes: transaction.blobVersionedHashes,
    authorizationList: transaction.authorizationList,
    type: transaction.type,
    blockNumber: state.receipt.blockNumber,
    blockHash: state.receipt.blockHash,
    index: state.receipt.index
  }, provider);
}

function assertNonceAvailable(state, transaction) {
  const pendingNonce = BigInt(state.pendingNonce ?? 0);
  const latestNonce = BigInt(state.latestNonce ?? 0);
  const nextNonce = pendingNonce > latestNonce ? pendingNonce : latestNonce;
  if (nextNonce <= BigInt(transaction.nonce)) {
    return;
  }
  const error = new Error(
    `Refusing to rebroadcast transaction ${transaction.hash}: sender nonce ` +
      `${transaction.nonce} is already pending or mined, but the signed hash is not visible.`
  );
  error.code = "TRANSACTION_NONCE_AMBIGUOUS";
  error.transactionHash = transaction.hash;
  error.transactionNonce = transaction.nonce;
  throw error;
}

function isRetryableBroadcastError(error) {
  if (RETRYABLE_BROADCAST_ERROR_CODES.has(error?.code)) {
    return true;
  }
  const message = String(error?.message ?? "").toLowerCase();
  return [
    "fetch failed",
    "network",
    "socket",
    "timed out",
    "timeout"
  ].some((fragment) => message.includes(fragment));
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
