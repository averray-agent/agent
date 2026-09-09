import { getAddress } from "ethers";
import { resolveIndexerHealthProbeConfig } from "./indexer-health-probe.js";

const WINDOW_SECONDS = 30 * 24 * 60 * 60;
const MAX_PAGES = 10;
export const RECEIPT_GRAPH_CHECKPOINT_QUERY = `query CreditEvidenceCheckpoint($chainId: Int!) {
  _meta { status }
  receiptGraphCoverages(where: {chainId: $chainId}, limit: 100) {
    items { contract address fromBlock fromTimestamp }
    pageInfo { hasNextPage }
  }
}`;

const selections = {
  settlementSplits: `worker: $wallet, asset: $asset, escrowAddress_in: $escrows`,
  jobEvents: `worker: $wallet, escrowAddress_in: $escrows, kind: "DisputeResolved", amount: "0"`,
  jobStakeEvents: `account: $wallet, kind_in: ["slashed", "claim_fee_slashed"]`
};
const fields = {
  settlementSplits: "jobId worker asset escrowAddress workerAmount",
  jobEvents: "jobId worker escrowAddress amount",
  jobStakeEvents: "account kind amount"
};

export function receiptGraphPageQuery(table) {
  if (!Object.hasOwn(selections, table)) throw new Error("Unknown receipt-graph table.");
  const asset = table === "settlementSplits" ? ", $asset: String!" : "";
  const escrows = table !== "jobStakeEvents" ? ", $escrows: [String!]!" : "";
  return `query CreditEvidencePage($wallet: String!, $cutoff: BigInt!, $head: BigInt!, $after: String${asset}${escrows}) {
    page: ${table}(where: {${selections[table]}, timestamp_gte: $cutoff, blockNumber_lte: $head},
      orderBy: "id", orderDirection: "asc", limit: 1000, after: $after) {
      items { id ${fields[table]} blockNumber timestamp txHash }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

function refuse(reason) { throw Object.assign(new Error(reason), { reason }); }
function uint(value) { return /^\d+$/.test(String(value)) && BigInt(value) >= 0n; }
function address(value) { return getAddress(value).toLowerCase(); }

// This client deliberately has no EVM provider, fallback scan, or cross-request
// cache. It uses the existing Ponder query endpoint, not a new public route.
export class IndexedReceiptGraphReader {
  constructor({
    env = process.env, escrowAddresses = [], accountAddress, assetAddress,
    chainId, fetchImpl = globalThis.fetch, now = () => new Date()
  } = {}) {
    Object.assign(this, resolveIndexerHealthProbeConfig(env));
    this.escrows = [...new Set(escrowAddresses.filter(Boolean).map(address))].sort();
    this.accountAddress = accountAddress ? address(accountAddress) : "";
    this.assetAddress = assetAddress ? address(assetAddress) : "";
    this.chainId = Number(chainId);
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async readWindow({ wallet, asset = this.assetAddress }) {
    if (!this.statusUrl || !this.escrows.length || !this.accountAddress || !asset
      || !Number.isSafeInteger(this.chainId)) refuse("indexer_unconfigured");
    wallet = address(wallet);
    asset = address(asset);
    const url = new URL("./graphql", this.statusUrl);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const query = async (document, variables) => {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: document, variables }), signal
        });
        if (!response.ok) refuse("indexer_evidence_unavailable");
        const result = await response.json();
        if (result.errors?.length || !result.data) refuse("indexer_evidence_unavailable");
        return result.data;
      } catch (error) {
        if (error.reason) throw error;
        refuse(signal.aborted ? "indexer_timeout" : "indexer_evidence_unavailable");
      }
    };
    const data = await query(RECEIPT_GRAPH_CHECKPOINT_QUERY, { chainId: this.chainId });
    const checkpoints = Object.values(data._meta?.status ?? {})
      .filter((value) => Number(value.id) === this.chainId);
    const head = checkpoints.length === 1 ? checkpoints[0].block : undefined;
    if (!Number.isSafeInteger(head?.number) || !Number.isSafeInteger(head?.timestamp)
      || head.number < 0 || head.timestamp <= 0) refuse("indexer_checkpoint_missing");
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (head.timestamp > nowSeconds + 5) refuse("indexer_checkpoint_invalid");
if (nowSeconds - head.timestamp > this.lagBudgetSeconds) refuse("indexer_stale");
    const cutoffTimestamp = nowSeconds - WINDOW_SECONDS;
    const coverage = data.receiptGraphCoverages;
    if (!Array.isArray(coverage?.items) || coverage.pageInfo?.hasNextPage !== false) {
      refuse("indexer_coverage_missing");
    }
    const escrowCoverage = coverage.items.filter((row) => row.contract === "EscrowCore");
    const accountCoverage = coverage.items.filter((row) => row.contract === "AgentAccountCore");
    if (JSON.stringify(escrowCoverage.map((row) => address(row.address)).sort()) !== JSON.stringify(this.escrows)
      || accountCoverage.length !== 1 || address(accountCoverage[0].address) !== this.accountAddress) {
      refuse("indexer_source_mismatch");
    }
    for (const row of [...escrowCoverage, ...accountCoverage]) {
      if (!uint(row.fromBlock) || Number(row.fromBlock) > head.number
        || !uint(row.fromTimestamp) || Number(row.fromTimestamp) > cutoffTimestamp) {
        refuse("indexer_window_incomplete");
      }
    }
    const readPages = async (table) => {
      const rows = [];
      const ids = new Set();
      let after = null;
      for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
        const { page } = await query(receiptGraphPageQuery(table), {
          wallet, asset, escrows: this.escrows, cutoff: String(cutoffTimestamp),
          head: String(head.number), after
        });
        if (!Array.isArray(page?.items) || typeof page.pageInfo?.hasNextPage !== "boolean") {
          refuse("indexer_evidence_invalid");
        }
        for (const row of page.items) {
          if (!uint(row.timestamp) || Number(row.timestamp) < cutoffTimestamp
            || Number(row.timestamp) > head.timestamp
            || !uint(row.blockNumber) || Number(row.blockNumber) > head.number
            || address(row.worker ?? row.account) !== wallet) refuse("indexer_evidence_invalid");
          if (typeof row.id !== "string" || ids.has(row.id)) refuse("indexer_pagination_invalid");
          ids.add(row.id);
          if (table !== "jobStakeEvents" && !this.escrows.includes(address(row.escrowAddress))) refuse("indexer_source_mismatch");
          if (table === "settlementSplits" && (address(row.asset) !== asset || !uint(row.workerAmount))) refuse("indexer_evidence_invalid");
          if (table === "jobEvents" && String(row.amount) !== "0") refuse("indexer_evidence_invalid");
          if (table === "jobStakeEvents" && (!["slashed", "claim_fee_slashed"].includes(row.kind) || !uint(row.amount))) refuse("indexer_evidence_invalid");
        }
        rows.push(...page.items);
        if (!page.pageInfo.hasNextPage) return rows;
        const next = page.pageInfo.endCursor;
        if (!next || next === after) refuse("indexer_pagination_invalid");
        after = next;
      }
      refuse("indexer_evidence_limit");
    };
    const [settlements, upheldDisputes, slashes] = await Promise.all([
      readPages("settlementSplits"), readPages("jobEvents"), readPages("jobStakeEvents")
    ]);
if (Math.floor(this.now().getTime() / 1000) - head.timestamp > this.lagBudgetSeconds) refuse("indexer_stale");
    return {
      asset,
      settlements: settlements.map((row) => ({ ...row, workerAmountRaw: row.workerAmount })),
      upheldDisputes, slashes, headBlock: head.number, cutoffTimestamp,
      provenance: "indexer_checkpoint", checkpointTimestamp: head.timestamp
    };
  }
}
