#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_API_BASE_URL = "https://api.averray.com";
export const DEFAULT_ADMIN_REFRESH_TOKEN_OP = "op://prod-smoke/admin-refresh-token/password";
export const REFRESH_COOKIE_NAME = "refresh_token";

export async function getAdminRefreshToken({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readSecretImpl = readOpSecret,
  writeSecretImpl = writeOpSecret
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }

  const apiBaseUrl = stripTrailingSlash(env.API_BASE_URL || DEFAULT_API_BASE_URL);
  const credential = await resolveRefreshCredential({ env, readSecretImpl });
  const response = await fetchImpl(`${apiBaseUrl}/auth/refresh`, {
    method: "POST",
    headers: {
      accept: "application/json",
      cookie: `${REFRESH_COOKIE_NAME}=${credential.refreshToken}`
    }
  });
  const text = await response.text();
  const payload = text ? safeJsonParse(text) : undefined;

  if (!response.ok) {
    throw buildRefreshHttpError({ response, payload });
  }

  const accessToken = payload?.token;
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    throw new Error("POST /auth/refresh succeeded but did not return a token.");
  }

  const rotatedRefreshToken = extractRefreshCookie(response.headers);
  if (credential.writeBackRef) {
    if (!rotatedRefreshToken) {
      throw new Error(
        "POST /auth/refresh succeeded but did not return a rotated refresh cookie; refusing to leave the stored admin refresh token stale."
      );
    }
    if (rotatedRefreshToken !== credential.refreshToken) {
      await writeSecretImpl(credential.writeBackRef, rotatedRefreshToken);
    }
  }

  return {
    accessToken,
    expiresAt: payload?.expiresAt ?? null,
    wallet: payload?.wallet ?? null,
    roles: Array.isArray(payload?.roles) ? payload.roles : [],
    credentialSource: credential.source,
    writeBackRef: credential.writeBackRef ?? null,
    rotatedRefreshTokenPersisted: Boolean(credential.writeBackRef && rotatedRefreshToken)
  };
}

export async function resolveRefreshCredential({ env = process.env, readSecretImpl = readOpSecret } = {}) {
  const rawToken = stringOrEmpty(env.ADMIN_REFRESH_TOKEN);
  if (rawToken) {
    return {
      refreshToken: rawToken,
      source: "ADMIN_REFRESH_TOKEN",
      writeBackRef: null
    };
  }

  const configured = stringOrEmpty(env.ADMIN_REFRESH_TOKEN_OP) || DEFAULT_ADMIN_REFRESH_TOKEN_OP;
  if (configured.startsWith("op://")) {
    const refreshToken = await readSecretImpl(configured);
    if (!stringOrEmpty(refreshToken)) {
      throw new Error(`Admin refresh token at ${configured} is empty.`);
    }
    return {
      refreshToken: refreshToken.trim(),
      source: configured,
      writeBackRef: writeBackEnabled(env) ? configured : null
    };
  }

  return {
    refreshToken: configured,
    source: "ADMIN_REFRESH_TOKEN_OP",
    writeBackRef: null
  };
}

export async function readOpSecret(opRef) {
  const { stdout } = await execFileAsync("op", ["read", opRef], { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function writeOpSecret(opRef, value) {
  const { vault, item, field } = parseOpRef(opRef);
  await execFileAsync("op", ["item", "edit", item, "--vault", vault, `${field}=${value}`], {
    maxBuffer: 1024 * 1024
  });
}

export function parseOpRef(opRef) {
  const parts = String(opRef ?? "").replace(/^op:\/\//u, "").split("/");
  if (!String(opRef ?? "").startsWith("op://") || parts.length < 3 || parts.some((part) => part.trim() === "")) {
    throw new Error(`Invalid 1Password reference: ${opRef}`);
  }
  const [vault, item, ...fieldParts] = parts;
  return {
    vault,
    item,
    field: fieldParts.join("/")
  };
}

export function extractRefreshCookie(headers) {
  for (const header of getSetCookieHeaders(headers)) {
    const match = String(header).match(new RegExp(`(?:^|[,;]\\s*)${REFRESH_COOKIE_NAME}=([^;,\\s]+)`, "u"));
    if (match?.[1]) return match[1];
  }
  return null;
}

function getSetCookieHeaders(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  if (typeof headers.get === "function") {
    const value = headers.get("set-cookie");
    return value ? [value] : [];
  }
  return [];
}

function buildRefreshHttpError({ response, payload }) {
  const code = payload?.error ?? payload?.code ?? `http_${response.status}`;
  const message = payload?.message ?? `POST /auth/refresh failed with HTTP ${response.status}`;
  const requestId = payload?.requestId ? `; requestId=${payload.requestId}` : "";
  const error = new Error(
    `Admin refresh token rejected by POST /auth/refresh: ${code} (HTTP ${response.status}): ${message}${requestId}`
  );
  error.name = "AdminRefreshTokenError";
  error.status = response.status;
  error.code = code;
  error.payload = payload;
  error.details = payload?.details;
  return error;
}

function writeBackEnabled(env) {
  return !["0", "false", "no"].includes(String(env.ADMIN_REFRESH_TOKEN_WRITE_BACK ?? "1").trim().toLowerCase());
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/u, "");
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const env = {};
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--api-base-url") {
      env.API_BASE_URL = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--refresh-token-op") {
      env.ADMIN_REFRESH_TOKEN_OP = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--refresh-token") {
      env.ADMIN_REFRESH_TOKEN = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--no-write-back") {
      env.ADMIN_REFRESH_TOKEN_WRITE_BACK = "0";
    } else if (arg === "-h" || arg === "--help") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { env, help };
}

function usage() {
  return `Usage: node scripts/ops/get-admin-refresh-token.mjs [--api-base-url URL] [--refresh-token-op OP_REF] [--refresh-token TOKEN] [--no-write-back]

Exchanges the hosted-smoke admin refresh cookie for a fresh short-lived access
token via POST /auth/refresh. The access token is printed to stdout.

Default refresh-token source: ${DEFAULT_ADMIN_REFRESH_TOKEN_OP}
Successful refreshes write the rotated refresh cookie back to the same
1Password item unless --no-write-back is set.
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(usage());
      return;
    }
    const result = await getAdminRefreshToken({
      env: {
        ...process.env,
        ...parsed.env
      }
    });
    console.log(result.accessToken);
  })().catch((error) => {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
