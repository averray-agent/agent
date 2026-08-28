import { Contract, Interface, getAddress, id, zeroPadValue } from "ethers";

import {
  AGENT_ACCOUNT_ABI,
  ESCROW_CORE_ABI,
  ESCROW_CORE_V1_DRAIN_ABI
} from "../blockchain/abis.js";

const WINDOW_SECONDS = 30 * 24 * 60 * 60;
const LOG_CHUNK_SIZE = 25_000;
const BPS = 10_000n;

const ESCROW_INTERFACE = new Interface(ESCROW_CORE_ABI);
const ACCOUNT_INTERFACE = new Interface(AGENT_ACCOUNT_ABI);
const SETTLEMENT_TOPIC = id(
  "SettlementSplit(bytes32,address,address,address,uint256,uint256,uint16)"
);
const DISPUTE_TOPIC = id("DisputeResolved(bytes32,address,uint256,bytes32,string)");
const JOB_STAKE_SLASH_TOPIC = id("JobStakeSlashed(address,address,uint256,uint256,uint256)");
const CLAIM_FEE_SLASH_TOPIC = id("ClaimFeeSlashed(address,address,uint256,address,uint256,uint256)");

function minimum(a, b) {
  return a < b ? a : b;
}

export class EvmReceiptGraphReader {
  constructor({ provider, escrowAddresses = [], accountAddress, now = () => new Date() } = {}) {
    this.provider = provider;
    const seen = new Set();
    this.escrowSources = [];
    for (const [index, value] of escrowAddresses.entries()) {
      if (!value) continue;
      const address = getAddress(value);
      if (seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      this.escrowSources.push({
        address,
        // bootstrap supplies current first and the v1 drain second. The event
        // surfaces match, but jobs() has a shorter return tuple on the drain.
        abi: index === 0 ? ESCROW_CORE_ABI : ESCROW_CORE_V1_DRAIN_ABI
      });
    }
    this.accountAddress = accountAddress ? getAddress(accountAddress) : "";
    this.now = now;
  }

  async readWindow({ wallet, asset }) {
    if (!this.provider || this.escrowSources.length === 0 || !this.accountAddress) {
      throw new Error("Receipt-graph event history is not configured.");
    }
    const headBlock = Number(await this.provider.getBlockNumber());
    const cutoffTimestamp = Math.floor(this.now().getTime() / 1_000) - WINDOW_SECONDS;
    const fromBlock = await findFirstBlockAtOrAfter(this.provider, headBlock, cutoffTimestamp);
    const workerTopic = zeroPadValue(getAddress(wallet), 32);
    const normalizedAsset = getAddress(asset).toLowerCase();
    const settlements = [];
    const upheldDisputes = [];

    for (const source of this.escrowSources) {
      const settlementLogs = await readLogsChunked(this.provider, {
        address: source.address,
        topics: [SETTLEMENT_TOPIC, null, workerTopic],
        fromBlock,
        toBlock: headBlock
      });
      for (const log of settlementLogs) {
        const parsed = ESCROW_INTERFACE.parseLog(log);
        if (!parsed || getAddress(parsed.args.asset).toLowerCase() !== normalizedAsset) continue;
        settlements.push({
          jobId: String(parsed.args.jobId).toLowerCase(),
          workerAmountRaw: BigInt(parsed.args.workerAmount).toString(),
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash
        });
      }

      const disputeLogs = await readLogsChunked(this.provider, {
        address: source.address,
        topics: [DISPUTE_TOPIC],
        fromBlock,
        toBlock: headBlock
      });
      const escrow = new Contract(source.address, source.abi, this.provider);
      for (const log of disputeLogs) {
        const parsed = ESCROW_INTERFACE.parseLog(log);
        if (!parsed || BigInt(parsed.args.workerPayout) !== 0n) continue;
        const job = await escrow.jobs(parsed.args.jobId, { blockTag: headBlock });
        const jobWorker = getAddress(job.worker ?? job[0]?.worker ?? job[0]?.[1] ?? job[1]);
        if (jobWorker.toLowerCase() !== getAddress(wallet).toLowerCase()) continue;
        upheldDisputes.push({
          jobId: String(parsed.args.jobId).toLowerCase(),
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash
        });
      }
    }

    const slashes = [];
    for (const topic of [JOB_STAKE_SLASH_TOPIC, CLAIM_FEE_SLASH_TOPIC]) {
      const logs = await readLogsChunked(this.provider, {
        address: this.accountAddress,
        topics: [topic, workerTopic],
        fromBlock,
        toBlock: headBlock
      });
      for (const log of logs) {
        const parsed = ACCOUNT_INTERFACE.parseLog(log);
        if (!parsed) continue;
        slashes.push({
          kind: parsed.name,
          amountRaw: BigInt(parsed.args.amount).toString(),
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash
        });
      }
    }

    return {
      settlements,
      slashes,
      upheldDisputes,
      headBlock,
      fromBlock,
      cutoffTimestamp
    };
  }
}

export class ReceiptGraphUnderwriter {
  constructor({
    reader,
    tierPerksPolicy,
    cashAlphaBps = 5_000,
    postingAlphaBps = 10_000
  } = {}) {
    this.reader = reader;
    this.tierPerksPolicy = tierPerksPolicy;
    this.cashAlphaBps = BigInt(cashAlphaBps);
    this.postingAlphaBps = BigInt(postingAlphaBps);
  }

  async evaluate({ wallet, asset, cashCapRaw, postingCapRaw }) {
    try {
      const [evidence, tierPerks] = await Promise.all([
        this.reader.readWindow({ wallet, asset }),
        this.tierPerksPolicy?.forWallet?.(wallet)
      ]);
      const trailingNetRaw = evidence.settlements.reduce(
        (sum, settlement) => sum + BigInt(settlement.workerAmountRaw),
        0n
      );
      const disqualified = evidence.slashes.length > 0 || evidence.upheldDisputes.length > 0;
      const cashLimitRaw = disqualified
        ? 0n
        : minimum(BigInt(cashCapRaw), trailingNetRaw * this.cashAlphaBps / BPS);
      const postingLimitRaw = disqualified
        ? 0n
        : minimum(BigInt(postingCapRaw), trailingNetRaw * this.postingAlphaBps / BPS);
      return {
        available: true,
        source: "decoded_settlement_split_logs",
        windowDays: 30,
        trailingNetRaw: trailingNetRaw.toString(),
        cashLimitRaw: cashLimitRaw.toString(),
        postingLimitRaw: postingLimitRaw.toString(),
        disqualified,
        disqualificationReason: evidence.slashes.length > 0
          ? "slash_in_window"
          : evidence.upheldDisputes.length > 0
            ? "upheld_dispute_in_window"
            : null,
        evidence: {
          settlementCount: evidence.settlements.length,
          slashCount: evidence.slashes.length,
          upheldDisputeCount: evidence.upheldDisputes.length,
          fromBlock: evidence.fromBlock,
          headBlock: evidence.headBlock
        },
        ...(tierPerks ? { tierQualification: tierPerks.creditQualification } : {})
      };
    } catch (error) {
      return {
        available: false,
        source: "decoded_settlement_split_logs",
        windowDays: 30,
        trailingNetRaw: null,
        cashLimitRaw: "0",
        postingLimitRaw: "0",
        disqualified: true,
        disqualificationReason: "receipt_graph_unavailable",
        error: String(error?.message ?? "receipt_graph_read_failed")
      };
    }
  }
}

async function findFirstBlockAtOrAfter(provider, headBlock, cutoffTimestamp) {
  let low = 0;
  let high = headBlock;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const block = await provider.getBlock(mid);
    if (Number(block?.timestamp) < cutoffTimestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

async function readLogsChunked(provider, filter) {
  const logs = [];
  for (let start = Number(filter.fromBlock); start <= Number(filter.toBlock); start += LOG_CHUNK_SIZE) {
    const end = Math.min(Number(filter.toBlock), start + LOG_CHUNK_SIZE - 1);
    logs.push(...await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
  }
  return logs;
}
