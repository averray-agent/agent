/**
 * Frontend auth module — owns the SIWE sign-in flow and JWT lifecycle.
 *
 * Responsibilities:
 *   - Perform SIWE login against POST /api/auth/nonce + POST /api/auth/verify.
 *   - Persist the resulting JWT + wallet + expiry in localStorage so tab
 *     reloads don't force a new signature.
 *   - Expose `getAuthToken()`, `getAuthHeader()`, and `getAuthWallet()` for the
 *     HTTP and SSE clients.
 *   - Handle 401s by clearing the token and inviting the user to sign in again
 *     via `requestReauth()`.
 *
 * This module does not render UI on its own — callers subscribe via
 * `onAuthChange(listener)` and update their own DOM.
 */

import { apiUrl } from "./config.js";
import { debug } from "./ui-helpers.js";

const TOKEN_KEY = "averray:auth-token";
const WALLET_KEY = "averray:auth-wallet";
const EXPIRES_KEY = "averray:auth-expires-at";
const REAUTH_REASON_KEY = "averray:auth-last-reason";
// Refresh slightly before expiry so an in-flight request never hits the wire
// with an already-expired token.
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

const listeners = new Set();
let reauthPromise = undefined;

function readSession() {
  const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
  const wallet = localStorage.getItem(WALLET_KEY) ?? undefined;
  const expiresAt = localStorage.getItem(EXPIRES_KEY) ?? undefined;
  if (!token || !wallet || !expiresAt) {
    return undefined;
  }
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs - EXPIRY_SAFETY_MARGIN_MS <= Date.now()) {
    return undefined;
  }
  return { token, wallet, expiresAt };
}

function writeSession({ token, wallet, expiresAt }) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(WALLET_KEY, wallet);
  localStorage.setItem(EXPIRES_KEY, expiresAt);
  localStorage.removeItem(REAUTH_REASON_KEY);
  notify();
}

function clearSession(reason) {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WALLET_KEY);
  localStorage.removeItem(EXPIRES_KEY);
  if (reason) {
    localStorage.setItem(REAUTH_REASON_KEY, reason);
  } else {
    localStorage.removeItem(REAUTH_REASON_KEY);
  }
  notify();
}

function notify() {
  const snapshot = getAuthSnapshot();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      debug.error("[auth] listener threw", error);
    }
  }
}

export function onAuthChange(listener) {
  listeners.add(listener);
  listener(getAuthSnapshot());
  return () => listeners.delete(listener);
}

export function getAuthSnapshot() {
  const session = readSession();
  return {
    authenticated: Boolean(session),
    wallet: session?.wallet,
    expiresAt: session?.expiresAt,
    lastReason: localStorage.getItem(REAUTH_REASON_KEY) ?? undefined
  };
}

export function getAuthToken() {
  return readSession()?.token;
}

export function getAuthWallet() {
  return readSession()?.wallet;
}

export function getAuthHeader() {
  const token = getAuthToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function isAuthenticated() {
  return Boolean(readSession());
}

/**
 * Run the full SIWE login flow end-to-end.
 *
 * Flow:
 *   1. Request accounts from MetaMask / Talisman / WalletConnect via
 *      `window.ethereum`.
 *   2. POST /api/auth/nonce { wallet } → server returns a nonce and the exact
 *      SIWE message to sign.
 *   3. `personal_sign` the message with the chosen account.
 *   4. POST /api/auth/verify { message, signature } → server returns JWT.
 *   5. Persist JWT, emit auth-change event.
 */
export async function signIn() {
  const provider = window.ethereum;
  if (!provider?.request) {
    throw new Error("No Ethereum provider detected. Install MetaMask or Talisman to sign in.");
  }

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const rawAddress = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!rawAddress) {
    throw new Error("Wallet returned no accounts. Unlock the wallet and retry.");
  }

  const nonceResponse = await fetch(apiUrl("/auth/nonce"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: rawAddress })
  });
  const noncePayload = await nonceResponse.json().catch(() => ({}));
  if (!nonceResponse.ok) {
    throw new Error(noncePayload?.message ?? `/auth/nonce failed (${nonceResponse.status})`);
  }

  // `personal_sign` parameter order is [message, address] in the MetaMask spec.
  const signature = await provider.request({
    method: "personal_sign",
    params: [noncePayload.message, rawAddress]
  });

  const verifyResponse = await fetch(apiUrl("/auth/verify"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: noncePayload.message, signature })
  });
  const verifyPayload = await verifyResponse.json().catch(() => ({}));
  if (!verifyResponse.ok) {
    throw new Error(verifyPayload?.message ?? `/auth/verify failed (${verifyResponse.status})`);
  }

  writeSession({
    token: verifyPayload.token,
    wallet: verifyPayload.wallet ?? rawAddress,
    expiresAt: verifyPayload.expiresAt
  });

  return {
    wallet: verifyPayload.wallet ?? rawAddress,
    expiresAt: verifyPayload.expiresAt
  };
}

export async function signOut() {
  // Best-effort server-side revocation. If the call fails (network, server
  // already down, etc.) we still clear the local session — revocation only
  // matters as long as the token could still authenticate an attacker.
  const token = getAuthToken();
  if (token) {
    try {
      await fetch(apiUrl("/auth/logout"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      });
    } catch (error) {
      debug.warn("[auth] logout call failed; clearing local session anyway", error);
    }
  }
  clearSession("signed_out");
}

/**
 * Called by the HTTP/SSE clients when the server rejects the current token.
 * Clears the cached session and returns a promise that resolves when the user
 * has signed in again. Concurrent calls share the same prompt so we never
 * stack multiple MetaMask dialogs.
 */
export function requestReauth(reason = "expired") {
  clearSession(reason);
  if (!reauthPromise) {
    reauthPromise = signIn().finally(() => {
      reauthPromise = undefined;
    });
  }
  return reauthPromise;
}

// Cross-tab sync: signing in/out in one tab updates the others.
window.addEventListener("storage", (event) => {
  if (event.key === TOKEN_KEY || event.key === WALLET_KEY || event.key === EXPIRES_KEY) {
    notify();
  }
});
