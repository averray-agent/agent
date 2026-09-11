import { Contract } from "ethers";
import { DEPOSIT_POOL_ABI } from "../blockchain/abis.js";
import { redactProviderError } from "../core/redact-provider-error.js";
import { EvmYieldAttributionChainReader } from "./yield-attribution-service.js";

const amount = (raw) => ({ raw: BigInt(raw).toString(), decimals: 6 });
export const EMPTY_VENUE_HISTORY = Object.freeze({
  status: "available", deploymentCount: "0", completedCycleCount: "0", lastDeployment: null
});

/** Read-only contract ledger + cash-return events at the door's named block. */
export class EvmDepositPoolVenueHistoryReader {
  constructor(provider, { deploymentBlock, eventReader } = {}) {
    this.provider = provider;
    this.eventReader = eventReader ?? (Number.isSafeInteger(deploymentBlock)
      ? new EvmYieldAttributionChainReader(provider, { deploymentBlock })
      : undefined);
  }

  async readHistory({ poolAddress, blockNumber, deployedPrincipal }) {
    try {
      const pool = new Contract(poolAddress, DEPOSIT_POOL_ABI, this.provider);
      const overrides = { blockTag: blockNumber };
      const [next, active] = await Promise.all([
        pool.nextVenueDeploymentId(overrides), pool.activeVenueDeploymentId(overrides)
      ]);
      const count = BigInt(next) - 1n;
      if (count < 0n || BigInt(active) > count) throw new Error("invalid_deployment_count");
      if (count === 0n) return { ...EMPTY_VENUE_HISTORY, atBlock: blockNumber };
      if (!this.eventReader) throw new Error("history_reader_not_configured");
      const [last, writtenOff, events] = await Promise.all([
        pool.venueDeployments(count, overrides),
        pool.venueWrittenOffPrincipalAssets(count, overrides),
        this.eventReader.readHistory({ poolAddress, toBlock: blockNumber })
      ]);
      const rows = events.filter((event) => event.blockNumber <= blockNumber && event.deploymentId === count.toString());
      const created = rows.filter((event) => event.type === "VenueDeploymentCreated");
      const returns = rows.filter((event) => event.type === "VenuePrincipalReturned");
      const losses = rows.filter((event) => event.type === "VenueLossWrittenOff");
      const returned = returns.reduce((sum, row) => sum + BigInt(row.returnedAssetsRaw), 0n);
      const principalReturned = returns.reduce((sum, row) => sum + BigInt(row.principalReductionRaw), 0n);
      const loss = losses.reduce((sum, row) => sum + BigInt(row.assetsRaw), 0n);
      if (created.length !== 1 || BigInt(created[0].assetsRaw) !== last.principalAssets
        || principalReturned !== last.recalledPrincipalAssets || loss > writtenOff) {
        throw new Error("history_does_not_match_contract_ledger");
      }
      // Only one deployment can be active. It closes once returns plus
      // write-offs extinguish principal. Do not call an unclosed record done.
      if (BigInt(deployedPrincipal) === 0n && (BigInt(active) !== 0n
        || last.principalAssets !== principalReturned + writtenOff)) {
        throw new Error("home_history_not_closed");
      }
      const proof = async (event) => {
        if (!event) return null;
        const block = await this.provider.getBlock(event.blockNumber);
        if (!Number.isSafeInteger(block?.timestamp) || block.timestamp < 0 || !block.hash) {
          throw new Error("history_timestamp_unavailable");
        }
        return {
          blockNumber: event.blockNumber, blockHash: block.hash, txHash: event.txHash,
          timestampIso: new Date(block.timestamp * 1_000).toISOString()
        };
      };
      const [dispatch, lastReturn, lastWriteOff] = await Promise.all([
        proof(created[0]), proof(returns.at(-1)), proof(losses.at(-1))
      ]);
      // The persisted write-off getter is authoritative even when the RPC's
      // event history omits a write-off log. Do not invent a date in that case.
      return {
        status: "available", atBlock: blockNumber,
        deploymentCount: count.toString(),
        completedCycleCount: (count - (BigInt(active) === 0n ? 0n : 1n)).toString(),
        lastDeployment: {
          id: count.toString(), status: Number(last.status),
          principalOut: amount(last.principalAssets), returnedAssets: amount(returned),
          recalledPrincipal: amount(principalReturned), writtenOff: amount(writtenOff),
          dispatch, lastReturn, lastWriteOff
        }
      };
    } catch (error) {
      // A failed historical read must not close withdrawals or invent history.
      return { status: "unavailable", reason: "venue_history_unavailable", atBlock: blockNumber,
        lastError: redactProviderError(error) || "venue_history_read_failed" };
    }
  }
}
