import { Interface, getAddress } from "ethers";

import { DEPOSIT_POOL_ABI, ERC20_MOCK_ABI } from "../blockchain/abis.js";
import { ConflictError, ValidationError } from "../core/errors.js";
import { redactProviderError } from "../core/redact-provider-error.js";

const ASSET_DECIMALS = 6;
const SHARE_DECIMALS = 6;
const SHARE_PRICE_SCALE = 1_000_000n;
const DEFAULT_LOG_CHUNK_BLOCKS = 10_000;
const TRANSACTION_HASH = /^0x[a-fA-F0-9]{64}$/u;

export const YIELD_SUBSIDY_ATTESTATION =
  "Operator-attested. Each entry is independently verifiable by transaction hash. Hub USDC emits no Transfer logs, so the ledger cannot prove that every contribution is listed.";

const POOL_INTERFACE = new Interface(DEPOSIT_POOL_ABI);
const TOKEN_INTERFACE = new Interface(ERC20_MOCK_ABI);

function amount(raw, decimals = ASSET_DECIMALS) {
  return { raw: BigInt(raw).toString(), decimals };
}

function signedAmount(raw, decimals = ASSET_DECIMALS) {
  return { raw: BigInt(raw).toString(), decimals };
}

function normalizeTxHash(value) {
  const txHash = String(value ?? "").trim().toLowerCase();
  if (!TRANSACTION_HASH.test(txHash)) {
    throw new ValidationError("txHash must be a 0x-prefixed 32-byte transaction hash.", {
      field: "txHash"
    });
  }
  return txHash;
}

function exactBlockNumber(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative block number`);
  }
  return number;
}

function eventPosition(left, right) {
  return left.blockNumber - right.blockNumber || left.logIndex - right.logIndex;
}

function publicLedgerEntry(entry) {
  return {
    txHash: normalizeTxHash(entry.txHash),
    amount: amount(entry.amountRaw),
    timestamp: String(entry.timestamp),
    blockNumber: Number(entry.blockNumber),
    verification: {
      method: "transaction_hash",
      chainId: Number(entry.chainId)
    }
  };
}

function ledgerPayload(entries) {
  const ordered = [...entries].sort((left, right) => (
    Number(left.blockNumber) - Number(right.blockNumber)
      || String(left.txHash).localeCompare(String(right.txHash))
  ));
  const total = ordered.reduce((sum, entry) => sum + BigInt(entry.amountRaw), 0n);
  return {
    provenance: "operator_attested",
    attestation: YIELD_SUBSIDY_ATTESTATION,
    entryCount: ordered.length,
    total: amount(total),
    entries: ordered.map(publicLedgerEntry)
  };
}

function cumulativeCapital(events) {
  let deposits = 0n;
  let withdrawals = 0n;
  let operatorPrincipal = 0n;
  for (const event of events) {
    if (event.type === "Deposit") deposits += BigInt(event.assetsRaw);
    if (event.type === "Withdraw") withdrawals += BigInt(event.assetsRaw);
    if (event.type === "OperatorPrincipalContributed") {
      operatorPrincipal += BigInt(event.assetsRaw);
    }
  }
  return {
    deposits,
    withdrawals,
    operatorPrincipal,
    net: deposits + operatorPrincipal - withdrawals
  };
}

function splitRatio(totalGain, venueEarned, operatorAdded) {
  if (totalGain === 0n) {
    return { status: "not_applicable", reason: "zero_cumulative_nav_gain" };
  }
  return {
    status: "available",
    model: "pool_level_cumulative_nav_gain_ratio",
    denominator: "cumulative_nav_gain",
    // Floor-divide one side and derive the other, so the pair always sums to
    // exactly 10000. Independent floor division reads 9999 whenever the split
    // is inexact (e.g. 0.5/1.0 -> 3333 + 6666), and a reader WILL add these
    // two numbers on the one surface whose whole job is not inviting doubt.
    // The raw venueEarned/operatorAdded amounts remain the exact record.
    venueEarnedBps: (venueEarned * 10_000n / totalGain).toString(),
    operatorAddedBps: (10_000n - venueEarned * 10_000n / totalGain).toString()
  };
}

function walletAttribution({ wallet, liveShares, totalShares, markedAssets, events, ratio, operatorAdded, totalGain }) {
  let basisAssets = 0n;
  let basisShares = 0n;
  const normalizedWallet = getAddress(wallet);
  for (const event of events) {
    if (!event.owner || getAddress(event.owner) !== normalizedWallet) continue;
    const shares = BigInt(event.sharesRaw);
    if (event.type === "Deposit") {
      basisAssets += BigInt(event.assetsRaw);
      basisShares += shares;
      continue;
    }
    if (event.type !== "Withdraw") continue;
    if (shares > basisShares) {
      return {
        status: "unavailable",
        reason: "wallet_share_history_underflow",
        shares: amount(liveShares, SHARE_DECIMALS)
      };
    }
    const removedBasis = basisShares === 0n ? 0n : basisAssets * shares / basisShares;
    basisAssets -= removedBasis;
    basisShares -= shares;
  }

  if (basisShares !== liveShares) {
    return {
      status: "unavailable",
      reason: "wallet_share_history_does_not_match_live_balance",
      shares: amount(liveShares, SHARE_DECIMALS),
      eventDerivedShares: amount(basisShares, SHARE_DECIMALS)
    };
  }
  if (liveShares === 0n) {
    return {
      status: "no_position",
      shares: amount(0n, SHARE_DECIMALS),
      entryPrice: null,
      currentValue: amount(0n),
      gain: signedAmount(0n),
      splitApproximation: {
        status: "not_applicable",
        reason: "no_position"
      }
    };
  }

  const currentValue = totalShares === 0n ? 0n : liveShares * markedAssets / totalShares;
  const gain = currentValue - basisAssets;
  const entryPrice = basisAssets * SHARE_PRICE_SCALE / basisShares;
  let splitApproximation;
  if (ratio.status !== "available" || gain === 0n) {
    splitApproximation = {
      status: "not_applicable",
      reason: gain === 0n ? "zero_wallet_gain" : ratio.reason
    };
  } else {
    const operatorGain = gain * operatorAdded / totalGain;
    splitApproximation = {
      status: "approximation",
      model: "pool_level_cumulative_nav_gain_ratio",
      statement: "The wallet gain and entry price are wallet-specific. Its venue-versus-operator split applies the pool-level cumulative gain ratio and is an approximation, not a holding-period attribution.",
      poolRatio: ratio,
      venueEarned: signedAmount(gain - operatorGain),
      operatorAdded: signedAmount(operatorGain)
    };
  }
  return {
    status: "available",
    shares: amount(liveShares, SHARE_DECIMALS),
    entryPrice: {
      model: "weighted_average_entry_price",
      assetsPerShare: amount(entryPrice),
      basisAssets: amount(basisAssets),
      basisShares: amount(basisShares, SHARE_DECIMALS)
    },
    currentValue: amount(currentValue),
    gain: signedAmount(gain),
    splitApproximation
  };
}

/**
 * Pure attribution over one named-block pool snapshot, its complete pool event
 * history, and the operator-attested contribution list visible at that block.
 */
export function buildYieldAttribution({ snapshot, events = [], ledgerEntries = [], wallet = undefined }) {
  const blockNumber = exactBlockNumber(snapshot.blockNumber, "snapshot.blockNumber");
  const totalShares = BigInt(snapshot.totalSupply ?? snapshot.totalShares ?? 0);
  const bufferAssets = BigInt(snapshot.bufferAssets ?? snapshot.buffer ?? 0);
  const deployedPrincipal = BigInt(snapshot.deployedPrincipal ?? snapshot.deployed ?? 0);
  const venueMarkedAssets = snapshot.venueMarkedAssets === undefined || snapshot.venueMarkedAssets === null
    ? null
    : BigInt(snapshot.venueMarkedAssets);
  if (deployedPrincipal > 0n && venueMarkedAssets === null) {
    return {
      schemaVersion: 1,
      status: "unavailable",
      reason: "venue_mark_unreadable",
      subsidyLedger: ledgerPayload(ledgerEntries.filter((entry) => Number(entry.blockNumber) <= blockNumber))
    };
  }

  const boundedEvents = events
    .filter((event) => Number(event.blockNumber) <= blockNumber)
    .sort(eventPosition);
  const boundedEntries = ledgerEntries.filter((entry) => Number(entry.blockNumber) <= blockNumber);
  const ledger = ledgerPayload(boundedEntries);
  const capital = cumulativeCapital(boundedEvents);
  const markedAssets = bufferAssets + (deployedPrincipal > 0n ? venueMarkedAssets : 0n);
  const totalGain = markedAssets - capital.net;
  const operatorAdded = BigInt(ledger.total.raw);
  const venueEarned = totalGain - operatorAdded;
  const ratio = splitRatio(totalGain, venueEarned, operatorAdded);
  const exactZero = deployedPrincipal === 0n && totalGain === 0n && operatorAdded === 0n;
  const response = {
    schemaVersion: 1,
    status: exactZero ? "zero" : "attributed",
    statement: exactZero
      ? "No deployed principal, operator-added assets, or cumulative NAV gain are recorded for this pool."
      : "Cumulative marked NAV gain is separated into venue-earned and operator-added assets.",
    atBlock: blockNumber,
    basis: {
      model: "cumulative_marked_nav_gain",
      equation: "marked assets - net share-backed capital = venue-earned + operator-added",
      markedAssets: amount(markedAssets),
      netShareBackedCapital: amount(capital.net),
      depositedCapital: amount(capital.deposits),
      withdrawnCapital: amount(capital.withdrawals),
      operatorPrincipal: amount(capital.operatorPrincipal),
      deployedPrincipal: amount(deployedPrincipal)
    },
    gain: {
      cumulativeNav: signedAmount(totalGain),
      venueEarned: signedAmount(venueEarned),
      operatorAdded: amount(operatorAdded)
    },
    splitRatio: ratio,
    subsidyLedger: ledger
  };

  if (wallet) {
    const liveShares = BigInt(snapshot.wallet?.shares ?? 0);
    response.wallet = {
      address: getAddress(wallet),
      ...walletAttribution({
        wallet,
        liveShares,
        totalShares,
        markedAssets,
        events: boundedEvents,
        ratio,
        operatorAdded,
        totalGain
      })
    };
  }
  return response;
}

export class EvmYieldAttributionChainReader {
  constructor(provider, { deploymentBlock, logChunkBlocks = DEFAULT_LOG_CHUNK_BLOCKS } = {}) {
    this.provider = provider;
    this.deploymentBlock = exactBlockNumber(deploymentBlock, "deploymentBlock");
    this.logChunkBlocks = Math.max(1, Number(logChunkBlocks));
    this.cache = undefined;
    this.readPromise = undefined;
  }

  async readHistory({ poolAddress, toBlock }) {
    const normalizedPool = getAddress(poolAddress);
    const target = exactBlockNumber(toBlock, "toBlock");
    if (target < this.deploymentBlock) return [];
    if (this.readPromise) await this.readPromise;
    if (this.cache?.pool === normalizedPool && this.cache.head >= target) {
      return this.cache.events.filter((event) => event.blockNumber <= target);
    }
    this.readPromise = this.#extend(normalizedPool, target);
    try {
      await this.readPromise;
    } finally {
      this.readPromise = undefined;
    }
    return this.cache.events.filter((event) => event.blockNumber <= target);
  }

  async #extend(poolAddress, target) {
    const canExtend = this.cache?.pool === poolAddress && this.cache.head >= this.deploymentBlock;
    const events = canExtend ? [...this.cache.events] : [];
    const fromBlock = canExtend ? this.cache.head + 1 : this.deploymentBlock;
    for (let start = fromBlock; start <= target; start += this.logChunkBlocks) {
      const end = Math.min(target, start + this.logChunkBlocks - 1);
      const logs = await this.provider.getLogs({ address: poolAddress, fromBlock: start, toBlock: end });
      for (const log of logs) {
        let decoded;
        try {
          decoded = POOL_INTERFACE.parseLog(log);
        } catch {
          continue;
        }
        if (!decoded || !["Deposit", "Withdraw", "OperatorPrincipalContributed"].includes(decoded.name)) continue;
        const base = {
          type: decoded.name,
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0),
          txHash: String(log.transactionHash ?? "").toLowerCase(),
          assetsRaw: BigInt(decoded.args.assets).toString(),
          sharesRaw: BigInt(decoded.args.shares).toString()
        };
        events.push(decoded.name === "OperatorPrincipalContributed"
          ? base
          : { ...base, owner: getAddress(decoded.args.owner) });
      }
    }
    events.sort(eventPosition);
    this.cache = { pool: poolAddress, head: target, events };
  }
}

export class YieldAttributionService {
  constructor({
    poolAddress,
    assetAddress,
    chainId,
    deploymentBlock,
    provider,
    chainReader,
    stateStore,
    now = () => new Date()
  } = {}) {
    this.poolAddress = poolAddress ? getAddress(poolAddress) : "";
    this.assetAddress = assetAddress ? getAddress(assetAddress) : "";
    this.chainId = Number(chainId);
    this.provider = provider;
    this.chainReader = chainReader ?? (provider && Number.isSafeInteger(Number(deploymentBlock))
      ? new EvmYieldAttributionChainReader(provider, { deploymentBlock })
      : undefined);
    this.stateStore = stateStore;
    this.now = now;
  }

  async getAttribution({ snapshot, wallet = undefined }) {
    if (!this.poolAddress || !this.assetAddress || !this.chainReader || !this.stateStore) {
      return { schemaVersion: 1, status: "unavailable", reason: "yield_attribution_not_configured" };
    }
    try {
      const [events, ledgerEntries] = await Promise.all([
        this.chainReader.readHistory({ poolAddress: this.poolAddress, toBlock: snapshot.blockNumber }),
        this.stateStore.listYieldSubsidyEntries()
      ]);
      return buildYieldAttribution({ snapshot, events, ledgerEntries, wallet });
    } catch (error) {
      return {
        schemaVersion: 1,
        status: "unavailable",
        reason: "yield_attribution_read_failed",
        lastError: redactProviderError(error) || "yield_attribution_read_failed"
      };
    }
  }

  async getLedger() {
    if (!this.stateStore?.listYieldSubsidyEntries) {
      return { schemaVersion: 1, available: false, reason: "yield_subsidy_ledger_not_configured" };
    }
    return { schemaVersion: 1, available: true, ...ledgerPayload(await this.stateStore.listYieldSubsidyEntries()) };
  }

  async attestSubsidy({ txHash: inputTxHash, attestedBy }) {
    if (!this.provider || !this.poolAddress || !this.assetAddress || !this.stateStore?.putYieldSubsidyEntry) {
      throw new ConflictError(
        "Yield subsidy attestation is unavailable because its chain reader or durable ledger is not configured.",
        "yield_subsidy_ledger_not_configured"
      );
    }
    const txHash = normalizeTxHash(inputTxHash);
    const [transaction, receipt] = await Promise.all([
      this.provider.getTransaction(txHash),
      this.provider.getTransactionReceipt(txHash)
    ]);
    if (!transaction || !receipt) {
      throw new ConflictError("The subsidy transaction is not readable from the configured Hub RPC.", "yield_subsidy_transaction_unreadable", { txHash });
    }
    if (Number(receipt.status) !== 1) {
      throw new ConflictError("The subsidy transaction did not succeed.", "yield_subsidy_transaction_failed", { txHash });
    }
    if (!transaction.to || getAddress(transaction.to) !== this.assetAddress || BigInt(transaction.value ?? 0) !== 0n) {
      throw new ConflictError("The transaction is not a zero-native-value call to the configured Hub USDC contract.", "yield_subsidy_transaction_wrong_asset", { txHash });
    }
    let decoded;
    try {
      decoded = TOKEN_INTERFACE.parseTransaction({ data: transaction.data, value: transaction.value ?? 0n });
    } catch {
      decoded = null;
    }
    if (!decoded || decoded.name !== "transfer" || getAddress(decoded.args.to) !== this.poolAddress) {
      throw new ConflictError("The transaction is not a Hub USDC transfer to the configured deposit pool.", "yield_subsidy_transaction_wrong_recipient", { txHash });
    }
    const amountRaw = BigInt(decoded.args.amount);
    if (amountRaw <= 0n) {
      throw new ConflictError("The subsidy transaction amount must be positive.", "yield_subsidy_transaction_zero_amount", { txHash });
    }
    const blockNumber = exactBlockNumber(receipt.blockNumber, "receipt.blockNumber");
    const block = await this.provider.getBlock(blockNumber);
    const timestampSeconds = Number(block?.timestamp);
    if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
      throw new ConflictError("The subsidy transaction block timestamp is unreadable.", "yield_subsidy_timestamp_unreadable", { txHash, blockNumber });
    }
    const entry = {
      schemaVersion: 1,
      txHash,
      pool: this.poolAddress,
      asset: this.assetAddress,
      chainId: this.chainId,
      from: getAddress(transaction.from),
      amountRaw: amountRaw.toString(),
      blockNumber,
      blockHash: receipt.blockHash ?? block?.hash ?? null,
      timestamp: new Date(timestampSeconds * 1_000).toISOString(),
      attestedAt: this.now().toISOString(),
      attestedBy: getAddress(attestedBy)
    };
    const stored = await this.stateStore.putYieldSubsidyEntry(entry);
    const proofFields = ["txHash", "pool", "asset", "chainId", "from", "amountRaw", "blockNumber", "blockHash", "timestamp"];
    if (proofFields.some((field) => String(stored.entry?.[field]) !== String(entry[field]))) {
      throw new ConflictError(
        "The transaction hash is already attested with different proof fields; append a separate correction instead of editing the entry.",
        "yield_subsidy_attestation_conflict",
        { txHash }
      );
    }
    return {
      schemaVersion: 1,
      created: stored.created,
      entry: publicLedgerEntry(stored.entry),
      attestation: YIELD_SUBSIDY_ATTESTATION
    };
  }
}
