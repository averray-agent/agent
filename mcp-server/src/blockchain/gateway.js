import { Contract, JsonRpcProvider, Wallet, id, keccak256, toUtf8Bytes } from "ethers";
import { AGENT_ACCOUNT_ABI, ERC20_MOCK_ABI, ESCROW_CORE_ABI, REPUTATION_SBT_ABI, TREASURY_POLICY_ABI } from "./abis.js";
import { loadBlockchainConfig } from "./config.js";
import { BlockchainRevertError, ConfigError, ExternalServiceError, InsufficientLiquidityError, ValidationError } from "../core/errors.js";

export class BlockchainGateway {
  constructor(config = loadBlockchainConfig()) {
    this.config = config;
    if (!config.enabled) {
      this.provider = undefined;
      this.signer = undefined;
      this.policyContract = undefined;
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
    this.policyContract = new Contract(
      config.treasuryPolicyAddress,
      TREASURY_POLICY_ABI,
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

  async healthCheck() {
    if (!this.isEnabled()) {
      return {
        ok: true,
        backend: "blockchain",
        enabled: false,
        mode: "disabled"
      };
    }

    try {
      const blockNumber = await this.provider.getBlockNumber();
      return {
        ok: true,
        backend: "blockchain",
        enabled: true,
        blockNumber,
        signerConfigured: Boolean(this.signer)
      };
    } catch (error) {
      return {
        ok: false,
        backend: "blockchain",
        enabled: true,
        signerConfigured: Boolean(this.signer),
        error: this.wrapGatewayError("healthCheck", error).message
      };
    }
  }

  async getAccountSummary(wallet) {
    return this.withGatewayError("getAccountSummary", async () => {
      const liquid = {};
      const reserved = {};
      const strategyAllocated = {};
      const collateralLocked = {};
      const jobStakeLocked = {};
      const debtOutstanding = {};

      for (const asset of this.config.supportedAssets) {
        const position = await this.accountContract.positions(wallet, asset.address);
        liquid[asset.symbol] = Number(position.liquid);
        reserved[asset.symbol] = Number(position.reserved);
        strategyAllocated[asset.symbol] = Number(position.strategyAllocated);
        collateralLocked[asset.symbol] = Number(position.collateralLocked);
        jobStakeLocked[asset.symbol] = Number(position.jobStakeLocked);
        debtOutstanding[asset.symbol] = Number(position.debtOutstanding);
      }

      return {
        wallet,
        liquid,
        reserved,
        strategyAllocated,
        collateralLocked,
        jobStakeLocked,
        debtOutstanding
      };
    });
  }

  async getDefaultClaimStakeBps() {
    return this.withGatewayError("getDefaultClaimStakeBps", async () => Number(await this.policyContract.defaultClaimStakeBps()));
  }

  async fundAccount(wallet, assetSymbol, amount) {
    return this.withGatewayError("fundAccount", async () => {
      this.requireSigner("fundAccount");
      const asset = this.requireAsset(assetSymbol);
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new ValidationError("Funding amount must be greater than zero.");
      }

      const signerAddress = await this.signer.getAddress();
      if (wallet.toLowerCase() !== signerAddress.toLowerCase()) {
        throw new ValidationError(
          `Funding is only supported for the configured signer wallet ${signerAddress}.`
        );
      }

      const token = new Contract(asset.address, ERC20_MOCK_ABI, this.signer);
      const mintTx = await token.mint(signerAddress, parsedAmount);
      await mintTx.wait();
      const approveTx = await token.approve(this.config.agentAccountAddress, parsedAmount);
      await approveTx.wait();
      const depositTx = await this.accountContract.deposit(asset.address, parsedAmount);
      await depositTx.wait();
      return this.getAccountSummary(wallet);
    });
  }

  async ensureClaimStakeLiquidity(assetSymbol, amount) {
    return this.withGatewayError("ensureClaimStakeLiquidity", async () => {
      if (amount <= 0) {
        return true;
      }
      this.requireSigner("ensureClaimStakeLiquidity");
      const asset = this.requireAsset(assetSymbol);
      const signerAddress = await this.signer.getAddress();
      const position = await this.accountContract.positions(signerAddress, asset.address);
      const available = Number(position.liquid);
      if (available < amount) {
        throw new InsufficientLiquidityError(assetSymbol, {
          required: amount,
          available,
          account: signerAddress
        });
      }
      return true;
    });
  }

  async getBorrowCapacity(wallet, assetSymbol) {
    return this.withGatewayError("getBorrowCapacity", async () => {
      const asset = this.requireAsset(assetSymbol);
      const value = await this.accountContract.getBorrowCapacity(wallet, asset.address);
      return Number(value);
    });
  }

  async reserveForJob(wallet, assetSymbol, amount) {
    return this.withGatewayError("reserveForJob", async () => {
      this.requireSigner("reserveForJob");
      const asset = this.requireAsset(assetSymbol);
      const tx = await this.accountContract.reserveForJob(wallet, asset.address, amount);
      await tx.wait();
      return this.getAccountSummary(wallet);
    });
  }

  async allocateIdleFunds(wallet, strategyId, amount) {
    return this.withGatewayError("allocateIdleFunds", async () => {
      this.requireSigner("allocateIdleFunds");
      const tx = await this.accountContract.allocateIdleFunds(wallet, id(strategyId), amount);
      await tx.wait();
      return this.getAccountSummary(wallet);
    });
  }

  async borrow(assetSymbol, amount) {
    return this.withGatewayError("borrow", async () => {
      this.requireSigner("borrow");
      const asset = this.requireAsset(assetSymbol);
      const tx = await this.accountContract.borrow(asset.address, amount);
      await tx.wait();
    });
  }

  async repay(assetSymbol, amount) {
    return this.withGatewayError("repay", async () => {
      this.requireSigner("repay");
      const asset = this.requireAsset(assetSymbol);
      const tx = await this.accountContract.repay(asset.address, amount);
      await tx.wait();
    });
  }

  async claimJob(jobId) {
    return this.withGatewayError("claimJob", async () => {
      this.requireSigner("claimJob");
      const tx = await this.escrowContract.claimJob(this.toJobId(jobId));
      await tx.wait();
    });
  }

  async ensureJob(job, instanceJobId = job.id, claimStakeAmount = 0) {
    return this.withGatewayError("ensureJob", async () => {
      this.requireSigner("ensureJob");
      const asset = this.requireAsset(job.rewardAsset);
      const live = await this.getJob(instanceJobId);
      if (live.state !== 0) {
        return live;
      }

      const totalRequired = Number(job.rewardAmount ?? 0) + Number(claimStakeAmount ?? 0);
      if (totalRequired <= 0) {
        throw new ValidationError(`Job ${job.id} has no fundable reward`);
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
    });
  }

  async submitWork(jobId, evidence) {
    return this.withGatewayError("submitWork", async () => {
      this.requireSigner("submitWork");
      const tx = await this.escrowContract.submitWork(this.toJobId(jobId), keccak256(toUtf8Bytes(evidence)));
      await tx.wait();
    });
  }

  async resolveSinglePayout(jobId, approved, reasonCode, metadataURI) {
    return this.withGatewayError("resolveSinglePayout", async () => {
      this.requireSigner("resolveSinglePayout");
      const tx = await this.escrowContract.resolveSinglePayout(
        this.toJobId(jobId),
        approved,
        this.toReasonCode(reasonCode),
        metadataURI
      );
      await tx.wait();
    });
  }

  async getJob(jobId) {
    return this.withGatewayError("getJob", async () => {
      const job = await this.escrowContract.jobs(this.toJobId(jobId));
      return {
        poster: job.poster,
        worker: job.worker,
        asset: job.asset,
        reward: Number(job.reward),
        claimStake: Number(job.claimStake),
        claimStakeBps: Number(job.claimStakeBps),
        state: Number(job.state),
        claimExpiry: Number(job.claimExpiry)
      };
    });
  }

  async getReputation(wallet) {
    return this.withGatewayError("getReputation", async () => {
      const rep = await this.reputationContract.reputations(wallet);
      return {
        skill: Number(rep.skill),
        reliability: Number(rep.reliability),
        economic: Number(rep.economic)
      };
    });
  }

  requireAsset(symbol) {
    const asset = this.config.supportedAssets.find((candidate) => candidate.symbol === symbol);
    if (!asset) {
      throw new ValidationError(`Unsupported asset symbol: ${symbol}`);
    }
    return asset;
  }

  requireSigner(operation) {
    if (!this.signer) {
      throw new ConfigError(`${operation} requires SIGNER_PRIVATE_KEY`);
    }
  }

  toJobId(jobId) {
    if (typeof jobId === "string" && /^0x[0-9a-fA-F]{64}$/.test(jobId)) {
      return jobId;
    }
    return id(jobId);
  }

  toReasonCode(reasonCode) {
    return id(reasonCode);
  }

  async withGatewayError(operation, action) {
    try {
      return await action();
    } catch (error) {
      throw this.wrapGatewayError(operation, error);
    }
  }

  wrapGatewayError(operation, error) {
    if (error?.name && error.statusCode) {
      return error;
    }

    const reason = this.extractGatewayReason(error);
    const message = `${operation} failed: ${reason}`;

    if (
      `${error?.code ?? ""}`.includes("CALL_EXCEPTION") ||
      /revert|execution reverted|estimateGas|insufficient funds|nonce/i.test(reason)
    ) {
      return new BlockchainRevertError(message, {
        operation,
        rawCode: error?.code,
        rawReason: reason
      });
    }

    return new ExternalServiceError(message, "blockchain_unavailable", {
      operation,
      rawCode: error?.code
    });
  }

  extractGatewayReason(error) {
    return (
      error?.reason ||
      error?.shortMessage ||
      error?.info?.error?.message ||
      error?.info?.payload?.method ||
      error?.message ||
      "unknown_error"
    );
  }
}
