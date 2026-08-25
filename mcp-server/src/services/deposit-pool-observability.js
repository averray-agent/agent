import { Contract, Interface, ZeroAddress, getAddress } from "ethers";

import {
  DEPOSIT_POOL_ABI,
  DEPOSIT_POOL_VENUE_ADAPTER_ABI,
  ERC20_MOCK_ABI
} from "../blockchain/abis.js";
import { evaluateVenueMark, markedSharePrice } from "../core/deposit-pool-venue-mark.js";
import { redactProviderError } from "../core/redact-provider-error.js";
import { depositPoolYieldStatus } from "./deposit-pool-yield-status.js";

const ASSET_DECIMALS = 6;
const SHARE_PRICE_SCALE = 1_000_000n;
const DEFAULT_EVENT_WINDOW_BLOCKS = 2_000;
const DEFAULT_RECENT_FLOW_LIMIT = 20;
const FLOW_EVENTS = new Set(["Deposit", "Withdraw", "RedeemRequested", "RedeemFulfilled"]);
const PRICE_QUALIFYING_EVENTS = new Set([
  "OperatorPrincipalContributed",
  "RedeemFulfilled",
  "VenueLossWrittenOff"
]);

function amount(raw) {
  return { raw: BigInt(raw).toString(), decimals: ASSET_DECIMALS };
}

function clampAtZero(value) {
  return value > 0n ? value : 0n;
}

function compareEventsDesc(a, b) {
  return Number(b.blockNumber) - Number(a.blockNumber) || Number(b.logIndex) - Number(a.logIndex);
}

function eventProof(event) {
  const common = {
    type: event.type,
    blockNumber: Number(event.blockNumber),
    logIndex: Number(event.logIndex),
    txHash: event.txHash
  };
  for (const key of ["assetsRaw", "sharesRaw", "requestId", "tier", "unlockAt"]) {
    if (event[key] !== undefined && event[key] !== null) common[key] = String(event[key]);
  }
  return common;
}

function summarizeFlows(events, { totalAssets, totalShares, recentFlowLimit }) {
  const depositors = new Set();
  const pending = new Map();
  for (const event of [...events].sort((a, b) => -compareEventsDesc(a, b))) {
    if (event.type === "Deposit" && event.owner) depositors.add(String(event.owner).toLowerCase());
    if (event.type === "RedeemRequested") {
      pending.set(String(event.requestId).toLowerCase(), BigInt(event.sharesRaw));
    } else if (event.type === "RedeemFulfilled") {
      pending.delete(String(event.requestId).toLowerCase());
    }
  }
  const pendingShares = [...pending.values()].reduce((sum, value) => sum + value, 0n);
  const pendingAssets = totalShares > 0n ? pendingShares * totalAssets / totalShares : pendingShares;
  const sorted = [...events].sort(compareEventsDesc);
  return {
    status: "ok",
    depositorCount: depositors.size,
    depositorCountModel: "distinct-deposit-owners-in-event-window",
    pendingUnfulfilledRedemptionShares: amount(pendingShares),
    pendingUnfulfilledRedemptionAssets: amount(pendingAssets),
    recent: sorted.filter((event) => FLOW_EVENTS.has(event.type)).slice(0, recentFlowLimit).map(eventProof),
    sharePriceQualifyingEvents: sorted.filter((event) => PRICE_QUALIFYING_EVENTS.has(event.type)).map(eventProof),
    lastError: null
  };
}

export class EvmDepositPoolChainReader {
  constructor(provider) {
    this.provider = provider;
    this.poolInterface = new Interface(DEPOSIT_POOL_ABI);
  }

  async getBlockNumber() {
    return this.provider.getBlockNumber();
  }

  async getBlock(blockNumber) {
    return this.provider.getBlock(blockNumber);
  }

  async readState({ poolAddress, blockTag }) {
    const pool = new Contract(poolAddress, DEPOSIT_POOL_ABI, this.provider);
    const overrides = { blockTag };
    const [asset, totalAssets, totalShares, deployed, totalAssetCap, perAgentAssetCap] = await Promise.all([
      pool.asset(overrides),
      pool.totalAssets(overrides),
      pool.totalSupply(overrides),
      pool.venuePrincipalCostBasis(overrides),
      pool.TOTAL_ASSET_CAP(overrides),
      pool.PER_AGENT_ASSET_CAP(overrides)
    ]);
    const token = new Contract(asset, ERC20_MOCK_ABI, this.provider);
    const buffer = await token.balanceOf(poolAddress, overrides);
    const venue = await this.#readVenueMark({ pool, poolAddress, deployed, overrides });
    return { asset, totalAssets, totalShares, buffer, deployed, totalAssetCap, perAgentAssetCap, ...venue };
  }

  /**
   * The venue leg's landed value per the pool's own immutable adapter. Read
   * only while cost basis is positive, and never allowed to throw: an
   * unreadable mark is reported as unreadable, not silently omitted.
   */
  async #readVenueMark({ pool, poolAddress, deployed, overrides }) {
    if (BigInt(deployed) === 0n) return { venueMarkedAssets: null };
    try {
      const adapterAddress = await pool.venueAdapter(overrides);
      if (!adapterAddress || adapterAddress === ZeroAddress) {
        return { venueMarkUnreadable: "venue_adapter_not_configured" };
      }
      const adapter = new Contract(adapterAddress, DEPOSIT_POOL_VENUE_ADAPTER_ABI, this.provider);
      return {
        venueAdapter: getAddress(adapterAddress),
        venueMarkedAssets: await adapter.managedAssets(poolAddress, overrides)
      };
    } catch (error) {
      return { venueMarkUnreadable: redactProviderError(error) || "venue_managed_assets_read_failed" };
    }
  }

  async readEvents({ poolAddress, fromBlock, toBlock }) {
    const logs = await this.provider.getLogs({ address: poolAddress, fromBlock, toBlock });
    const events = [];
    for (const log of logs) {
      let decoded;
      try {
        decoded = this.poolInterface.parseLog(log);
      } catch {
        continue;
      }
      // ethers v6 parseLog RETURNS NULL for unknown topics instead of throwing
      // (v5 threw), so the catch above guards nothing. The pool emits events
      // this interface deliberately does not model — its ERC-20 share Transfer
      // mints (first hit live 2026-08-13: the operator-principal contribution's
      // two Transfer logs nulled the whole flows block). Unmodeled events are
      // neither depositor flows nor price-qualifying, so skipping them is the
      // correct classification, not a blind eye.
      if (!decoded) continue;
      if (!FLOW_EVENTS.has(decoded.name) && !PRICE_QUALIFYING_EVENTS.has(decoded.name)) continue;
      const base = {
        type: decoded.name,
        blockNumber: log.blockNumber,
        logIndex: log.index ?? log.logIndex,
        txHash: log.transactionHash
      };
      if (decoded.name === "Deposit" || decoded.name === "Withdraw") {
        events.push({ ...base, owner: decoded.args.owner, assetsRaw: decoded.args.assets.toString(), sharesRaw: decoded.args.shares.toString() });
      } else if (decoded.name === "RedeemRequested") {
        events.push({ ...base, owner: decoded.args.owner, requestId: decoded.args.requestId, sharesRaw: decoded.args.shares.toString(), tier: decoded.args.tier.toString(), unlockAt: decoded.args.unlockAt.toString() });
      } else if (decoded.name === "RedeemFulfilled") {
        events.push({ ...base, requestId: decoded.args.requestId, sharesRaw: decoded.args.shares.toString(), assetsRaw: decoded.args.assets.toString() });
      } else {
        events.push({ ...base, assetsRaw: decoded.args.assets?.toString(), sharesRaw: decoded.args.shares?.toString() });
      }
    }
    return events;
  }
}

export class DepositPoolObservabilityService {
  constructor({
    poolAddress,
    provider,
    chainReader,
    catalogueDailyBudget,
    eventWindowBlocks = DEFAULT_EVENT_WINDOW_BLOCKS,
    recentFlowLimit = DEFAULT_RECENT_FLOW_LIMIT,
    venueMark = undefined
  } = {}) {
    this.venueMarkConfig = venueMark;
    this.poolAddress = poolAddress ? getAddress(poolAddress) : "";
    this.chainReader = chainReader ?? (provider ? new EvmDepositPoolChainReader(provider) : undefined);
    this.catalogueDailyBudget = catalogueDailyBudget;
    this.eventWindowBlocks = eventWindowBlocks;
    this.recentFlowLimit = recentFlowLimit;
  }

  async getSnapshot() {
    const catalogueDailyBudget = await this.#catalogueBudgetStatus();
    if (!this.poolAddress) {
      return {
        schemaVersion: 1,
        available: false,
        reason: "deposit_pool_not_configured",
        catalogueDailyBudget
      };
    }
    if (!this.chainReader) throw new Error("DepositPool observability requires a chain reader.");

    const head = await this.chainReader.getBlockNumber();
    const [block, state] = await Promise.all([
      this.chainReader.getBlock(head),
      this.chainReader.readState({ poolAddress: this.poolAddress, blockTag: head })
    ]);
    const totalAssets = BigInt(state.totalAssets);
    const totalShares = BigInt(state.totalShares);
    const buffer = BigInt(state.buffer);
    const deployed = BigInt(state.deployed);
    const totalAssetCap = BigInt(state.totalAssetCap);
    const perAgentAssetCap = BigInt(state.perAgentAssetCap);
    const accounted = buffer + deployed;
    const sharePrice = totalShares === 0n ? SHARE_PRICE_SCALE : totalAssets * SHARE_PRICE_SCALE / totalShares;
    const venueMark = evaluateVenueMark({
      costBasisRaw: deployed,
      markedRaw: state.venueMarkedAssets,
      totalAssetsRaw: totalAssets,
      toleranceBps: this.venueMarkConfig?.toleranceBps,
      dustFloorRaw: this.venueMarkConfig?.dustFloorRaw,
      unreadableReason: state.venueMarkUnreadable
    });
    const yieldState = depositPoolYieldStatus(deployed);
    const fromBlock = Math.max(0, head - this.eventWindowBlocks + 1);
    const window = { fromBlock, toBlock: head, maxBlocks: this.eventWindowBlocks, recentLimit: this.recentFlowLimit };
    let flows;
    try {
      const events = await this.chainReader.readEvents({ poolAddress: this.poolAddress, fromBlock, toBlock: head });
      flows = {
        ...summarizeFlows(events, { totalAssets, totalShares, recentFlowLimit: this.recentFlowLimit }),
        window
      };
    } catch (error) {
      flows = {
        status: "unavailable",
        depositorCount: null,
        depositorCountModel: "distinct-deposit-owners-in-event-window",
        pendingUnfulfilledRedemptionShares: null,
        pendingUnfulfilledRedemptionAssets: null,
        recent: null,
        sharePriceQualifyingEvents: null,
        window,
        lastError: redactProviderError(error) || "deposit_pool_event_read_failed"
      };
    }

    return {
      schemaVersion: 1,
      available: true,
      catalogueDailyBudget,
      pool: this.poolAddress,
      asset: getAddress(state.asset),
      block: {
        number: Number(block.number ?? head),
        hash: block.hash ?? null,
        timestamp: Number(block.timestamp),
        timestampIso: new Date(Number(block.timestamp) * 1_000).toISOString()
      },
      pricingModel: "principal-cost-basis",
      totalAssets: amount(totalAssets),
      totalShares: amount(totalShares),
      sharePrice: amount(sharePrice),
      buffer: amount(buffer),
      deployed: amount(deployed),
      // Bookkeeping identity only: totalAssets IS buffer + costBasis, so this
      // is true by construction and stayed true throughout the 2026-08-25
      // mispricing. It proves the ledger adds up, never that the venue leg is
      // worth what the ledger claims. venueMark below is the check that can fail.
      reconciled: accounted === totalAssets,
      reconciliation: {
        equation: "buffer + deployed = totalAssets",
        model: "internal-bookkeeping-identity",
        provesVenueValue: false,
        accountedRaw: accounted.toString(),
        differenceRaw: (totalAssets - accounted).toString()
      },
      venueMark,
      markedSharePrice: markedSharePrice({
        bufferAssetsRaw: buffer,
        markedRaw: state.venueMarkedAssets,
        totalSupplyRaw: totalShares,
        shareScale: SHARE_PRICE_SCALE
      }),
      caps: {
        totalAssetCap: amount(totalAssetCap),
        perAgentAssetCap: amount(perAgentAssetCap),
        headroom: amount(clampAtZero(totalAssetCap - totalAssets)),
        utilizationBps: totalAssetCap > 0n ? (totalAssets * 10_000n / totalAssetCap).toString() : null
      },
      ...yieldState,
      bufferFloorAlertEnabled: deployed > 0n,
      bornEmpty: totalShares === 0n && flows.status === "ok" && flows.depositorCount === 0,
      flows
    };
  }

  async #catalogueBudgetStatus() {
    if (typeof this.catalogueDailyBudget?.getStatus !== "function") {
      return { status: "unavailable", reason: "catalogue_daily_budget_not_configured" };
    }
    try {
      return await this.catalogueDailyBudget.getStatus();
    } catch {
      return {
        status: "unavailable",
        reason: "catalogue_daily_budget_read_failed",
        lastError: "catalogue_daily_budget_read_failed"
      };
    }
  }
}
