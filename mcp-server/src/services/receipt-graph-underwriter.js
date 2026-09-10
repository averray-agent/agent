import { getAddress } from "ethers";

const BPS = 10_000n;
function minimum(a, b) { return a < b ? a : b; }

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

  async prepare({ wallet, asset }) {
    try {
      return { available: true, evidence: await this.reader.readWindow({ wallet, asset }) };
    } catch (error) {
      return { available: false, reason: error.reason ?? "receipt_graph_unavailable" };
    }
  }

  async evaluate({ wallet, asset, cashCapRaw, postingCapRaw, evidence: preparedEvidence }) {
    try {
      const evidence = preparedEvidence ?? await this.reader.readWindow({ wallet, asset });
      if (evidence.asset && getAddress(evidence.asset) !== getAddress(asset)) {
        throw Object.assign(new Error("Indexed asset does not match the credit book."), { reason: "indexer_asset_mismatch" });
      }
      const tierPerks = await this.tierPerksPolicy?.forWallet?.(wallet);
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
          headBlock: evidence.headBlock,
          ...(evidence.provenance ? {
            provenance: evidence.provenance,
            cutoffTimestamp: evidence.cutoffTimestamp,
            checkpointTimestamp: evidence.checkpointTimestamp
          } : {})
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
        disqualificationReason: error.reason ?? "receipt_graph_unavailable",
        error: String(error?.message ?? "receipt_graph_read_failed")
      };
    }
  }
}
