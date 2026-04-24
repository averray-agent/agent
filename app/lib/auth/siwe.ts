"use client";

/**
 * SIWE sign-in flow for the operator app.
 *
 * Ported from frontend/auth.js signIn(). Depends only on the browser
 * `window.ethereum` provider (MetaMask / Talisman / Rabby / WalletConnect
 * injected). Keeps the exact server contract:
 *   POST /auth/nonce   { wallet }            → { nonce, message }
 *   personal_sign(message) via wallet
 *   POST /auth/verify  { message, signature }→ { token, wallet, expiresAt, roles }
 */

import { writeSession, clearSession, getStoredToken, type AuthSession } from "./token-store";
import { setClientToken } from "@/lib/api/client";

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

function apiUrl(path: string): string {
  const base =
    (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_BASE_URL : undefined) ??
    "/api";
  return `${base.replace(/\/+$/u, "")}${path}`;
}

export class WalletUnavailableError extends Error {
  constructor() {
    super("No Ethereum provider detected. Install MetaMask or Talisman to sign in.");
    this.name = "WalletUnavailableError";
  }
}

export async function signIn(): Promise<AuthSession> {
  if (typeof window === "undefined") {
    throw new Error("signIn() must run in the browser");
  }
  const provider = window.ethereum;
  if (!provider?.request) throw new WalletUnavailableError();

  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const wallet = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!wallet) {
    throw new Error("Wallet returned no accounts. Unlock the wallet and retry.");
  }

  const nonceRes = await fetch(apiUrl("/auth/nonce"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  const noncePayload = (await nonceRes.json().catch(() => ({}))) as {
    message?: string;
    nonce?: string;
  };
  if (!nonceRes.ok || !noncePayload.message) {
    throw new Error(`/auth/nonce failed (${nonceRes.status})`);
  }

  const signature = (await provider.request({
    method: "personal_sign",
    params: [noncePayload.message, wallet],
  })) as string;

  const verifyRes = await fetch(apiUrl("/auth/verify"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: noncePayload.message, signature }),
  });
  const verifyPayload = (await verifyRes.json().catch(() => ({}))) as {
    token?: string;
    wallet?: string;
    expiresAt?: string;
    roles?: unknown;
  };
  if (!verifyRes.ok || !verifyPayload.token || !verifyPayload.expiresAt) {
    throw new Error(`/auth/verify failed (${verifyRes.status})`);
  }

  const session: AuthSession = {
    token: verifyPayload.token,
    wallet: verifyPayload.wallet ?? wallet,
    expiresAt: verifyPayload.expiresAt,
    roles: Array.isArray(verifyPayload.roles)
      ? verifyPayload.roles.filter((r): r is string => typeof r === "string")
      : [],
  };

  writeSession(session);
  setClientToken(session.token);
  return session;
}

export async function signOut(): Promise<void> {
  const token = getStoredToken();
  if (token) {
    try {
      await fetch(apiUrl("/auth/logout"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      // best-effort: clear locally regardless
    }
  }
  clearSession();
  setClientToken(undefined);
}
