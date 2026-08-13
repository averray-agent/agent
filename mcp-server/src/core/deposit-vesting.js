import { ConfigError } from "./errors.js";

export const DEFAULT_WORKER_DEPOSIT_VESTING_HOURS = 48;

const HOUR_MS = 60 * 60 * 1_000;

export function loadDepositVestingConfig(env = process.env) {
  return {
    vestingHours: positiveIntegerConfig(
      env.WORKER_DEPOSIT_VESTING_HOURS,
      DEFAULT_WORKER_DEPOSIT_VESTING_HOURS,
      "WORKER_DEPOSIT_VESTING_HOURS"
    )
  };
}

export function calculateDepositVesting(events = [], {
  wallet = undefined,
  now = new Date(),
  vestingHours = DEFAULT_WORKER_DEPOSIT_VESTING_HOURS
} = {}) {
  const evaluatedAt = asDate(now, "deposit vesting clock");
  const durationMs = BigInt(positiveIntegerConfig(
    vestingHours,
    DEFAULT_WORKER_DEPOSIT_VESTING_HOURS,
    "deposit vesting hours"
  )) * BigInt(HOUR_MS);
  const normalizedWallet = wallet ? String(wallet).toLowerCase() : undefined;
  const tranches = [];

  for (const event of [...events].sort(compareEvents)) {
    if (!event || (event.type !== "Deposit" && event.type !== "Withdraw")) continue;
    if (normalizedWallet && String(event.owner ?? "").toLowerCase() !== normalizedWallet) continue;
    const assetsRaw = nonNegativeRaw(event.assetsRaw, `${event.type} assets`);
    if (assetsRaw === 0n) continue;

    if (event.type === "Deposit") {
      tranches.push({
        depositedRaw: assetsRaw,
        remainingRaw: assetsRaw,
        depositedAtMs: eventTimestampMs(event),
        blockNumber: safeInteger(event.blockNumber, "deposit block number"),
        logIndex: safeInteger(event.logIndex, "deposit log index"),
        ...(event.txHash ? { txHash: String(event.txHash) } : {})
      });
      continue;
    }

    let remainingBurn = assetsRaw;
    for (let index = tranches.length - 1; index >= 0 && remainingBurn > 0n; index -= 1) {
      const tranche = tranches[index];
      const burned = remainingBurn < tranche.remainingRaw ? remainingBurn : tranche.remainingRaw;
      tranche.remainingRaw -= burned;
      remainingBurn -= burned;
    }
  }

  const liveTranches = tranches.filter((tranche) => tranche.remainingRaw > 0n);
  let vestedRaw = 0n;
  let principalRaw = 0n;
  for (const tranche of liveTranches) {
    const ageMs = BigInt(Math.max(0, evaluatedAt.getTime() - tranche.depositedAtMs));
    const vestedForTranche = ageMs >= durationMs
      ? tranche.remainingRaw
      : tranche.remainingRaw * ageMs / durationMs;
    tranche.vestedRaw = vestedForTranche;
    vestedRaw += vestedForTranche;
    principalRaw += tranche.remainingRaw;
  }

  return {
    vestedRaw,
    principalRaw,
    vestingHours: Number(durationMs / BigInt(HOUR_MS)),
    evaluatedAt: evaluatedAt.toISOString(),
    tranches: liveTranches.map((tranche) => ({
      depositedRaw: tranche.depositedRaw,
      remainingRaw: tranche.remainingRaw,
      vestedRaw: tranche.vestedRaw,
      depositedAt: new Date(tranche.depositedAtMs).toISOString(),
      blockNumber: tranche.blockNumber,
      logIndex: tranche.logIndex,
      ...(tranche.txHash ? { txHash: tranche.txHash } : {})
    }))
  };
}

function compareEvents(left, right) {
  return Number(left?.blockNumber ?? 0) - Number(right?.blockNumber ?? 0)
    || Number(left?.logIndex ?? 0) - Number(right?.logIndex ?? 0);
}

function eventTimestampMs(event) {
  if (event.blockTimestamp !== undefined && event.blockTimestamp !== null) {
    const seconds = Number(event.blockTimestamp);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1_000);
  }
  return asDate(event.timestamp, `${event.type} timestamp`).getTime();
}

function positiveIntegerConfig(value, fallback, field) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const number = Number(candidate);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ConfigError(`${field} must be a positive integer.`, { field, value: candidate });
  }
  return number;
}

function nonNegativeRaw(value, field) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) {
    throw new ConfigError(`${field} must be a non-negative raw-unit integer.`, { field, value });
  }
  return BigInt(text);
}

function safeInteger(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ConfigError(`${field} must be a safe non-negative integer.`, { field, value });
  }
  return number;
}

function asDate(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ConfigError(`${field} is not a valid timestamp.`);
  return date;
}
