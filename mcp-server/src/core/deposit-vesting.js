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
  vestingHours = DEFAULT_WORKER_DEPOSIT_VESTING_HOURS,
  creditEvents = [],
  initialTranches = []
} = {}) {
  const evaluatedAt = asDate(now, "deposit vesting clock");
  const durationMs = BigInt(positiveIntegerConfig(
    vestingHours,
    DEFAULT_WORKER_DEPOSIT_VESTING_HOURS,
    "deposit vesting hours"
  )) * BigInt(HOUR_MS);
  const normalizedWallet = wallet ? String(wallet).toLowerCase() : undefined;
  const debtPeriods = creditDebtPeriods(creditEvents, normalizedWallet);
  const tranches = initialTranches.map((tranche, index) => {
    const depositedRaw = nonNegativeRaw(tranche.depositedRaw, `initial tranche ${index} deposited assets`);
    const remainingRaw = nonNegativeRaw(tranche.remainingRaw, `initial tranche ${index} remaining assets`);
    if (remainingRaw > depositedRaw) throw new ConfigError(`initial tranche ${index} remaining assets exceed deposited assets.`);
    const depositedAtMs = asDate(tranche.depositedAt, `initial tranche ${index} depositedAt`).getTime();
    const vestingStartedAtMs = tranche.vestingStartedAt === null
      ? null
      : asDate(tranche.vestingStartedAt ?? tranche.depositedAt, `initial tranche ${index} vestingStartedAt`).getTime();
    return {
      depositedRaw,
      remainingRaw,
      depositedAtMs,
      vestingStartedAtMs,
      debtDelayed: Boolean(tranche.debtDelayed),
      blockNumber: safeInteger(tranche.blockNumber, `initial tranche ${index} block number`),
      logIndex: safeInteger(tranche.logIndex, `initial tranche ${index} log index`),
      ...(tranche.txHash ? { txHash: String(tranche.txHash) } : {})
    };
  });

  for (const event of [...events].sort(compareEvents)) {
    if (!event || (event.type !== "Deposit" && event.type !== "Withdraw")) continue;
    if (normalizedWallet && String(event.owner ?? "").toLowerCase() !== normalizedWallet) continue;
    const assetsRaw = nonNegativeRaw(event.assetsRaw, `${event.type} assets`);
    if (assetsRaw === 0n) continue;

    if (event.type === "Deposit") {
      const depositedAtMs = eventTimestampMs(event);
      const delayedUntilMs = debtClearanceForDeposit(debtPeriods, depositedAtMs);
      tranches.push({
        depositedRaw: assetsRaw,
        remainingRaw: assetsRaw,
        depositedAtMs,
        vestingStartedAtMs: delayedUntilMs === undefined ? depositedAtMs : delayedUntilMs,
        debtDelayed: delayedUntilMs !== undefined,
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
    const ageMs = tranche.vestingStartedAtMs === null
      ? 0n
      : BigInt(Math.max(0, evaluatedAt.getTime() - tranche.vestingStartedAtMs));
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
      vestingStartedAt: tranche.vestingStartedAtMs === null
        ? null
        : new Date(tranche.vestingStartedAtMs).toISOString(),
      debtDelayed: tranche.debtDelayed,
      blockNumber: tranche.blockNumber,
      logIndex: tranche.logIndex,
      ...(tranche.txHash ? { txHash: tranche.txHash } : {})
    }))
  };
}

function creditDebtPeriods(events, wallet) {
  if (!wallet) return [];
  const byLoan = new Map();
  for (const event of [...events].sort(compareEvents)) {
    if (!event) continue;
    const loanId = String(event.loanId ?? "").toLowerCase();
    if (!loanId) continue;
    if (event.type === "LoanOriginated") {
      if (String(event.borrower ?? "").toLowerCase() !== wallet) continue;
      byLoan.set(loanId, { openedAtMs: eventTimestampMs(event), closedAtMs: null });
    } else if (event.type === "LoanClosed" && byLoan.has(loanId)) {
      byLoan.get(loanId).closedAtMs = eventTimestampMs(event);
    }
  }
  return [...byLoan.values()];
}

function debtClearanceForDeposit(periods, depositedAtMs) {
  const active = periods.filter((period) => (
    period.openedAtMs <= depositedAtMs
      && (period.closedAtMs === null || period.closedAtMs >= depositedAtMs)
  ));
  if (active.length === 0) return undefined;
  if (active.some((period) => period.closedAtMs === null)) return null;
  return Math.max(...active.map((period) => period.closedAtMs));
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
