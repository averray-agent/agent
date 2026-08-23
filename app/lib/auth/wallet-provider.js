"use client";

export const HUB_CHAIN_ID = 420420419;
export const HUB_CHAIN_REFERENCE = `eip155:${HUB_CHAIN_ID}`;
export const WALLET_PROVIDER_STORAGE_KEY = "averray:wallet-provider:v1";

const REQUIRED_METHODS = [
  "eth_accounts",
  "eth_requestAccounts",
  "eth_chainId",
  "eth_sendTransaction",
  "personal_sign",
  "wallet_addEthereumChain",
  "wallet_switchEthereumChain",
];
const REQUIRED_EVENTS = ["accountsChanged", "chainChanged"];
const DEFAULT_PAIRING_LIFETIME_MS = 5 * 60 * 1_000;

export class WalletUnavailableError extends Error {
  constructor(message = "No wallet provider is available. Connect your wallet and retry.") {
    super(message);
    this.name = "WalletUnavailableError";
    this.code = "wallet_provider_unavailable";
  }
}

export class WalletConnectDisabledError extends Error {
  constructor() {
    super("WalletConnect mobile signing is not enabled yet.");
    this.name = "WalletConnectDisabledError";
    this.code = "walletconnect_disabled";
  }
}

export class WalletChainRefusedError extends Error {
  constructor() {
    super(`The wallet declined the requested chain. Switch the wallet network to Polkadot Hub (${HUB_CHAIN_REFERENCE}) and retry.`);
    this.name = "WalletChainRefusedError";
    this.code = "wallet_chain_refused";
  }
}

export class WalletPairingExpiredError extends Error {
  constructor() {
    super("The wallet pairing expired before approval. No signature was made.");
    this.name = "WalletPairingExpiredError";
    this.code = "wallet_pairing_expired";
  }
}

export class WalletPairingCancelledError extends Error {
  constructor() {
    super("Wallet pairing cancelled.");
    this.name = "WalletPairingCancelledError";
    this.code = "wallet_pairing_cancelled";
  }
}

function browserWindow() {
  return typeof window === "undefined" ? undefined : window;
}

function browserStorage() {
  const currentWindow = browserWindow();
  try {
    return currentWindow?.localStorage;
  } catch {
    return undefined;
  }
}

function injectedProvider(currentWindow = browserWindow()) {
  const provider = currentWindow?.ethereum;
  return provider?.request ? provider : null;
}

function safeParseSelection(storage) {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(WALLET_PROVIDER_STORAGE_KEY) ?? "null");
    if (value?.version !== 1 || !["injected", "walletconnect"].includes(value.kind)) return null;
    return value.kind;
  } catch {
    return null;
  }
}

function writeSelection(storage, kind) {
  if (!storage) return;
  if (!kind) {
    storage.removeItem(WALLET_PROVIDER_STORAGE_KEY);
    return;
  }
  storage.setItem(WALLET_PROVIDER_STORAGE_KEY, JSON.stringify({ version: 1, kind }));
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function errorCode(value) {
  return value && typeof value === "object" && "code" in value ? Number(value.code) : null;
}

function isChainRefusal(value) {
  const message = asError(value).message.toLowerCase();
  return errorCode(value) === 4902
    || /unsupported chain|unsupported namespace|requested chain|chain.*reject|chain.*declin/u.test(message);
}

function pairingExpiryFromUri(uri, now) {
  try {
    const query = uri.split("?")[1] ?? "";
    const expirySeconds = Number(new URLSearchParams(query).get("expiryTimestamp"));
    return Number.isFinite(expirySeconds) && expirySeconds > 0
      ? expirySeconds * 1_000
      : now() + DEFAULT_PAIRING_LIFETIME_MS;
  } catch {
    return now() + DEFAULT_PAIRING_LIFETIME_MS;
  }
}

function approvedChains(provider) {
  const namespaces = provider?.session?.namespaces;
  if (!namespaces || typeof namespaces !== "object") return [];
  return Object.values(namespaces).flatMap((namespace) => {
    const chains = Array.isArray(namespace?.chains) ? namespace.chains : [];
    const accountChains = Array.isArray(namespace?.accounts)
      ? namespace.accounts.map((account) => String(account).split(":").slice(0, 2).join(":"))
      : [];
    return [...chains, ...accountChains];
  });
}

function firstAccount(provider, requestedAccounts) {
  const accounts = Array.isArray(requestedAccounts) ? requestedAccounts : provider?.accounts;
  return Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
}

function walletConnectSessionExpiry(provider) {
  const seconds = Number(provider?.session?.expiry);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}

async function createBrowserWalletConnectProvider(options) {
  const module = await import("@walletconnect/ethereum-provider");
  const EthereumProvider = module.default;
  return EthereumProvider.init(options);
}

/**
 * The one transport-neutral wallet boundary used by SIWE, readiness, and
 * unsigned transaction flows. Dependencies are injectable so the real pairing
 * lifecycle can be drilled without a relay or a browser extension.
 */
export function createWalletProviderController({
  currentWindow = browserWindow,
  storage = browserStorage,
  projectId = "",
  walletConnectEnabled = false,
  createWalletConnectProvider = createBrowserWalletConnectProvider,
  now = Date.now,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
} = {}) {
  const listeners = new Set();
  let activeProvider = null;
  let activeKind = null;
  let pendingProvider = null;
  let rejectPendingPairing = null;
  let restorePromise = null;
  let explicitDisconnect = false;
  let pairingTimer = null;
  let sessionTimer = null;
  let state = {
    availability: "checking",
    status: "idle",
    kind: null,
    account: null,
    pairingUri: null,
    pairingExpiresAt: null,
    sessionExpiresAt: null,
    injectedAvailable: false,
    walletConnectAvailable: Boolean(walletConnectEnabled && projectId),
    errorCode: null,
    errorMessage: null,
  };

  function emit(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function inspect() {
    const hasInjected = Boolean(injectedProvider(currentWindow()));
    const hasWalletConnect = Boolean(walletConnectEnabled && projectId);
    emit({
      availability: hasInjected || hasWalletConnect ? "available" : "unavailable",
      injectedAvailable: hasInjected,
      walletConnectAvailable: hasWalletConnect,
    });
    return state;
  }

  function clearPairingTimer() {
    if (pairingTimer !== null) cancelSchedule(pairingTimer);
    pairingTimer = null;
  }

  function clearSessionTimer() {
    if (sessionTimer !== null) cancelSchedule(sessionTimer);
    sessionTimer = null;
  }

  function markWalletSessionExpired() {
    clearSessionTimer();
    activeProvider = null;
    emit({
      status: "session_expired",
      kind: "walletconnect",
      account: null,
      pairingUri: null,
      pairingExpiresAt: null,
      sessionExpiresAt: null,
      errorCode: "wallet_session_expired",
      errorMessage: "Your wallet pairing expired. Reconnect your wallet to continue.",
    });
  }

  function scheduleSessionExpiry(provider) {
    clearSessionTimer();
    const expiresAt = walletConnectSessionExpiry(provider);
    if (!expiresAt) return null;
    const delay = Math.max(0, expiresAt - now());
    sessionTimer = schedule(markWalletSessionExpired, delay);
    return expiresAt;
  }

  function attachProviderEvents(provider, kind) {
    if (typeof provider?.on !== "function") return;
    provider.on("accountsChanged", (accounts) => {
      emit({ account: firstAccount(provider, accounts) });
    });
    if (kind !== "walletconnect") return;
    provider.on("session_delete", () => {
      if (!explicitDisconnect) markWalletSessionExpired();
    });
    provider.on("disconnect", () => {
      if (explicitDisconnect) return;
      markWalletSessionExpired();
    });
  }

  function assertRequiredWalletConnectChain(provider) {
    if (!approvedChains(provider).includes(HUB_CHAIN_REFERENCE)) {
      throw new WalletChainRefusedError();
    }
  }

  async function initWalletConnect() {
    if (!walletConnectEnabled || !projectId) throw new WalletConnectDisabledError();
    return createWalletConnectProvider({
      projectId,
      chains: [HUB_CHAIN_ID],
      methods: REQUIRED_METHODS,
      events: REQUIRED_EVENTS,
      showQrModal: false,
      metadata: {
        name: "Averray",
        description: "Averray wallet signing",
        url: currentWindow()?.location?.origin ?? "https://app.averray.com",
        icons: ["https://averray.com/favicon.svg"],
      },
    });
  }

  async function connectInjected() {
    const provider = injectedProvider(currentWindow());
    if (!provider) {
      inspect();
      throw new WalletUnavailableError("No browser wallet provider was detected. Install or open a wallet browser and retry.");
    }
    emit({ status: "connecting", kind: "injected", errorCode: null, errorMessage: null });
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const account = firstAccount(provider, accounts);
    if (!account) throw new WalletUnavailableError("The browser wallet returned no account. Unlock it and retry.");
    activeProvider = provider;
    activeKind = "injected";
    attachProviderEvents(provider, activeKind);
    writeSelection(storage(), activeKind);
    emit({ status: "connected", kind: activeKind, account });
    return { kind: activeKind, provider, account };
  }

  async function connectWalletConnect() {
    emit({
      status: "connecting",
      kind: "walletconnect",
      pairingUri: null,
      pairingExpiresAt: null,
      errorCode: null,
      errorMessage: null,
    });
    try {
      const provider = await initWalletConnect();
      pendingProvider = provider;
      attachProviderEvents(provider, "walletconnect");
      const pairingFailure = new Promise((_, reject) => {
        rejectPendingPairing = reject;
      });
      provider.on?.("display_uri", (uri) => {
        const expiresAt = pairingExpiryFromUri(uri, now);
        clearPairingTimer();
        pairingTimer = schedule(() => {
          provider.signer?.abortPairingAttempt?.();
          rejectPendingPairing?.(new WalletPairingExpiredError());
        }, Math.max(0, expiresAt - now()));
        emit({ status: "pairing", pairingUri: uri, pairingExpiresAt: expiresAt });
      });

      if (!provider.connected) {
        await Promise.race([
          provider.connect({ chains: [HUB_CHAIN_ID] }),
          pairingFailure,
        ]);
      }
      clearPairingTimer();
      rejectPendingPairing = null;
      pendingProvider = null;
      assertRequiredWalletConnectChain(provider);
      const accounts = await provider.request({ method: "eth_accounts" });
      const account = firstAccount(provider, accounts);
      if (!account) throw new WalletUnavailableError("The paired wallet returned no account. Unlock it and retry.");
      activeProvider = provider;
      activeKind = "walletconnect";
      writeSelection(storage(), activeKind);
      const sessionExpiresAt = scheduleSessionExpiry(provider);
      emit({
        status: "connected",
        kind: activeKind,
        account,
        pairingUri: null,
        pairingExpiresAt: null,
        sessionExpiresAt,
      });
      return { kind: activeKind, provider, account };
    } catch (cause) {
      clearPairingTimer();
      rejectPendingPairing = null;
      pendingProvider = null;
      if (cause instanceof WalletPairingCancelledError) throw cause;
      if (cause instanceof WalletPairingExpiredError) {
        emit({
          status: "pairing_expired",
          pairingUri: null,
          errorCode: cause.code,
          errorMessage: cause.message,
        });
        throw cause;
      }
      const error = isChainRefusal(cause) ? new WalletChainRefusedError() : asError(cause);
      emit({
        status: error instanceof WalletChainRefusedError ? "chain_refused" : "error",
        errorCode: error.code ?? "wallet_connection_failed",
        errorMessage: error.message,
      });
      throw error;
    }
  }

  async function connect(kind) {
    if (!kind) return getActive();
    return kind === "walletconnect" ? connectWalletConnect() : connectInjected();
  }

  async function restore() {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      inspect();
      const selected = safeParseSelection(storage());
      if (selected !== "walletconnect" || !walletConnectEnabled || !projectId) return null;
      emit({ status: "restoring", kind: "walletconnect", errorCode: null, errorMessage: null });
      try {
        const provider = await initWalletConnect();
        if (!provider.connected || !provider.session) {
          emit({ status: "idle", kind: "walletconnect" });
          return null;
        }
        assertRequiredWalletConnectChain(provider);
        const accounts = await provider.request({ method: "eth_accounts" });
        const account = firstAccount(provider, accounts);
        if (!account) return null;
        activeProvider = provider;
        activeKind = "walletconnect";
        attachProviderEvents(provider, activeKind);
        const sessionExpiresAt = scheduleSessionExpiry(provider);
        emit({ status: "connected", kind: activeKind, account, sessionExpiresAt });
        return { kind: activeKind, provider, account };
      } catch (cause) {
        const error = asError(cause);
        if (error instanceof WalletChainRefusedError) {
          emit({ status: "chain_refused", kind: "walletconnect", errorCode: error.code, errorMessage: error.message });
        } else {
          emit({ status: "session_expired", kind: "walletconnect", errorCode: "wallet_session_expired", errorMessage: error.message });
        }
        return null;
      }
    })().finally(() => {
      restorePromise = null;
    });
    return restorePromise;
  }

  async function getActive() {
    if (activeProvider && activeKind) {
      return { kind: activeKind, provider: activeProvider, account: state.account };
    }
    const restored = await restore();
    if (restored) return restored;
    const selected = safeParseSelection(storage());
    if (selected === "walletconnect" && walletConnectEnabled && projectId) {
      throw new WalletUnavailableError("Your wallet pairing is no longer active. Reconnect your wallet before signing.");
    }
    return connectInjected();
  }

  async function cancelPairing() {
    clearPairingTimer();
    pendingProvider?.signer?.abortPairingAttempt?.();
    await pendingProvider?.signer?.cleanupPendingPairings?.().catch?.(() => undefined);
    rejectPendingPairing?.(new WalletPairingCancelledError());
    pendingProvider = null;
    rejectPendingPairing = null;
    emit({ status: "idle", pairingUri: null, pairingExpiresAt: null, errorCode: null, errorMessage: null });
  }

  async function disconnect() {
    explicitDisconnect = true;
    clearPairingTimer();
    clearSessionTimer();
    try {
      if (activeKind === "walletconnect") await activeProvider?.disconnect?.();
    } finally {
      activeProvider = null;
      activeKind = null;
      writeSelection(storage(), null);
      explicitDisconnect = false;
      emit({
        status: "idle",
        kind: null,
        account: null,
        pairingUri: null,
        pairingExpiresAt: null,
        sessionExpiresAt: null,
        errorCode: null,
        errorMessage: null,
      });
      inspect();
    }
  }

  async function sendTransaction(transaction) {
    const active = await getActive();
    return active.provider.request({ method: "eth_sendTransaction", params: [transaction] });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    inspect,
    connect,
    restore,
    getActive,
    cancelPairing,
    disconnect,
    sendTransaction,
  };
}

const walletProviderController = createWalletProviderController({
  projectId: typeof process !== "undefined" ? process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim() : "",
  walletConnectEnabled: typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_WALLETCONNECT_ENABLED === "true"
    : false,
});

export const subscribeWalletProvider = walletProviderController.subscribe;
export const getWalletProviderSnapshot = walletProviderController.getSnapshot;
export const inspectWalletProviders = walletProviderController.inspect;
export const connectWallet = walletProviderController.connect;
export const restoreWalletProvider = walletProviderController.restore;
export const getActiveWalletProvider = walletProviderController.getActive;
export const cancelWalletPairing = walletProviderController.cancelPairing;
export const disconnectWallet = walletProviderController.disconnect;
export const sendWalletTransaction = walletProviderController.sendTransaction;
