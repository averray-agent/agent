import { formatUnits, getAddress, keccak256, toUtf8Bytes } from "ethers";

import { ConfigError, ValidationError } from "../core/errors.js";

export const FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI = 30_000_000_000_000_000n;
export const FIRST_WITHDRAWAL_GAS_GRANT_MIN_LIQUID_RAW = 250_000n;
export const DEFAULT_FIRST_WITHDRAWAL_GAS_GRANT_DAILY_CAP = 25;

const LIFETIME_BUCKET = "first-withdrawal-gas-grant-lifetime";
const DAILY_SCOPE = "first-withdrawal-gas-grant-daily";
const EVENT_TOPIC = "operator_gas.first_withdrawal_granted";
const LOCK_TTL_SECONDS = 90;

function amount(raw, decimals, symbol) {
  const value = BigInt(raw ?? 0);
  return {
    raw: value.toString(),
    decimals,
    display: formatUnits(value, decimals),
    symbol
  };
}

function walletKey(value) {
  return getAddress(value).toLowerCase();
}

function exactPositiveRaw(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new ValidationError(`${field} must be a positive exact base-unit integer string.`, {
      reason: "first_withdrawal_gas_grant_withdrawal_intent_required",
      field
    });
  }
  return BigInt(normalized);
}

function exactNonNegativeRaw(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^[0-9]+$/u.test(normalized)) {
    throw new ValidationError(`${field} must be an exact base-unit integer string.`, {
      reason: "first_withdrawal_gas_grant_withdrawal_intent_required",
      field
    });
  }
  return BigInt(normalized);
}

function withdrawalIntent(value) {
  if (!value || typeof value !== "object") {
    throw new ValidationError("A live wallet-bound withdrawal intent is required for a gas grant.", {
      reason: "first_withdrawal_gas_grant_withdrawal_intent_required"
    });
  }
  let wallet;
  let assetAddress;
  let destination;
  try {
    wallet = getAddress(value.wallet);
    assetAddress = getAddress(value.assetAddress);
    destination = getAddress(value.destination);
  } catch {
    throw new ValidationError("A live wallet-bound withdrawal intent is required for a gas grant.", {
      reason: "first_withdrawal_gas_grant_withdrawal_intent_required"
    });
  }
  const assetSymbol = String(value.assetSymbol ?? "").trim().toUpperCase();
  const amountRaw = exactPositiveRaw(value.amountRaw, "withdrawal intent amountRaw");
  const liveLiquidRaw = exactNonNegativeRaw(value.liveLiquidRaw, "withdrawal intent liveLiquidRaw");
  if (assetSymbol !== "USDC" || amountRaw > liveLiquidRaw) {
    throw new ValidationError("The gas grant intent must reference a live, affordable USDC withdrawal.", {
      reason: "first_withdrawal_gas_grant_withdrawal_intent_required",
      assetSymbol,
      amountRaw: amountRaw.toString(),
      liveLiquidRaw: liveLiquidRaw.toString()
    });
  }
  const normalized = {
    wallet,
    assetSymbol,
    assetAddress,
    amountRaw: amountRaw.toString(),
    destination,
    liveLiquidRaw: liveLiquidRaw.toString()
  };
  return {
    ...normalized,
    hash: keccak256(toUtf8Bytes(JSON.stringify([
      normalized.wallet.toLowerCase(),
      normalized.assetSymbol,
      normalized.assetAddress.toLowerCase(),
      normalized.amountRaw,
      normalized.destination.toLowerCase(),
      normalized.liveLiquidRaw
    ])))
  };
}

function blocksLifetimeGrant(receipt) {
  return ["sending", "granted"].includes(String(receipt?.status ?? ""));
}

function secondsUntilTomorrow(now) {
  const reset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  ));
  return Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1_000));
}

function parseDailyCap(raw) {
  const value = raw === undefined || raw === null || String(raw).trim() === ""
    ? DEFAULT_FIRST_WITHDRAWAL_GAS_GRANT_DAILY_CAP
    : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError("FIRST_WITHDRAWAL_GAS_GRANT_DAILY_CAP must be a positive integer.");
  }
  return value;
}

export function loadFirstWithdrawalGasGrantConfig(env = process.env) {
  return { dailyCap: parseDailyCap(env.FIRST_WITHDRAWAL_GAS_GRANT_DAILY_CAP) };
}

export class FirstWithdrawalGasGrantService {
  constructor({
    gateway,
    stateStore,
    eventBus,
    dailyCap = DEFAULT_FIRST_WITHDRAWAL_GAS_GRANT_DAILY_CAP,
    now = () => new Date()
  } = {}) {
    const requiredStoreMethods = [
      "acquireClaimLock",
      "releaseClaimLock",
      "getMutationReceipt",
      "upsertMutationReceipt",
      "getDailyBudgetUsage",
      "reserveDailyBudget",
      "listEventLog"
    ];
    const missing = requiredStoreMethods.filter((method) => typeof stateStore?.[method] !== "function");
    if (missing.length > 0) {
      throw new ConfigError("First-withdrawal gas grants require durable locking, receipts, budgets, and event storage.", { missing });
    }
    if (
      typeof gateway?.getAccountPosition !== "function"
      || typeof gateway?.sendFirstWithdrawalGasGrant !== "function"
    ) {
      throw new ConfigError("First-withdrawal gas grants require the chain-backed account reader and KMS native-transfer path.");
    }
    this.gateway = gateway;
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.dailyCap = parseDailyCap(dailyCap);
    this.now = now;
  }

  async inspect({ wallet, liquidRaw, assetSymbol = "USDC", assetDecimals = 6 } = {}) {
    const owner = getAddress(wallet);
    const raw = BigInt(liquidRaw ?? 0);
    const existing = await this.stateStore.getMutationReceipt(LIFETIME_BUCKET, walletKey(owner));
    const daily = await this.#dailyStatus();
    const base = {
      offer: "Your first withdrawal's network fee is on us.",
      amount: amount(FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI, 18, "DOT"),
      minimumAccountLiquid: amount(FIRST_WITHDRAWAL_GAS_GRANT_MIN_LIQUID_RAW, 6, "USDC"),
      balance: amount(raw, assetDecimals, assetSymbol),
      daily,
      intentBound: true,
      standingFaucet: false
    };
    if (blocksLifetimeGrant(existing)) {
      return {
        ...base,
        eligible: false,
        reason: existing.status === "sending"
          ? "first_withdrawal_gas_grant_in_progress"
          : "first_withdrawal_gas_grant_already_granted",
        priorGrant: priorGrant(existing)
      };
    }
    if (assetSymbol !== "USDC") {
      return { ...base, eligible: false, reason: "first_withdrawal_gas_grant_usdc_only" };
    }
    if (raw < FIRST_WITHDRAWAL_GAS_GRANT_MIN_LIQUID_RAW) {
      return { ...base, eligible: false, reason: "first_withdrawal_gas_grant_balance_below_floor" };
    }
    if (daily.reserved >= daily.limit) {
      return { ...base, eligible: false, reason: "first_withdrawal_gas_grant_daily_cap_reached" };
    }
    return { ...base, eligible: true, reason: "first_withdrawal_gas_grant_available" };
  }

  async grantForWithdrawalIntent(value) {
    const intent = withdrawalIntent(value);
    const owner = intent.wallet;
    const key = walletKey(owner);
    const lockId = `${LIFETIME_BUCKET}:${key}`;
    const lockOwner = intent.hash;
    const acquired = await this.stateStore.acquireClaimLock(lockId, lockOwner, LOCK_TTL_SECONDS);
    if (!acquired) {
      const status = await this.inspect({ wallet: owner, liquidRaw: intent.liveLiquidRaw });
      return {
        ...status,
        status: "ineligible",
        reason: "first_withdrawal_gas_grant_in_progress"
      };
    }

    try {
      const lifetimeKey = key;
      const existing = await this.stateStore.getMutationReceipt(LIFETIME_BUCKET, lifetimeKey);
      if (blocksLifetimeGrant(existing)) {
        const status = await this.inspect({ wallet: owner, liquidRaw: intent.liveLiquidRaw });
        return {
          ...status,
          status: "ineligible",
          reason: existing.status === "sending"
            ? "first_withdrawal_gas_grant_in_progress"
            : "first_withdrawal_gas_grant_already_granted",
          priorGrant: priorGrant(existing)
        };
      }

      const proof = await this.gateway.getAccountPosition(owner, intent.assetSymbol);
      const liveLiquid = BigInt(proof?.position?.liquidRaw ?? 0);
      const inspection = await this.inspect({
        wallet: owner,
        liquidRaw: liveLiquid,
        assetSymbol: String(proof?.asset?.symbol ?? intent.assetSymbol).toUpperCase(),
        assetDecimals: Number(proof?.asset?.decimals ?? 6)
      });
      if (!inspection.eligible) {
        return { ...inspection, status: "ineligible", balanceAtGrant: inspection.balance };
      }
      if (
        getAddress(proof.asset.address) !== intent.assetAddress
        || BigInt(intent.amountRaw) > liveLiquid
      ) {
        throw new ValidationError("The withdrawal intent no longer matches this wallet's live account balance.", {
          reason: "first_withdrawal_gas_grant_withdrawal_intent_stale",
          intent,
          liveLiquidRaw: liveLiquid.toString()
        });
      }

      const window = this.#window();
      const reservation = await this.stateStore.reserveDailyBudget(DAILY_SCOPE, window.day, {
        reservationId: key,
        amountUnits: 1,
        limitUnits: this.dailyCap,
        ttlSeconds: window.secondsUntilReset + 86_400
      });
      if (!reservation.accepted) {
        return {
          ...inspection,
          eligible: false,
          status: "ineligible",
          reason: "first_withdrawal_gas_grant_daily_cap_reached",
          balanceAtGrant: inspection.balance,
          daily: await this.#dailyStatus(reservation.usedUnits)
        };
      }

      const startedAt = this.#now().toISOString();
      const sending = {
        status: "sending",
        wallet: owner,
        intent,
        amountRaw: FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI.toString(),
        balanceAtGrantRaw: liveLiquid.toString(),
        startedAt
      };
      await this.stateStore.upsertMutationReceipt(LIFETIME_BUCKET, key, sending);

      let transfer;
      try {
        transfer = await this.gateway.sendFirstWithdrawalGasGrant(
          owner,
          FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI
        );
      } catch (error) {
        // The signer path may have broadcast before a provider error surfaced.
        // Preserve the pre-send `sending` tombstone so an identical retry can
        // never risk paying twice. Operators can reconcile it by tx evidence.
        await this.stateStore.upsertMutationReceipt(LIFETIME_BUCKET, key, {
          ...sending,
          lastAttemptFailedAt: this.#now().toISOString(),
          lastError: error?.message ?? String(error),
          transferOutcome: "unknown_fail_closed"
        });
        throw error;
      }
      // From this point the external side effect succeeded. If a subsequent
      // durable write is unavailable, leave the prior `sending` tombstone in
      // place: retries then fail closed instead of risking a second grant.
      const grantedAt = this.#now().toISOString();
      const receipt = {
        ...sending,
        status: "granted",
        grantedAt,
        txHash: transfer.txHash,
        blockNumber: Number(transfer.blockNumber),
        transactionStatus: Number(transfer.status),
        walletBalanceBeforeRaw: String(transfer.walletBalanceBeforeRaw),
        walletBalanceAfterRaw: transfer.walletBalanceAfterRaw == null
          ? null
          : String(transfer.walletBalanceAfterRaw),
        walletBalanceDeltaRaw: transfer.walletBalanceDeltaRaw == null
          ? null
          : String(transfer.walletBalanceDeltaRaw),
        balanceReadError: transfer.balanceReadError ?? null,
        balanceDeltaVerified: transfer.balanceDeltaVerified === true
      };
      await this.stateStore.upsertMutationReceipt(LIFETIME_BUCKET, key, receipt);
      this.eventBus?.publish?.({
        topic: EVENT_TOPIC,
        source: "operator_gas",
        phase: "outflow",
        severity: "info",
        wallet: owner,
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber,
        timestamp: grantedAt,
        data: {
          category: "first_withdrawal_gas_grant",
          wallet: owner,
          amount: amount(FIRST_WITHDRAWAL_GAS_GRANT_AMOUNT_WEI, 18, "DOT"),
          balanceAtGrant: amount(liveLiquid, 6, "USDC"),
          intentHash: intent.hash,
          countedAsPayout: false,
          countedAsRevenue: false
        }
      });
      await this.eventBus?.flush?.();
      return {
        ...inspection,
        eligible: false,
        status: "granted",
        reason: "first_withdrawal_gas_grant_sent",
        balanceAtGrant: amount(liveLiquid, 6, "USDC"),
        walletBalanceBefore: amount(receipt.walletBalanceBeforeRaw, 18, "DOT"),
        walletBalanceAfter: receipt.walletBalanceAfterRaw == null
          ? null
          : amount(receipt.walletBalanceAfterRaw, 18, "DOT"),
        walletBalanceDelta: receipt.walletBalanceDeltaRaw == null
          ? null
          : amount(receipt.walletBalanceDeltaRaw, 18, "DOT"),
        balanceReadError: receipt.balanceReadError,
        balanceDeltaVerified: receipt.balanceDeltaVerified,
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber,
        intent: { ...intent, liveLiquidRaw: liveLiquid.toString() },
        daily: await this.#dailyStatus()
      };
    } finally {
      await this.stateStore.releaseClaimLock(lockId, lockOwner);
    }
  }

  async getOpsStatus() {
    const daily = await this.#dailyStatus();
    const stored = await this.stateStore.listEventLog({ topics: [EVENT_TOPIC], limit: 100 });
    const events = (stored?.events ?? [])
      .filter((event) => String(event.timestamp ?? "").startsWith(daily.day))
      .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
    const totalRaw = events.reduce(
      (sum, event) => sum + BigInt(event?.data?.amount?.raw ?? 0),
      0n
    );
    return {
      schemaVersion: 1,
      category: "operator_gas_outflow",
      countedAsPayout: false,
      countedAsRevenue: false,
      daily: {
        ...daily,
        granted: events.length,
        total: amount(totalRaw, 18, "DOT")
      },
      recent: events.slice(0, 25).map((event) => ({
        wallet: event.wallet,
        amount: event.data.amount,
        balanceAtGrant: event.data.balanceAtGrant,
        txHash: event.txHash,
        blockNumber: event.blockNumber,
        grantedAt: event.timestamp,
        countedAsPayout: false,
        countedAsRevenue: false
      }))
    };
  }

  #now() {
    const value = new Date(this.now());
    if (!Number.isFinite(value.getTime())) throw new ConfigError("First-withdrawal gas grant clock is invalid.");
    return value;
  }

  #window() {
    const now = this.#now();
    return {
      day: now.toISOString().slice(0, 10),
      resetAt: new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
      )).toISOString(),
      secondsUntilReset: secondsUntilTomorrow(now)
    };
  }

  async #dailyStatus(usedOverride = undefined) {
    const window = this.#window();
    const usage = usedOverride === undefined
      ? await this.stateStore.getDailyBudgetUsage(DAILY_SCOPE, window.day)
      : { usedUnits: usedOverride };
    const reserved = Math.max(0, Number(usage.usedUnits) || 0);
    return {
      day: window.day,
      clock: "UTC",
      resetAt: window.resetAt,
      limit: this.dailyCap,
      reserved,
      remaining: Math.max(this.dailyCap - reserved, 0),
      source: "durable_state_store_daily_budget"
    };
  }
}

function priorGrant(receipt) {
  return {
    status: receipt?.status,
    txHash: receipt?.txHash ?? null,
    blockNumber: receipt?.blockNumber ?? null,
    grantedAt: receipt?.grantedAt ?? null
  };
}
