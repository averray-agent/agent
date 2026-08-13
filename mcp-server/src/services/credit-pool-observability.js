import { Contract, Interface, getAddress } from "ethers";

import { CREDIT_POOL_ABI } from "../blockchain/abis.js";
import { CREDIT_POOL_RISK_DISCLOSURE } from "../core/credit-pool-disclosure.js";
import { redactProviderError } from "../core/redact-provider-error.js";

const DECIMALS = 6;
const DEFAULT_EVENT_WINDOW_BLOCKS = 2_000;
const DEFAULT_RECENT_LIMIT = 20;
const LOAN_EVENTS = new Set(["LoanOriginated", "LoanRepaid", "LoanClosed", "PledgeSeized"]);

function amount(raw) {
  return { raw: BigInt(raw).toString(), decimals: DECIMALS };
}

export class EvmCreditPoolObservabilityReader {
  constructor(provider) {
    this.provider = provider;
    this.contractInterface = new Interface(CREDIT_POOL_ABI);
  }

  getBlockNumber() { return this.provider.getBlockNumber(); }
  getBlock(blockNumber) { return this.provider.getBlock(blockNumber); }

  async readState({ poolAddress, blockTag }) {
    const pool = new Contract(poolAddress, CREDIT_POOL_ABI, this.provider);
    const at = { blockTag };
    const [asset, depositPool, totalAssets, totalShares, buffer, principalOutstanding, totalPledgedShares, defaults, ltvBps, interestBps, totalAssetCap, perLenderCap, disclosure] = await Promise.all([
      pool.asset(at), pool.depositPool(at), pool.totalAssets(at), pool.totalSupply(at), pool.bufferAssets(at),
      pool.principalOutstanding(at), pool.totalPledgedShares(at), pool.defaults(at), pool.ltvBps(at),
      pool.interestBps(at), pool.TOTAL_ASSET_CAP(at), pool.PER_LENDER_CAP(at), pool.RISK_DISCLOSURE(at)
    ]);
    return { asset, depositPool, totalAssets, totalShares, buffer, principalOutstanding, totalPledgedShares, defaults, ltvBps, interestBps, totalAssetCap, perLenderCap, disclosure };
  }

  async readEvents({ poolAddress, fromBlock, toBlock }) {
    const logs = await this.provider.getLogs({ address: poolAddress, fromBlock, toBlock });
    return logs.flatMap((log) => {
      let decoded;
      try { decoded = this.contractInterface.parseLog(log); } catch { return []; }
      if (!LOAN_EVENTS.has(decoded.name)) return [];
      const event = {
        type: decoded.name,
        loanId: String(decoded.args.loanId).toLowerCase(),
        blockNumber: Number(log.blockNumber),
        logIndex: Number(log.index ?? log.logIndex ?? 0),
        txHash: log.transactionHash
      };
      if (decoded.name === "LoanOriginated") Object.assign(event, {
        borrower: String(decoded.args.borrower),
        amountRaw: decoded.args.amount.toString(),
        pledgedSharesRaw: decoded.args.pledgedShares.toString()
      });
      if (decoded.name === "LoanRepaid") Object.assign(event, {
        amountRaw: decoded.args.amount.toString(),
        outstandingRaw: decoded.args.outstanding.toString()
      });
      if (decoded.name === "PledgeSeized") event.valueRaw = decoded.args.value.toString();
      return [event];
    });
  }
}

export class CreditPoolObservabilityService {
  constructor({ poolAddress, provider, chainReader, eventWindowBlocks = DEFAULT_EVENT_WINDOW_BLOCKS, recentLimit = DEFAULT_RECENT_LIMIT } = {}) {
    this.poolAddress = poolAddress ? getAddress(poolAddress) : "";
    this.chainReader = chainReader ?? (provider ? new EvmCreditPoolObservabilityReader(provider) : undefined);
    this.eventWindowBlocks = eventWindowBlocks;
    this.recentLimit = recentLimit;
  }

  async getSnapshot() {
    if (!this.poolAddress) return { schemaVersion: 1, available: false, reason: "credit_pool_not_configured" };
    if (!this.chainReader) throw new Error("CreditPool observability requires a chain reader.");
    const head = Number(await this.chainReader.getBlockNumber());
    const [block, state] = await Promise.all([
      this.chainReader.getBlock(head),
      this.chainReader.readState({ poolAddress: this.poolAddress, blockTag: head })
    ]);
    const totalAssets = BigInt(state.totalAssets);
    const buffer = BigInt(state.buffer);
    const principalOutstanding = BigInt(state.principalOutstanding);
    const fromBlock = Math.max(0, head - this.eventWindowBlocks + 1);
    let lifecycle;
    try {
      const events = await this.chainReader.readEvents({ poolAddress: this.poolAddress, fromBlock, toBlock: head });
      lifecycle = {
        status: "ok",
        recent: [...events]
          .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
          .slice(0, this.recentLimit),
        window: { fromBlock, toBlock: head, maxBlocks: this.eventWindowBlocks, recentLimit: this.recentLimit },
        lastError: null
      };
    } catch (error) {
      lifecycle = {
        status: "unavailable",
        recent: null,
        window: { fromBlock, toBlock: head, maxBlocks: this.eventWindowBlocks, recentLimit: this.recentLimit },
        lastError: redactProviderError(error) || "credit_pool_event_read_failed"
      };
    }
    return {
      schemaVersion: 1,
      available: true,
      pool: this.poolAddress,
      asset: getAddress(state.asset),
      depositPool: getAddress(state.depositPool),
      block: {
        number: Number(block?.number ?? head),
        hash: block?.hash ?? null,
        timestamp: Number(block?.timestamp),
        timestampIso: new Date(Number(block?.timestamp) * 1_000).toISOString()
      },
      totalAssets: amount(totalAssets),
      totalShares: amount(state.totalShares),
      buffer: amount(buffer),
      principalOutstanding: amount(principalOutstanding),
      totalPledgedShares: amount(state.totalPledgedShares),
      defaults: Number(state.defaults),
      caps: {
        totalAssetCap: amount(state.totalAssetCap),
        perLenderCap: amount(state.perLenderCap),
        headroom: amount(BigInt(state.totalAssetCap) > totalAssets ? BigInt(state.totalAssetCap) - totalAssets : 0n)
      },
      schedule: { ltvBps: Number(state.ltvBps), interestBps: Number(state.interestBps), platformFeeBps: 0 },
      reconciliation: {
        reconciled: buffer + principalOutstanding === totalAssets,
        equation: "buffer + principalOutstanding = totalAssets",
        differenceRaw: (totalAssets - buffer - principalOutstanding).toString()
      },
      disclosure: { statement: state.disclosure },
      lifecycle
    };
  }
}

export { CREDIT_POOL_RISK_DISCLOSURE };
