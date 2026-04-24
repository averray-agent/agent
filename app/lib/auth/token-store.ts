/**
 * LocalStorage-backed session store for the SIWE JWT.
 *
 * Ported from frontend/auth.js. Keys are kept intentionally identical so
 * an operator who already signed into the legacy frontend isn't forced to
 * re-SIWE when we flip the canonical app over.
 *
 * Expiry handling: we subtract a 30s safety margin so an in-flight
 * request never leaves the client with an already-expired bearer.
 */

const TOKEN_KEY = "averray:auth-token";
const WALLET_KEY = "averray:auth-wallet";
const EXPIRES_KEY = "averray:auth-expires-at";
const ROLES_KEY = "averray:auth-roles";
const REAUTH_REASON_KEY = "averray:auth-last-reason";
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

export interface AuthSession {
  token: string;
  wallet: string;
  expiresAt: string;
  roles: string[];
}

export interface AuthSnapshot {
  authenticated: boolean;
  wallet?: string;
  expiresAt?: string;
  roles: string[];
  lastReason?: string;
}

type Listener = (snapshot: AuthSnapshot) => void;

const listeners = new Set<Listener>();

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function readRoles(): string[] {
  if (!hasWindow()) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(ROLES_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((role): role is string => typeof role === "string")
      : [];
  } catch {
    return [];
  }
}

function readSession(): AuthSession | undefined {
  if (!hasWindow()) return undefined;
  const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
  const wallet = localStorage.getItem(WALLET_KEY) ?? undefined;
  const expiresAt = localStorage.getItem(EXPIRES_KEY) ?? undefined;
  if (!token || !wallet || !expiresAt) return undefined;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs - EXPIRY_SAFETY_MARGIN_MS <= Date.now()) {
    return undefined;
  }
  return { token, wallet, expiresAt, roles: readRoles() };
}

export function getAuthSnapshot(): AuthSnapshot {
  const session = readSession();
  return {
    authenticated: Boolean(session),
    wallet: session?.wallet,
    expiresAt: session?.expiresAt,
    roles: session?.roles ?? [],
    lastReason: hasWindow() ? localStorage.getItem(REAUTH_REASON_KEY) ?? undefined : undefined,
  };
}

export function getStoredToken(): string | undefined {
  return readSession()?.token;
}

export function writeSession(session: AuthSession): void {
  if (!hasWindow()) return;
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(WALLET_KEY, session.wallet);
  localStorage.setItem(EXPIRES_KEY, session.expiresAt);
  localStorage.setItem(ROLES_KEY, JSON.stringify(session.roles ?? []));
  localStorage.removeItem(REAUTH_REASON_KEY);
  notify();
}

export function clearSession(reason?: string): void {
  if (!hasWindow()) return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WALLET_KEY);
  localStorage.removeItem(EXPIRES_KEY);
  localStorage.removeItem(ROLES_KEY);
  if (reason) {
    localStorage.setItem(REAUTH_REASON_KEY, reason);
  } else {
    localStorage.removeItem(REAUTH_REASON_KEY);
  }
  notify();
}

export function onAuthChange(listener: Listener): () => void {
  listeners.add(listener);
  listener(getAuthSnapshot());
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  const snapshot = getAuthSnapshot();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[auth] listener threw", error);
    }
  }
}

// Cross-tab sync: when another tab writes or clears the session,
// notify local subscribers so UI reflects the change without a reload.
if (hasWindow()) {
  window.addEventListener("storage", (event) => {
    if (
      event.key === TOKEN_KEY ||
      event.key === WALLET_KEY ||
      event.key === EXPIRES_KEY ||
      event.key === ROLES_KEY
    ) {
      notify();
    }
  });
}
