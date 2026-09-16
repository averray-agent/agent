import { Contract, encodeBytes32String, getAddress } from "ethers";
import { POOL_V22_ABI } from "./pool-v22-commitments.js";

export const AAC_LOCKED_DEPOSIT_POOL_V22 = encodeBytes32String("AAC_LOCKED_DEPOSIT_POOL_V22");
const CORE_ABI = [
  "function registry() view returns (address)",
  "function positions(address,address) view returns (uint256 liquid,uint256 reserved,uint256 strategyAllocated,uint256 collateralLocked,uint256 jobStakeLocked,uint256 debtOutstanding)",
  "function strategyShares(address,bytes32) view returns (uint256)",
  "function allocateIdleFunds(address,bytes32,uint256)",
  "function deallocateIdleFunds(address,bytes32,uint256)"
];
const ADAPTER_ABI = [
  "function pool() view returns (address)",
  "function agentAccountCore() view returns (address)",
  "function asset() view returns (address)",
  "function strategyId() view returns (bytes32)",
  "function totalShares() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function floatAssets() view returns (uint256)",
  "function sweepToPoolAndCommit(uint256,uint64) returns (uint256)",
  "function commitSharedUntil(uint64)",
  "function requestFloatExit(uint256,uint8) returns (uint256)",
  "function fulfilFloatExit(uint256) returns (uint256)",
  "event FloatExitRequested(uint256 indexed requestId,uint256 poolShares,uint8 tier)"
];

export class EvmPoolV22AllocationChain {
  constructor({ provider, signer, config, accountAddress, assetAddress }) {
    this.provider = provider;
    this.signer = signer;
    this.config = config;
    this.accountAddress = getAddress(accountAddress);
    this.assetAddress = getAddress(assetAddress);
    this.core = new Contract(accountAddress, CORE_ABI, provider);
    this.adapter = new Contract(config.adapterAddress, ADAPTER_ABI, provider);
    this.pool = new Contract(config.poolAddress, POOL_V22_ABI, provider);
  }

  async snapshot(wallets) {
    const block = await this.provider.getBlock("latest");
    if (!block?.number || !Number.isSafeInteger(Number(block.timestamp))) throw new Error("pool_v22_block_unreadable");
    const tag = { blockTag: block.number };
    const [boundPool, boundCore, asset, strategy, registryAddress, totalShares, totalAssets, floatAssets,
      poolShares, commitment] = await Promise.all([
      this.adapter.pool(tag), this.adapter.agentAccountCore(tag), this.adapter.asset(tag),
      this.adapter.strategyId(tag), this.core.registry(tag), this.adapter.totalShares(tag),
      this.adapter.totalAssets(tag), this.adapter.floatAssets(tag), this.pool.balanceOf(this.config.adapterAddress, tag),
      this.pool.commitment(this.config.adapterAddress, tag)
    ]);
    const registry = new Contract(registryAddress, [
      "function getStrategy(bytes32) view returns ((bytes32 strategyId,address adapter,address asset,string riskLabel,bool active))"
    ], this.provider);
    const registered = await registry.getStrategy(AAC_LOCKED_DEPOSIT_POOL_V22, tag);
    if (getAddress(boundPool) !== this.config.poolAddress || getAddress(boundCore) !== this.accountAddress
      || getAddress(asset) !== this.assetAddress || strategy !== AAC_LOCKED_DEPOSIT_POOL_V22
      || getAddress(registered.adapter) !== this.config.adapterAddress || !registered.active) {
      throw new Error("pool_v22_binding_mismatch");
    }
    const accounts = Object.fromEntries(await Promise.all([...new Set(wallets.map((w) => w.toLowerCase()))].map(async (wallet) => {
      const [position, shares] = await Promise.all([
        this.core.positions(wallet, asset, tag), this.core.strategyShares(wallet, strategy, tag)
      ]);
      return [wallet, { liquidRaw: String(position.liquid), strategyAllocatedRaw: String(position.strategyAllocated),
        debtRaw: String(position.debtOutstanding), sharesRaw: String(shares) }];
    })));
    return { blockNumber: block.number, now: Number(block.timestamp), committedUntil: Number(commitment.committedUntil),
      totalSharesRaw: String(totalShares), totalAssetsRaw: String(totalAssets), floatRaw: String(floatAssets),
      poolSharesRaw: String(poolShares), accounts };
  }

  async allocate(wallet, amount) {
    return this.#send(this.core.connect(this.signer).allocateIdleFunds(wallet, AAC_LOCKED_DEPOSIT_POOL_V22, amount));
  }
  async sweep(amount, until) {
    return this.#send(this.adapter.connect(this.signer).sweepToPoolAndCommit(amount, until));
  }
  async commit(until) { return this.#send(this.adapter.connect(this.signer).commitSharedUntil(until)); }
  async requestExit(shares) {
    const receipt = await this.#send(this.adapter.connect(this.signer).requestFloatExit(shares, 0));
    for (const log of receipt.logs) {
      try {
        const event = this.adapter.interface.parseLog(log);
        if (event?.name === "FloatExitRequested") return { requestId: String(event.args.requestId) };
      } catch { /* unrelated log */ }
    }
    throw new Error("pool_v22_exit_receipt_unreadable");
  }
  async readExit(id) {
    const result = await this.pool.redeemRequests(id);
    if (getAddress(result.owner) !== this.config.adapterAddress || getAddress(result.receiver) !== this.config.adapterAddress) {
      throw new Error("pool_v22_exit_binding_mismatch");
    }
    return { unlockAt: Number(result.unlockAt), fulfilled: result.fulfilled };
  }
  async fulfilExit(id) { return this.#send(this.adapter.connect(this.signer).fulfilFloatExit(id)); }
  async deallocate(wallet, amount) {
    return this.#send(this.core.connect(this.signer).deallocateIdleFunds(wallet, AAC_LOCKED_DEPOSIT_POOL_V22, amount));
  }
  async #send(promise) {
    if (!this.signer) throw new Error("pool_v22_signer_unavailable");
    const tx = await promise;
    const receipt = await tx.wait();
    if (Number(receipt?.status) !== 1) throw new Error("pool_v22_transaction_failed");
    return receipt;
  }
}
