import { ConfigError } from "../core/errors.js";

const VALID_MODES = new Set(["strict", "permissive"]);

/**
 * Load authentication configuration from the environment.
 *
 * Environment variables:
 * - AUTH_MODE: "strict" (default in production) or "permissive" (accept legacy ?wallet=).
 * - AUTH_JWT_SECRETS: comma-separated list; first is used for signing, all are accepted for verification.
 *   AUTH_JWT_SECRET (singular) is accepted as a convenience alias.
 * - AUTH_DOMAIN: expected domain in SIWE messages (e.g., "averray.io" or "localhost:8787").
 * - AUTH_CHAIN_ID: expected EVM chain id (number).
 * - AUTH_TOKEN_TTL_SECONDS: JWT lifetime (default 86400 = 24h).
 * - AUTH_NONCE_TTL_SECONDS: nonce lifetime (default 300 = 5 min).
 */
export function loadAuthConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  const rawMode = (env.AUTH_MODE ?? (nodeEnv === "production" ? "strict" : "permissive")).trim().toLowerCase();

  if (!VALID_MODES.has(rawMode)) {
    throw new ConfigError(`Invalid AUTH_MODE: ${rawMode}. Expected "strict" or "permissive".`);
  }

  const secretsRaw = env.AUTH_JWT_SECRETS ?? env.AUTH_JWT_SECRET ?? "";
  const secrets = secretsRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (rawMode === "strict" && secrets.length === 0) {
    throw new ConfigError(
      "AUTH_MODE=strict requires AUTH_JWT_SECRETS (or AUTH_JWT_SECRET). Set at least one secret with >=32 chars."
    );
  }

  for (const secret of secrets) {
    if (secret.length < 32) {
      throw new ConfigError(
        "AUTH_JWT_SECRETS entries must each be at least 32 characters (high-entropy recommended)."
      );
    }
  }

  const domain = (env.AUTH_DOMAIN ?? "localhost").trim();
  if (!domain) {
    throw new ConfigError("AUTH_DOMAIN must not be empty.");
  }

  const chainIdRaw = env.AUTH_CHAIN_ID ?? "0";
  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId < 0) {
    throw new ConfigError(`AUTH_CHAIN_ID must be a non-negative integer, got: ${chainIdRaw}.`);
  }

  const tokenTtlSeconds = parsePositiveInt(env.AUTH_TOKEN_TTL_SECONDS, 86400, "AUTH_TOKEN_TTL_SECONDS");
  const nonceTtlSeconds = parsePositiveInt(env.AUTH_NONCE_TTL_SECONDS, 300, "AUTH_NONCE_TTL_SECONDS");

  return {
    mode: rawMode,
    secrets,
    signingSecret: secrets[0],
    domain,
    chainId,
    tokenTtlSeconds,
    nonceTtlSeconds,
    permissive: rawMode === "permissive",
    strict: rawMode === "strict"
  };
}

function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got: ${raw}.`);
  }
  return value;
}
