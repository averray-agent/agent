import { hexlify } from "ethers";

import { ConflictError, ValidationError } from "../core/errors.js";
import { accountId32FromSs58, h160ToSs58 } from "../core/wallet-identity.js";

export const ASSET_HUB_USDC_ASSET_ID = "1337";
export const ASSET_HUB_USDC_ADDRESS = "0x0000053900000000000000000000000001200000";
const HASH = /^0x[0-9a-f]{64}$/u;

function refused(reason, message) {
  return new ConflictError(message, `yield_subsidy_extrinsic_${reason}`);
}

function accountHex(account) {
  const value = String(account?.toHex?.() ?? account).toLowerCase();
  return HASH.test(value) ? value : hexlify(accountId32FromSs58(String(account))).toLowerCase();
}

/** A block number locates evidence; only this block's verified events name value. */
export class SubstrateSubsidyReader {
  constructor({ balanceReader, endpoint, timeoutMs = 15_000 } = {}) {
    this.balanceReader = balanceReader;
    this.endpoint = String(endpoint ?? "").trim();
    this.timeoutMs = Math.min(15_000, Math.max(1, Number(timeoutMs) || 15_000));
  }

  async read({ extrinsicHash, blockNumber, poolAddress }) {
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
      throw new ValidationError("A positive integer blockNumber is required to locate the Substrate extrinsic; no unbounded chain scan is performed.", { field: "blockNumber" });
    }
    if (!this.endpoint || !this.balanceReader?.getSubstrateApi) {
      throw refused("reader_unconfigured", "The configured Asset Hub Substrate reader is unavailable.");
    }
    let timer;
    try {
      return await Promise.race([
        this.#readBlock({ extrinsicHash, blockNumber, poolAddress }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.balanceReader.resetSubstrateApi?.(this.endpoint);
            reject(refused("read_timeout", "The Asset Hub extrinsic evidence read timed out."));
          }, this.timeoutMs);
        })
      ]);
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ValidationError) throw error;
      throw refused("unreadable", "The Asset Hub extrinsic, events or block timestamp could not be read and decoded.");
    } finally {
      clearTimeout(timer);
    }
  }

  async #readBlock({ extrinsicHash, blockNumber, poolAddress }) {
    const api = await this.balanceReader.getSubstrateApi(this.endpoint);
    const [hash, finalizedHash] = await Promise.all([
      api.rpc.chain.getBlockHash(blockNumber), api.rpc.chain.getFinalizedHead()
    ]);
    const blockHash = String(hash).toLowerCase();
    if (!HASH.test(blockHash)) throw refused("unreadable", "The block hash is unreadable.");
    const [signedBlock, finalized] = await Promise.all([
      api.rpc.chain.getBlock(blockHash), api.rpc.chain.getHeader(finalizedHash)
    ]);
    const block = signedBlock.block;
    if (Number(block.header.number) !== blockNumber) throw refused("block_mismatch", "The returned block does not match the requested block number.");
    const finalizedNumber = Number(finalized.number);
    if (!Number.isSafeInteger(finalizedNumber) || finalizedNumber < blockNumber) {
      throw refused("not_finalized", "The subsidy extrinsic block is not finalized.");
    }
    const extrinsicIndex = block.extrinsics.findIndex((extrinsic) => String(extrinsic.hash).toLowerCase() === extrinsicHash);
    if (extrinsicIndex < 0) throw refused("not_found", "The named extrinsic is absent from the supplied block.");
    const at = await api.at(blockHash);
    const [events, timestamp] = await Promise.all([at.query.system.events(), at.query.timestamp.now()]);
    const scoped = Array.from(events, (record, eventIndex) => ({ record, eventIndex }))
      .filter(({ record }) => record.phase.isApplyExtrinsic === true && Number(record.phase.asApplyExtrinsic) === extrinsicIndex);
    const isEvent = ({ record }, section, method) => record.event.section === section && record.event.method === method;
    if (scoped.some((row) => isEvent(row, "system", "ExtrinsicFailed"))
      || !scoped.some((row) => isEvent(row, "system", "ExtrinsicSuccess"))) {
      throw refused("failed", "The named extrinsic has no successful execution proof.");
    }
    const transfers = scoped.filter((row) => isEvent(row, "assets", "Transferred"));
    if (!transfers.length) throw refused("transfer_missing", "The extrinsic emitted no assets.Transferred event.");
    const usdc = transfers.filter(({ record }) => String(record.event.data[0]) === ASSET_HUB_USDC_ASSET_ID);
    if (!usdc.length) throw refused("wrong_asset", "The extrinsic did not transfer Asset Hub USDC (asset 1337).");
    const recipient = hexlify(accountId32FromSs58(h160ToSs58(poolAddress))).toLowerCase();
    const matches = usdc.filter(({ record }) => accountHex(record.event.data[2]) === recipient);
    if (!matches.length) throw refused("wrong_recipient", "The USDC transfer recipient is not the configured pool's EVM-derived AccountId32.");
    if (matches.length !== 1) throw refused("ambiguous_transfer", "Multiple USDC transfers to this pool occurred in the extrinsic; one unambiguous transfer is required.");
    const [{ record, eventIndex }] = matches;
    const raw = String(record.event.data[3]);
    if (!/^\d+$/u.test(raw) || BigInt(raw) <= 0n) throw refused("zero_amount", "The transferred amount must be positive.");
    const timestampRaw = String(timestamp ?? "");
    const timestampMs = Number(timestampRaw);
    if (!/^\d+$/u.test(timestampRaw) || !Number.isSafeInteger(timestampMs) || !Number.isFinite(new Date(timestampMs).getTime())) {
      throw refused("timestamp_unreadable", "The block timestamp is unreadable.");
    }
    return {
      from: accountHex(record.event.data[1]), amountRaw: BigInt(raw).toString(),
      blockNumber: Number(block.header.number), blockHash,
      timestamp: new Date(timestampMs).toISOString(),
      verificationMethod: "substrate_extrinsic", extrinsicIndex, eventIndex
    };
  }
}
