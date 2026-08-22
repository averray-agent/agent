"use client";

import { useEffect, useState } from "react";

export type WalletProviderState = "checking" | "available" | "unavailable";

export function useWalletProvider(): WalletProviderState {
  const [state, setState] = useState<WalletProviderState>("checking");

  useEffect(() => {
    let active = true;
    const inspect = () => {
      if (!active) return;
      setState(window.ethereum?.request ? "available" : "unavailable");
    };

    inspect();
    // MetaMask can inject after the document starts. Honour its standard
    // initialization event without keeping wallet access ambiguously enabled.
    window.addEventListener("ethereum#initialized", inspect, { once: true });
    const lateInjectionCheck = window.setTimeout(inspect, 500);
    return () => {
      active = false;
      window.clearTimeout(lateInjectionCheck);
      window.removeEventListener("ethereum#initialized", inspect);
    };
  }, []);

  return state;
}
