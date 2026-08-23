"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  getWalletProviderSnapshot,
  inspectWalletProviders,
  restoreWalletProvider,
  subscribeWalletProvider,
  type WalletProviderSnapshot,
} from "./wallet-provider.js";

export type WalletProviderState = "checking" | "available" | "unavailable";

let discoveryStarted = false;
const serverSnapshot: WalletProviderSnapshot = {
  availability: "checking",
  status: "idle",
  kind: null,
  account: null,
  pairingUri: null,
  pairingExpiresAt: null,
  sessionExpiresAt: null,
  injectedAvailable: false,
  walletConnectAvailable: false,
  errorCode: null,
  errorMessage: null,
};

function startDiscovery() {
  if (discoveryStarted || typeof window === "undefined") return;
  discoveryStarted = true;
  const inspect = () => inspectWalletProviders();
  inspect();
  window.addEventListener("ethereum#initialized", inspect, { once: true });
  window.setTimeout(inspect, 500);
  // The WalletConnect SDK owns its encrypted session persistence. Restoration
  // is deliberate and never triggers SIWE or a signature request.
  void restoreWalletProvider();
}

export function useWalletConnection(): WalletProviderSnapshot {
  const snapshot = useSyncExternalStore(
    subscribeWalletProvider,
    getWalletProviderSnapshot,
    () => serverSnapshot,
  );

  useEffect(() => {
    startDiscovery();
  }, []);

  return snapshot;
}

/** Compatibility projection used by the established readiness classifiers. */
export function useWalletProvider(): WalletProviderState {
  return useWalletConnection().availability;
}
