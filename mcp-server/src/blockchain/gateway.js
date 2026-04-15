import { Contract, JsonRpcProvider, Wallet, id, keccak256, toUtf8Bytes, ZeroAddress } from "ethers";
import { AGENT_ACCOUNT_ABI, ERC20_MOCK_ABI, ESCROW_CORE_ABI, REPUTATION_SBT_ABI } from "./abis.js";
import { loadBlockchainConfig } from "./config.js";

export class BlockchainGateway {
  constructor(config = loadBlockchainConfig()) {
    this.config = config;
    if (!config.enabled) {
      this.provider = undefined;
      this.signer = undefined;
      this.accountContract = undefined;
      this.escrowContract = undefined;
      this.reputationContract = undefined;
      return;
    }

    this.provider = new JsonRpcProvider(config.rpcUrl);
    this.signer = config.signerPrivateKey
      ? new Wallet(config.signerPrivateKey, this.provider)
      : undefined;
    this.accountContract = new Contract(
      config.agentAccountAddress,
      AGENT_ACCOUNT_ABI,
      this.signer ?? this.provider
    );
    this.escrowContract = new Contract(
      config.escrowCoreAddress,
      ESCROW_CORE_ABI,
      this.signer ?? this.provider
    );
    this.reputationContract = new Contract(
      config.reputationSbtAddress,
      REPUTATION_SBT_ABI,
      this.provider
    );
  }

  isEnabled() {
    return this.config.enabled;
  }

  async getAccountSummary(wallet) {
    const liquid = {};
    const reserved = {};
    const strategyAllocated = {};
    const collateralLocked = {};
    const debtOutstanding = {};

    for (const asset of this.config.supportedAssets) {
      const position = await this.accountContract.positions(wallet, asset.address);
      liquid[asset.symbol] = Number(position.liquid);
      reserved[asset.symbol] = Number(position.reserved);
      strategyAllocated[asset.symbol] = Number(position.strategyAllocated);
      collateralLocked[asset.symbol] = Number(position.collateralLocked);
      debtOutstanding[asset.symbol] = Number(position.debtOutstanding);
    }

    return {
      wallet,
      liquid,
      reserved,
      strategyAllocated,
      collateralLocked,
      debtOutstanding
    };
  }

  async getBorrowCapacity(wallet, assetSymbol) {
    const asset = this.requireAsset(assetSymbol);
    const value = await this.accountContract.getBorrowCapacity(wallet, asset.address);
    return Number(value);
  }

  async reserveForJob(wallet, assetSymbol, amount) {
    this.requireSigner("reserveForJob");
    const asset = this.requireAsset(assetSymbol);
    const tx = await this.accountContract.reserveForJob(wallet, asset.address, amount);
    await tx.wait();
    return this.getAccountSummary(wallet);
  }

  async allocateIdleFunds(wallet, strategyId, amount) {
    this.requireSigner("allocateIdleFunds");
    const tx = await this.accountContract.allocateIdleFunds(wallet, id(strategyId), amount);
    await tx.wait();
    return this.getAccountSummary(wallet);
  }

  async borrow(assetSymbol, amount) {
    this.requireSigner("borrow");
    const asset = this.requireAsset(assetSymbol);
    const tx = await this.accountContract.borrow(asset.address, amount);
    await tx.wait();
  }

  async repay(assetSymbol, amount) {
    this.requireSigner("repay");
    const asset = this.requireAsset(assetSymbol);
    const tx = await this.accountContract.repay(asset.address, amount);
    await tx.wait();
  }

  async claimJob(jobId) {
    this.requireSigner("claimJob");
    const tx = await this.escrowContract.claimJob(this.toJobId(jobId));
    await tx.wait();
  }

  async ensureJob(job, instanceJobId = job.id) {
    this.requireSigner("ensureJob");
    const asset = this.requireAsset(job.rewardAsset);
    const live = await this.getJob(instanceJobId);
    if (live.state !== 0) {
      return live;
    }

    const totalRequired = Number(job.rewardAmount ?? 0);
    if (totalRequired <= 0) {
      throw new Error(`Job ${job.id} has no fundable reward`);
    }

    const token = new Contract(asset.address, ERC20_MOCK_ABI, this.signer);
    const signerAddress = await this.signer.getAddress();
    const signerPosition = await this.accountContract.positions(signerAddress, asset.address);
    const liquid = Number(signerPosition.liquid);
    const shortfall = Math.max(totalRequired - liquid, 0);

    if (shortfall > 0) {
      const mintTx = await token.mint(signerAddress, shortfall);
      await mintTx.wait();
      const approveTx = await token.approve(this.config.agentAccountAddress, shortfall);
      await approveTx.wait();
      const depositTx = await this.accountContract.deposit(asset.address, shortfall);
      await depositTx.wait();
    }

    const createTx = await this.escrowContract.createSinglePayoutJob(
      this.toJobId(instanceJobId),
      asset.address,
      job.rewardAmount,
      0,
      0,
      job.claimTtlSeconds,
      id(job.verifierMode),
      id(job.category)
    );
    await createTx.wait();
    return this.getJob(instanceJobId);
  }

  async submitWork(jobId, evidence) {
    this.requireSigner("submitWork");
    const tx = await this.escrowContract.submitWork(this.toJobId(jobId), keccak256(toUtf8Bytes(evidence)));
    await tx.wait();
  }

  async resolveSinglePayout(jobId, approved, reasonCode, metadataURI) {
    this.requireSigner("resolveSinglePayout");
    const tx = await this.escrowContract.resolveSinglePayout(
      this.toJobId(jobId),
      approved,
      this.toReasonCode(reasonCode),
      metadataURI
    );
    await tx.wait();
  }

  async getJob(jobId) {
    const job = await this.escrowContract.jobs(this.toJobId(jobId));
    return {
      poster: job.poster,
      worker: job.worker,
      asset: job.asset,
      reward: Number(job.reward),
      state: Number(job.state),
      claimExpiry: Number(job.claimExpiry)
    };
  }

  async getReputation(wallet) {
    const rep = await this.reputationContract.reputations(wallet);
    return {
      skill: Number(rep.skill),
      reliability: Number(rep.reliability),
      economic: Number(rep.economic)
    };
  }

  requireAsset(symbol) {
    const asset = this.config.supportedAssets.find((candidate) => candidate.symbol === symbol);
    if (!asset) {
      throw new Error(`Unsupported asset symbol: ${symbol}`);
    }
    return asset;
  }

  requireSigner(operation) {
    if (!this.signer) {
      throw new Error(`${operation} requires SIGNER_PRIVATE_KEY`);
    }
  }

  toJobId(jobId) {
    return id(jobId);
  }

  toReasonCode(reasonCode) {
    return id(reasonCode);
  }
}
