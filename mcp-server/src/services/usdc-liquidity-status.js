import { getAddress } from "ethers";

import { ConfigError, ExternalServiceError } from "../core/errors.js";

const USDC_SCALE = 1_000_000n;
const DEFAULT_CHAIN = "testnet";
const DEFAULT_ASSET = "USDC";
const VALID_ROLES = new Set(["poster", "worker"]);

function parseJsonArray(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${label} must be valid JSON.`, { cause: error.message });
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError(`${label} must decode to an array.`);
  }
  return parsed;
}

function normalizeAddress(raw, label) {
  try {
    return getAddress(raw);
  } catch {
    throw new ConfigError(`${label} must be a valid EVM address.`);
  }
}

function normalizeRole(raw, idx) {
  if (typeof raw !== "string" || !VALID_ROLES.has(raw)) {
    throw new ConfigError(`USDC_LIQUIDITY_ACCOUNTS_JSON[${idx}].role must be "poster" or "worker".`);
  }
  return raw;
}

function normalizeOptionalIso(raw, label) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    throw new ConfigError(`${label} must be an ISO timestamp when set.`);
  }
  return raw;
}

function normalizeBoolean(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return Boolean(raw);
}

export function parseUsdcAmountToRaw(value, label) {
  if (value === undefined || value === null || value === "") {
    throw new ConfigError(`${label} is required.`);
  }
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^\d+(\.\d{1,6})?$/u.test(text)) {
    throw new ConfigError(`${label} must be a non-negative USDC decimal with at most 6 fractional digits.`);
  }
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(6, "0"));
}

export function formatUsdcRaw(raw) {
  const value = BigInt(raw ?? 0n);
  const whole = value / USDC_SCALE;
  const fraction = value % USDC_SCALE;
  const fractionText = fraction.toString().padStart(6, "0").replace(/0+$/u, "");
  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

function rawToNumber(raw) {
  return Number(formatUsdcRaw(raw));
}

function normalizeAccountEntry(entry, idx) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new ConfigError(`USDC_LIQUIDITY_ACCOUNTS_JSON[${idx}] must be an object.`);
  }
  const floorRaw = parseUsdcAmountToRaw(entry.floorUsdc, `USDC_LIQUIDITY_ACCOUNTS_JSON[${idx}].floorUsdc`);
  const targetRaw = parseUsdcAmountToRaw(entry.targetUsdc, `USDC_LIQUIDITY_ACCOUNTS_JSON[${idx}].targetUsdc`);
  if (targetRaw < floorRaw) {
    throw new ConfigError(`USDC_LIQUIDITY_ACCOUNTS_JSON[${idx}].targetUsdc must be >= floorUsdc.`);
  }
  return {
    role: normalizeRole(entry.role, idx),
    account: normalizeAddress(entry.account, `USDC_LIQUIDITY_ACCOUNTS_JSON[${idx}].account`),
    floorRaw,
    targetRaw,
    refillPending: normalizeBoolean(entry.refillPending, false),
    lastRefillAt: normalizeOptionalIso(entry.lastRefillAt, `USDC_LIQUIDITY_ACCOUNTS_JSON[${idx}].lastRefillAt`)
  };
}

export function loadUsdcLiquidityConfig(env = process.env) {
  const accounts = parseJsonArray(env.USDC_LIQUIDITY_ACCOUNTS_JSON, "USDC_LIQUIDITY_ACCOUNTS_JSON")
    .map(normalizeAccountEntry);
  const reserveAccountRaw = env.USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT === undefined
    || env.USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT === null
    ? ""
    : String(env.USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT).trim();
  const reserveFloorRawInput = env.USDC_LIQUIDITY_TREASURY_RESERVE_FLOOR_USDC === undefined
    || env.USDC_LIQUIDITY_TREASURY_RESERVE_FLOOR_USDC === null
    ? ""
    : String(env.USDC_LIQUIDITY_TREASURY_RESERVE_FLOOR_USDC).trim();
  const reserveAccount = reserveAccountRaw
    ? normalizeAddress(env.USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT, "USDC_LIQUIDITY_TREASURY_RESERVE_ACCOUNT")
    : undefined;
  const reserveFloorRaw = reserveFloorRawInput
    ? parseUsdcAmountToRaw(reserveFloorRawInput, "USDC_LIQUIDITY_TREASURY_RESERVE_FLOOR_USDC")
    : 0n;
  return {
    chain: env.USDC_LIQUIDITY_CHAIN?.trim() || DEFAULT_CHAIN,
    asset: env.USDC_LIQUIDITY_ASSET?.trim() || DEFAULT_ASSET,
    accounts,
    treasuryReserve: {
      account: reserveAccount,
      floorRaw: reserveFloorRaw
    }
  };
}

function extractLiquidRaw(position) {
  if (position === undefined || position === null) {
    return 0n;
  }
  if (typeof position === "bigint" || typeof position === "number" || typeof position === "string") {
    return BigInt(position);
  }
  return BigInt(
    position.liquidRaw
      ?? position.liquid
      ?? position.position?.liquidRaw
      ?? position.position?.liquid
      ?? position[0]
      ?? 0n
  );
}

export async function buildUsdcLiquidityStatus({
  config,
  readLiquidRaw,
  now = () => new Date()
}) {
  const accountRows = [];
  let totalDesiredRaw = 0n;

  for (const accountConfig of config.accounts) {
    const liquidRaw = extractLiquidRaw(await readLiquidRaw(accountConfig.account));
    const desiredRaw = accountConfig.targetRaw > liquidRaw ? accountConfig.targetRaw - liquidRaw : 0n;
    totalDesiredRaw += desiredRaw;
    accountRows.push({
      role: accountConfig.role,
      account: accountConfig.account,
      liquidUsdc: rawToNumber(liquidRaw),
      liquidUsdcRaw: liquidRaw.toString(),
      floorUsdc: rawToNumber(accountConfig.floorRaw),
      floorUsdcRaw: accountConfig.floorRaw.toString(),
      targetUsdc: rawToNumber(accountConfig.targetRaw),
      targetUsdcRaw: accountConfig.targetRaw.toString(),
      desiredUsdc: rawToNumber(desiredRaw),
      desiredUsdcRaw: desiredRaw.toString(),
      refillPending: accountConfig.refillPending,
      lastRefillAt: accountConfig.lastRefillAt
    });
  }

  const reserveAccount = config.treasuryReserve?.account;
  const treasuryReserveRaw = reserveAccount
    ? extractLiquidRaw(await readLiquidRaw(reserveAccount))
    : 0n;
  const treasuryFloorRaw = BigInt(config.treasuryReserve?.floorRaw ?? 0n);
  const treasuryReserveHealthy = Boolean(
    reserveAccount
      && treasuryReserveRaw >= treasuryFloorRaw
      && treasuryReserveRaw >= totalDesiredRaw
  );

  return {
    asOf: now().toISOString(),
    chain: config.chain,
    accounts: accountRows,
    treasuryReserveHealthy,
    treasuryReserveUsdc: rawToNumber(treasuryReserveRaw),
    treasuryReserveUsdcRaw: treasuryReserveRaw.toString(),
    treasuryReserveAccount: reserveAccount,
    treasuryReserveFloorUsdc: rawToNumber(treasuryFloorRaw),
    treasuryReserveFloorUsdcRaw: treasuryFloorRaw.toString(),
    totalDesiredUsdc: rawToNumber(totalDesiredRaw),
    totalDesiredUsdcRaw: totalDesiredRaw.toString()
  };
}

export function createUsdcLiquidityStatusService({
  gateway,
  config = loadUsdcLiquidityConfig(process.env),
  now = () => new Date()
} = {}) {
  return {
    async getStatus() {
      if (!gateway?.isEnabled?.()) {
        throw new ExternalServiceError(
          "USDC liquidity status requires an enabled blockchain gateway.",
          "chain_backend_unavailable"
        );
      }
      return buildUsdcLiquidityStatus({
        config,
        now,
        readLiquidRaw: async (account) => {
          const position = await gateway.getAccountPosition(account, config.asset);
          return position?.position?.liquidRaw;
        }
      });
    }
  };
}
