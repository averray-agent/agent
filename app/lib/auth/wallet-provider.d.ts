export type WalletProviderKind = "injected" | "walletconnect";
export type WalletProviderAvailability = "checking" | "available" | "unavailable";
export type WalletConnectionStatus = "idle" | "connecting" | "pairing" | "connected" | "restoring" | "chain_refused" | "pairing_expired" | "session_expired" | "error";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (payload: never) => void): unknown;
  disconnect?(): Promise<void>;
  connected?: boolean;
  accounts?: string[];
  session?: {
    expiry?: number;
    namespaces?: Record<string, { chains?: string[]; accounts?: string[] }>;
  };
  signer?: {
    abortPairingAttempt?(): void;
    cleanupPendingPairings?(): Promise<void>;
  };
}

export interface WalletProviderSnapshot {
  availability: WalletProviderAvailability;
  status: WalletConnectionStatus;
  kind: WalletProviderKind | null;
  account: string | null;
  pairingUri: string | null;
  pairingExpiresAt: number | null;
  sessionExpiresAt: number | null;
  injectedAvailable: boolean;
  walletConnectAvailable: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ActiveWalletProvider {
  kind: WalletProviderKind;
  provider: Eip1193Provider;
  account: string | null;
}

export declare const HUB_CHAIN_ID: 420420419;
export declare const HUB_CHAIN_REFERENCE: "eip155:420420419";
export declare const WALLET_PROVIDER_STORAGE_KEY: string;

export declare class WalletUnavailableError extends Error { code: "wallet_provider_unavailable"; }
export declare class WalletConnectDisabledError extends Error { code: "walletconnect_disabled"; }
export declare class WalletChainRefusedError extends Error { code: "wallet_chain_refused"; }
export declare class WalletPairingExpiredError extends Error { code: "wallet_pairing_expired"; }
export declare class WalletPairingCancelledError extends Error { code: "wallet_pairing_cancelled"; }

export declare function createWalletProviderController(options?: Record<string, unknown>): {
  subscribe(listener: (snapshot: WalletProviderSnapshot) => void): () => void;
  getSnapshot(): WalletProviderSnapshot;
  inspect(): WalletProviderSnapshot;
  connect(kind?: WalletProviderKind): Promise<ActiveWalletProvider>;
  restore(): Promise<ActiveWalletProvider | null>;
  getActive(): Promise<ActiveWalletProvider>;
  cancelPairing(): Promise<void>;
  disconnect(): Promise<void>;
  sendTransaction(transaction: Record<string, unknown>): Promise<unknown>;
};

export declare const subscribeWalletProvider: (listener: (snapshot: WalletProviderSnapshot) => void) => () => void;
export declare const getWalletProviderSnapshot: () => WalletProviderSnapshot;
export declare const inspectWalletProviders: () => WalletProviderSnapshot;
export declare const connectWallet: (kind?: WalletProviderKind) => Promise<ActiveWalletProvider>;
export declare const restoreWalletProvider: () => Promise<ActiveWalletProvider | null>;
export declare const getActiveWalletProvider: () => Promise<ActiveWalletProvider>;
export declare const cancelWalletPairing: () => Promise<void>;
export declare const disconnectWallet: () => Promise<void>;
export declare const sendWalletTransaction: (transaction: Record<string, unknown>) => Promise<unknown>;
