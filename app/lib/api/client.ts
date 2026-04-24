/**
 * Thin typed wrapper around the existing Averray SDK.
 *
 * We intentionally don't reimplement fetches — the SDK at
 * sdk/agent-platform-client.js already mirrors the full HTTP surface and
 * ships d.ts types. This module only adds:
 *   - a browser-singleton client bound to the configured baseUrl
 *   - an ApiError class with HTTP status so auth hooks can react to 401
 *   - a `swrFetcher` the hooks layer can compose with SWR
 *
 * Source of truth for response shapes: sdk/agent-platform-client.d.ts.
 */
import { AgentPlatformClient } from "../../../sdk/agent-platform-client.js";
import { getStoredToken } from "@/lib/auth/token-store";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function resolveBaseUrl(): string {
  const override =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_BASE_URL : undefined;
  if (override) return override.replace(/\/+$/u, "");
  // Fall back to same-origin proxy configured in next.config.ts
  return "/api";
}

let clientSingleton: InstanceType<typeof AgentPlatformClient> | null = null;

export function getClient(): InstanceType<typeof AgentPlatformClient> {
  if (!clientSingleton) {
    clientSingleton = new AgentPlatformClient({
      baseUrl: resolveBaseUrl(),
      token: getStoredToken() ?? undefined,
    });
  }
  return clientSingleton;
}

export function setClientToken(token: string | undefined) {
  getClient().setToken(token);
}

/**
 * SWR-compatible fetcher. Accepts either a raw path string ("/account")
 * or a [path, init] tuple.
 */
export async function swrFetcher<T = unknown>(
  key: string | [string, RequestInit?]
): Promise<T> {
  const [path, init] = Array.isArray(key) ? key : [key, undefined];
  const baseUrl = resolveBaseUrl();
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  const token = getStoredToken();
  const headers = new Headers(init?.headers ?? {});
  headers.set("accept", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(url, { ...init, headers });
  const bodyText = await response.text();
  let body: unknown = bodyText;
  try {
    body = bodyText.length ? JSON.parse(bodyText) : null;
  } catch {
    // keep raw text if not JSON
  }

  if (!response.ok) {
    throw new ApiError(
      `${response.status} ${response.statusText || "Request failed"}`,
      response.status,
      body
    );
  }
  return body as T;
}
