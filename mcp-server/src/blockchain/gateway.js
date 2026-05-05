import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  Wallet,
  decodeBytes32String,
  encodeBytes32String,
  formatUnits,
  id,
  keccak256,
  parseUnits,
  toUtf8Bytes
} from "ethers";
import {
  AGENT_ACCOUNT_ABI,
  ERC20_MOCK_ABI,
  ESCROW_CORE_ABI,
  ESCROW_CORE_LEGACY_ABI,
  REPUTATION_SBT_ABI,
  STRATEGY_ADAPTER_ABI,
  TREASURY_POLICY_ABI,
  XCM_WRAPPER_ABI,
  ZERO_BYTES32
} from "./abis.js";
import { loadBlockchainConfig } from "./config.js";
import { buildXcmRequestPayload } from "./xcm-message-builder.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import {
  BlockchainRevertError,
  ConfigError,
  ExternalServiceError,
  InsufficientLiquidityError,
  NotFoundError,
  ValidationError
} from "../core/errors.js";

const REQUEST_KIND_LABELS = ["deposit", "withdraw", "claim"];
const REQUEST_STATUS_LABELS = ["unknown", "pending", "succeeded", "failed", "cancelled"];
const abiCoder = AbiCoder.defaultAbiCoder();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class BlockchainGateway {
  constructor(config = loadBlockchainConfig()) {
    this.config = config;
    if (!config.enabled) {
      this.provider = undefined;
      this.signer = undefined;
      this.policyContract = undefined;
      this.accountContract = undefined;
      this.escrowContract = undefined;
      this.legacyEscrowContract = undefined;
      this.reputationContract = undefined;
      this.xcmWrapperContract = undefined;
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
    this.legacyEscrowContract = new Contract(
      config.escrowCoreAddress,
      ESCROW_CORE_LEGACY_ABI,
      this.signer ?? this.provider
    );
    this.reputationContract = new Contract(
      config.reputationSbtAddress,
      REPUTATION_SBT_ABI,
      this.provider
    );
    this.xcmWrapperContract = config.xcmWrapperAddress
      ? new Contract(
          config.xcmWrapperAddress,
          XCM_WRAPPER_ABI,
          this.signer ?? this.provider
        )
      : undefined;
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
        signerConfigured: Boolean(this.signer),
        xcmWrapperConfigured: this.hasXcmWrapper()
      };
    } catch (error) {
      return {
        ok: false,
        backend: "blockchain",
        enabled: true,
        signerConfigured: Boolean(this.signer),
        xcmWrapperConfigured: this.hasXcmWrapper(),
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

  normalizeStrategyId(strategyId) {
    if (typeof strategyId === "string" && /^0x[a-fA-F0-9]{64}$/u.test(strategyId)) {
      return strategyId;
    }
    return id(String(strategyId ?? ""));
  }

  async getStrategyPositions(wallet, strategies = []) {
    return this.withGatewayError("getStrategyPositions", async () => {
      const entries = [];
      for (const strategy of strategies) {
        const normalizedStrategyId = this.normalizeStrategyId(strategy.strategyId);
        const [rawShares, rawPendingWithdrawalShares, rawPendingDepositAssets] = await Promise.all([
          this.accountContract.strategyShares(wallet, normalizedStrategyId),
          this.accountContract.pendingStrategyWithdrawalShares(wallet, normalizedStrategyId),
          strategy.asset
            ? this.accountContract.pendingStrategyAssets(wallet, strategy.asset)
            : Promise.resolve(0n)
        ]);
        entries.push({
          strategyId: strategy.strategyId,
          shares: Number(rawShares),
          pendingWithdrawalShares: Number(rawPendingWithdrawalShares),
          pendingDepositAssets: Number(rawPendingDepositAssets)
        });
      }
      return entries;
    });
  }

  async getStrategyTelemetry(strategies = []) {
    if (!this.isEnabled()) {
      return [];
    }

    return Promise.all(
      strategies.map(async (strategy) => {
        const adapterContract = new Contract(strategy.adapter, STRATEGY_ADAPTER_ABI, this.provider);
        try {
          const [rawTotalAssets, rawTotalShares, liveRiskLabel] = await Promise.all([
            adapterContract.totalAssets(),
            adapterContract.totalShares().catch(() => undefined),
            adapterContract.riskLabel().catch(() => strategy.riskLabel ?? "")
          ]);
          const totalAssets = Number(rawTotalAssets ?? 0);
          const totalShares = Number(rawTotalShares ?? 0);
          const sharePrice = totalShares > 0 ? totalAssets / totalShares : undefined;
          const performanceBps = Number.isFinite(sharePrice)
            ? Math.round((sharePrice - 1) * 10_000)
            : undefined;
          return {
            strategyId: strategy.strategyId,
            adapter: strategy.adapter,
            totalAssets,
            totalShares,
            sharePrice,
            performanceBps,
            riskLabel: liveRiskLabel,
            reported: Number.isFinite(sharePrice)
          };
        } catch (error) {
          return {
            strategyId: strategy.strategyId,
            adapter: strategy.adapter,
            reported: false,
            error: this.wrapGatewayError("getStrategyTelemetry", error).message
          };
        }
      })
    );
  }

  async getDefaultClaimStakeBps() {
    return this.withGatewayError("getDefaultClaimStakeBps", async () => Number(await this.policyContract.defaultClaimStakeBps()));
  }

  async getClaimEconomicsConfig() {
    return this.withGatewayError("getClaimEconomicsConfig", async () => {
      const optional = async (promise, fallback) => promise.catch(() => fallback);
      const [claimFeeBps, claimFeeVerifierBps, onboardingWaiverClaimCount] = await Promise.all([
        optional(this.policyContract.claimFeeBps(), 0),
        optional(this.policyContract.claimFeeVerifierBps(), 7000),
        optional(this.policyContract.onboardingWaiverClaimCount(), 0)
      ]);
      const minClaimFeeByAsset = {};
      await Promise.all((this.config.supportedAssets ?? []).map(async (asset) => {
        const symbol = asset.symbol ?? this.resolveAssetSymbol(asset.address);
        minClaimFeeByAsset[symbol] = this.toDisplayUnits(
          await optional(this.policyContract.minClaimFeeByAsset(asset.address), 0),
          asset
        );
      }));
      return {
        claimFeeBps: Number(claimFeeBps),
        claimFeeVerifierBps: Number(claimFeeVerifierBps),
        onboardingWaiverClaimCount: Number(onboardingWaiverClaimCount),
        minClaimFeeByAsset
      };
    });
  }

  async getTreasuryPolicyStatus() {
    return this.withGatewayError("getTreasuryPolicyStatus", async () => {
      if (!this.isEnabled()) {
        return {
          enabled: false,
          policyAddress: this.config.treasuryPolicyAddress || undefined,
          paused: undefined,
          owner: undefined,
          pauser: undefined,
          risk: {}
        };
      }

      const [
        owner,
        pauser,
        paused,
        dailyOutflowCap,
        perAccountBorrowCap,
        minimumCollateralRatioBps,
        defaultClaimStakeBps,
        claimFeeBps,
        claimFeeVerifierBps,
        onboardingWaiverClaimCount,
        rejectionSkillPenalty,
        rejectionReliabilityPenalty,
        disputeLossSkillPenalty,
        disputeLossReliabilityPenalty
      ] = await Promise.all([
        this.policyContract.owner(),
        this.policyContract.pauser(),
        this.policyContract.paused(),
        this.policyContract.dailyOutflowCap(),
        this.policyContract.perAccountBorrowCap(),
        this.policyContract.minimumCollateralRatioBps(),
        this.policyContract.defaultClaimStakeBps(),
        this.policyContract.claimFeeBps().catch(() => 0),
        this.policyContract.claimFeeVerifierBps().catch(() => 7000),
        this.policyContract.onboardingWaiverClaimCount().catch(() => 0),
        this.policyContract.rejectionSkillPenalty(),
        this.policyContract.rejectionReliabilityPenalty(),
        this.policyContract.disputeLossSkillPenalty(),
        this.policyContract.disputeLossReliabilityPenalty()
      ]);

      return {
        enabled: true,
        policyAddress: this.config.treasuryPolicyAddress,
        paused: Boolean(paused),
        owner,
        pauser,
        risk: {
          dailyOutflowCap: Number(dailyOutflowCap),
          perAccountBorrowCap: Number(perAccountBorrowCap),
          minimumCollateralRatioBps: Number(minimumCollateralRatioBps),
          defaultClaimStakeBps: Number(defaultClaimStakeBps),
          claimFeeBps: Number(claimFeeBps),
          claimFeeVerifierBps: Number(claimFeeVerifierBps),
          onboardingWaiverClaimCount: Number(onboardingWaiverClaimCount),
          rejectionSkillPenalty: Number(rejectionSkillPenalty),
          rejectionReliabilityPenalty: Number(rejectionReliabilityPenalty),
          disputeLossSkillPenalty: Number(disputeLossSkillPenalty),
          disputeLossReliabilityPenalty: Number(disputeLossReliabilityPenalty)
        }
      };
    });
  }

  async fundAccount(wallet, assetSymbol, amount) {
    return this.withGatewayError("fundAccount", async () => {
      this.requireSigner("fundAccount");
      const asset = this.requireAsset(assetSymbol);
      const parsedAmount = this.toBaseUnits(amount, asset, "funding amount");
      if (parsedAmount <= 0n) {
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
      const required = this.toBaseUnits(amount, asset, "claim lock amount");
      const signerAddress = await this.signer.getAddress();
      const position = await this.accountContract.positions(signerAddress, asset.address);
      const available = BigInt(position.liquid);
      if (available < required) {
        throw new InsufficientLiquidityError(assetSymbol, {
          required: amount,
          available: this.toDisplayUnits(available, asset),
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

  async reserveRecurringTemplateFunding(wallet, assetSymbol, amount, templateId) {
    return this.withGatewayError("reserveRecurringTemplateFunding", async () => {
      this.requireSigner("reserveRecurringTemplateFunding");
      const asset = this.requireAsset(assetSymbol);
      const templateKey = this.toJobId(templateId);
      const baseAmount = this.toBaseUnits(amount, asset, "recurring reserve amount");
      const tx = await this.accountContract.reserveForRecurringTemplate(wallet, asset.address, templateKey, baseAmount);
      await tx.wait();
      return {
        wallet,
        asset: asset.symbol,
        amount: this.toDisplayUnits(baseAmount, asset),
        amountRaw: baseAmount.toString(),
        templateId,
        templateKey,
        source: "agent_account_recurring_template_reserve"
      };
    });
  }

  async allocateIdleFunds(wallet, strategyId, amount) {
    return this.withGatewayError("allocateIdleFunds", async () => {
      this.requireSigner("allocateIdleFunds");
      const tx = await this.accountContract.allocateIdleFunds(wallet, this.normalizeStrategyId(strategyId), amount);
      await tx.wait();
      return this.getAccountSummary(wallet);
    });
  }

  async deallocateIdleFunds(wallet, strategyId, amount, assetSymbol = "DOT") {
    return this.withGatewayError("deallocateIdleFunds", async () => {
      this.requireSigner("deallocateIdleFunds");
      const asset = this.requireAsset(assetSymbol);
      const before = await this.getAccountSummary(wallet);
      const tx = await this.accountContract.deallocateIdleFunds(wallet, this.normalizeStrategyId(strategyId), amount);
      await tx.wait();
      const after = await this.getAccountSummary(wallet);
      return {
        ...after,
        returnedAmount: Math.max(
          Number(after.liquid?.[asset.symbol] ?? 0) - Number(before.liquid?.[asset.symbol] ?? 0),
          0
        )
      };
    });
  }

  async requestStrategyDeposit(wallet, strategy, amount, { maxWeight = undefined, nonce = Date.now() } = {}) {
    return this.withGatewayError("requestStrategyDeposit", async () => {
      this.requireSigner("requestStrategyDeposit");
      this.requireAsyncStrategyConfig(strategy, "requestStrategyDeposit");
      const requestId = this.previewStrategyRequestId({
        strategyId: strategy.strategyId,
        kind: 0,
        account: wallet,
        asset: strategy.asset,
        recipient: wallet,
        assets: amount,
        shares: 0,
        nonce
      });
      const payload = buildXcmRequestPayload({
        strategy,
        direction: "deposit",
        requestId,
        account: wallet,
        recipient: wallet,
        amount
      });
      const tx = await this.accountContract.requestStrategyDeposit(wallet, {
        strategyId: this.normalizeStrategyId(strategy.strategyId),
        amount,
        destination: payload.destination,
        message: payload.message,
        maxWeight: this.normalizeWeight(maxWeight ?? payload.maxWeight),
        nonce
      });
      await tx.wait();
      return {
        ...(await this.getAccountSummary(wallet)),
        requestId,
        xcmRequest: await this.getXcmRequest(requestId),
        strategyRequest: await this.getStrategyRequest(requestId)
      };
    });
  }

  async requestStrategyWithdraw(wallet, strategy, amount, {
    recipient = this.config.agentAccountAddress,
    maxWeight = undefined,
    nonce = Date.now(),
    requestedShares = undefined
  } = {}) {
    return this.withGatewayError("requestStrategyWithdraw", async () => {
      this.requireSigner("requestStrategyWithdraw");
      this.requireAsyncStrategyConfig(strategy, "requestStrategyWithdraw");
      const shares = Number.isFinite(Number(requestedShares)) && Number(requestedShares) > 0
        ? Number(requestedShares)
        : await this.quoteStrategySharesForAssets(strategy, amount);
      const requestId = this.previewStrategyRequestId({
        strategyId: strategy.strategyId,
        kind: 1,
        account: wallet,
        asset: strategy.asset,
        recipient,
        assets: 0,
        shares,
        nonce
      });
      const payload = buildXcmRequestPayload({
        strategy,
        direction: "withdraw",
        requestId,
        account: wallet,
        recipient,
        amount,
        shares
      });
      const tx = await this.accountContract.requestStrategyWithdraw(wallet, {
        strategyId: this.normalizeStrategyId(strategy.strategyId),
        shares,
        recipient,
        destination: payload.destination,
        message: payload.message,
        maxWeight: this.normalizeWeight(maxWeight ?? payload.maxWeight),
        nonce
      });
      await tx.wait();
      return {
        ...(await this.getAccountSummary(wallet)),
        requestId,
        requestedShares: shares,
        requestedAssets: amount,
        xcmRequest: await this.getXcmRequest(requestId),
        strategyRequest: await this.getStrategyRequest(requestId)
      };
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

  /**
   * Relay an agent-to-agent transfer via the operator-gated primitive
   * on AgentAccountCore (sendToAgentFor). The backend signer must be on
   * the TreasuryPolicy service-operators list. See
   * contracts/AgentAccountCore.sol#sendToAgentFor for the contract-level
   * permission model.
   */
  async sendToAgent(from, recipient, assetSymbol, amount) {
    return this.withGatewayError("sendToAgent", async () => {
      this.requireSigner("sendToAgent");
      const asset = this.requireAsset(assetSymbol);
      const tx = await this.accountContract.sendToAgentFor(from, recipient, asset.address, amount);
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

  async handleClaimTimeout(jobId) {
    return this.withGatewayError("handleClaimTimeout", async () => {
      this.requireSigner("handleClaimTimeout");
      const tx = await this.escrowContract.handleClaimTimeout(this.toJobId(jobId));
      await tx.wait();
    });
  }

  async previewClaimEconomics(wallet, jobId) {
    return this.withGatewayError("previewClaimEconomics", async () => {
      const economics = await this.escrowContract.previewClaimEconomics(wallet, this.toJobId(jobId));
      const live = await this.readEscrowJob(jobId);
      const asset = this.assetForAddress(live.asset);
      const claimStake = this.toDisplayUnits(economics.claimStake, asset);
      const claimFee = this.toDisplayUnits(economics.claimFee, asset);
      return {
        claimStake,
        claimStakeRaw: economics.claimStake?.toString?.() ?? String(economics.claimStake),
        claimStakeBps: Number(economics.claimStakeBps),
        claimFee,
        claimFeeRaw: economics.claimFee?.toString?.() ?? String(economics.claimFee),
        claimFeeBps: Number(economics.claimFeeBps),
        claimEconomicsWaived: Boolean(economics.waived),
        claimNumber: Number(economics.claimNumber),
        totalClaimLock: this.toDisplayUnits(BigInt(economics.claimStake) + BigInt(economics.claimFee), asset)
      };
    });
  }

  async ensureJob(job, instanceJobId = job.id, claimStakeAmount = 0) {
    return this.withGatewayError("ensureJob", async () => {
      this.requireSigner("ensureJob");
      const asset = this.requireAsset(job.rewardAsset);
      const live = await this.readEscrowJob(instanceJobId);
      if (live.state !== 0) {
        return this.publicEscrowJob(live);
      }

      const rewardAmount = this.toBaseUnits(job.rewardAmount ?? 0, asset, "job reward");
      const claimStake = this.toBaseUnits(claimStakeAmount ?? 0, asset, "claim lock amount");
      const usesRecurringTemplateReserve = this.usesRecurringTemplateReserve(job);
      const totalRequired = usesRecurringTemplateReserve ? rewardAmount : rewardAmount + claimStake;
      if (totalRequired <= 0n) {
        throw new ValidationError(`Job ${job.id} has no fundable reward`);
      }

      const token = new Contract(asset.address, ERC20_MOCK_ABI, this.signer);
      const signerAddress = await this.signer.getAddress();
      const signerPosition = usesRecurringTemplateReserve
        ? { liquid: 0n }
        : await this.accountContract.positions(signerAddress, asset.address);
      const liquid = BigInt(signerPosition.liquid);
      const shortfall = !usesRecurringTemplateReserve && totalRequired > liquid ? totalRequired - liquid : 0n;

      if (!usesRecurringTemplateReserve && shortfall > 0n) {
        const mintTx = await token.mint(signerAddress, shortfall);
        await mintTx.wait();
        const approveTx = await token.approve(this.config.agentAccountAddress, shortfall);
        await approveTx.wait();
        const depositTx = await this.accountContract.deposit(asset.address, shortfall);
        await depositTx.wait();
      }

      const specHash = hashCanonicalContent(job);
      const createTx = await this.createSinglePayoutJobForJob(
        job,
        live.contractLayout,
        this.toJobId(instanceJobId),
        asset.address,
        rewardAmount,
        0,
        0,
        job.claimTtlSeconds,
        id(job.verifierMode),
        id(job.category),
        specHash
      );
      await createTx.wait();
      return this.getJob(instanceJobId);
    });
  }

  usesRecurringTemplateReserve(job) {
    return job?.funding?.source === "recurring_template_reserve"
      && Boolean(job?.funding?.wallet)
      && Boolean(job?.funding?.templateId);
  }

  async submitWork(jobId, evidence) {
    return this.withGatewayError("submitWork", async () => {
      this.requireSigner("submitWork");
      const evidenceHash = typeof evidence === "string" && /^0x[a-fA-F0-9]{64}$/u.test(evidence)
        ? evidence
        : hashCanonicalContent(evidence);
      const tx = await this.escrowContract.submitWork(this.toJobId(jobId), evidenceHash);
      await tx.wait();
    });
  }

  async resolveSinglePayout(jobId, approved, reasonCode, metadataURI, reasoningHash = ZERO_BYTES32) {
    return this.withGatewayError("resolveSinglePayout", async () => {
      this.requireSigner("resolveSinglePayout");
      const tx = await this.escrowContract.resolveSinglePayout(
        this.toJobId(jobId),
        approved,
        this.toReasonCode(reasonCode),
        metadataURI,
        reasoningHash
      );
      await tx.wait();
    });
  }

  async resolveDispute(jobId, workerPayout, reasonCode, metadataURI = "") {
    return this.withGatewayError("resolveDispute", async () => {
      this.requireSigner("resolveDispute");
      const tx = await this.escrowContract.resolveDispute(
        this.toJobId(jobId),
        workerPayout,
        this.toDisputeReasonCode(reasonCode),
        metadataURI
      );
      const receipt = await tx.wait();
      return {
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        status: Number(receipt?.status ?? 0)
      };
    });
  }

  async discloseContent(hash, byWallet = undefined) {
    return this.withGatewayError("discloseContent", async () => {
      this.requireSigner("discloseContent");
      const normalizedHash = this.toContentHash(hash);
      const tx = byWallet
        ? await this.escrowContract.discloseFor(normalizedHash, byWallet)
        : await this.escrowContract.disclose(normalizedHash);
      const receipt = await tx.wait();
      return {
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        status: Number(receipt?.status ?? 0)
      };
    });
  }

  async autoDiscloseContent(hash) {
    return this.withGatewayError("autoDiscloseContent", async () => {
      this.requireSigner("autoDiscloseContent");
      const normalizedHash = this.toContentHash(hash);
      if (await this.escrowContract.autoDisclosed(normalizedHash)) {
        return { skipped: true, reason: "already_auto_disclosed" };
      }
      const tx = await this.escrowContract.autoDisclose(normalizedHash);
      const receipt = await tx.wait();
      return {
        skipped: false,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        status: Number(receipt?.status ?? 0)
      };
    });
  }

  async readEscrowJob(jobId) {
    const normalizedJobId = this.toJobId(jobId);
    try {
      return this.normalizeEscrowJob(await this.escrowContract.jobs(normalizedJobId), "rc1");
    } catch (error) {
      if (!this.isEscrowJobDecodeError(error) || !this.legacyEscrowContract) {
        throw error;
      }
      return this.normalizeEscrowJob(await this.legacyEscrowContract.jobs(normalizedJobId), "legacy");
    }
  }

  normalizeEscrowJob(job, contractLayout) {
    const asset = this.assetForAddress(job.asset);
    return {
      contractLayout,
      poster: job.poster,
      worker: job.worker,
      asset: job.asset,
      specHash: job.specHash ?? ZERO_BYTES32,
      reward: this.toDisplayUnits(job.reward, asset),
      rewardRaw: job.reward?.toString?.() ?? String(job.reward),
      claimStake: this.toDisplayUnits(job.claimStake, asset),
      claimStakeRaw: job.claimStake?.toString?.() ?? String(job.claimStake),
      claimStakeBps: Number(job.claimStakeBps),
      claimFee: this.toDisplayUnits(job.claimFee ?? 0, asset),
      claimFeeRaw: job.claimFee?.toString?.() ?? "0",
      claimFeeBps: Number(job.claimFeeBps ?? 0),
      claimEconomicsWaived: Boolean(job.claimEconomicsWaived ?? false),
      rejectingVerifier: job.rejectingVerifier ?? ZERO_ADDRESS,
      released: this.toDisplayUnits(job.released, asset),
      releasedRaw: job.released?.toString?.() ?? String(job.released),
      state: Number(job.state),
      claimExpiry: Number(job.claimExpiry),
      rejectedAt: Number(job.rejectedAt ?? 0),
      disputedAt: Number(job.disputedAt ?? 0)
    };
  }

  publicEscrowJob(job) {
    const { contractLayout: _contractLayout, ...publicJob } = job;
    return publicJob;
  }

  async createSinglePayoutJobForLayout(
    contractLayout,
    jobId,
    assetAddress,
    reward,
    opsReserve,
    contingencyReserve,
    claimTtl,
    verifierMode,
    category,
    specHash
  ) {
    if (contractLayout === "legacy") {
      return this.legacyEscrowContract.createSinglePayoutJob(
        jobId,
        assetAddress,
        reward,
        opsReserve,
        contingencyReserve,
        claimTtl,
        verifierMode,
        category
      );
    }
    return this.escrowContract.createSinglePayoutJob(
      jobId,
      assetAddress,
      reward,
      opsReserve,
      contingencyReserve,
      claimTtl,
      verifierMode,
      category,
      specHash
    );
  }

  async createSinglePayoutJobForJob(
    job,
    contractLayout,
    jobId,
    assetAddress,
    reward,
    opsReserve,
    contingencyReserve,
    claimTtl,
    verifierMode,
    category,
    specHash
  ) {
    const funding = job?.funding;
    if (
      contractLayout !== "legacy"
      && funding?.source === "recurring_template_reserve"
      && funding?.wallet
      && funding?.templateId
    ) {
      return this.escrowContract.createSinglePayoutJobFromRecurringReserve({
        jobId,
        templateId: this.toJobId(funding.templateId),
        poster: funding.wallet,
        asset: assetAddress,
        reward,
        opsReserve,
        contingencyReserve,
        claimTtl,
        verifierMode,
        category,
        specHash
      });
    }
    return this.createSinglePayoutJobForLayout(
      contractLayout,
      jobId,
      assetAddress,
      reward,
      opsReserve,
      contingencyReserve,
      claimTtl,
      verifierMode,
      category,
      specHash
    );
  }

  isEscrowJobDecodeError(error) {
    const code = String(error?.code ?? "");
    const message = `${error?.shortMessage ?? ""} ${error?.message ?? ""}`;
    return code === "BAD_DATA" || /could not decode result data|decode result data|invalid length/u.test(message);
  }

  async getJob(jobId) {
    return this.withGatewayError("getJob", async () => {
      return this.publicEscrowJob(await this.readEscrowJob(jobId));
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

  hasXcmWrapper() {
    return Boolean(this.xcmWrapperContract);
  }

  async getXcmRequest(requestId) {
    return this.withGatewayError("getXcmRequest", async () => {
      const contract = this.requireXcmWrapper("getXcmRequest");
      const normalizedRequestId = this.toRequestId(requestId);
      const record = await contract.getRequest(normalizedRequestId);
      if (!record?.context?.account || record.context.account === "0x0000000000000000000000000000000000000000") {
        throw new NotFoundError(`XCM request ${normalizedRequestId} not found.`, "xcm_request_not_found");
      }
      return {
        requestId: normalizedRequestId,
        strategyId: record.context.strategyId,
        strategyIdLabel: this.decodeBytes32Label(record.context.strategyId),
        kind: Number(record.context.kind),
        kindLabel: REQUEST_KIND_LABELS[Number(record.context.kind)] ?? "unknown",
        account: record.context.account,
        asset: record.context.asset,
        assetSymbol: this.resolveAssetSymbol(record.context.asset),
        recipient: record.context.recipient,
        requestedAssets: Number(record.context.assets),
        requestedShares: Number(record.context.shares),
        nonce: Number(record.context.nonce),
        status: Number(record.status),
        statusLabel: REQUEST_STATUS_LABELS[Number(record.status)] ?? "unknown",
        settledAssets: Number(record.settledAssets),
        settledShares: Number(record.settledShares),
        remoteRef: this.normalizeOptionalBytes32(record.remoteRef),
        remoteRefLabel: this.decodeBytes32Label(record.remoteRef),
        failureCode: this.normalizeOptionalBytes32(record.failureCode),
        failureCodeLabel: this.decodeBytes32Label(record.failureCode),
        createdAt: Number(record.createdAt),
        updatedAt: Number(record.updatedAt)
      };
    });
  }

  async getStrategyRequest(requestId) {
    return this.withGatewayError("getStrategyRequest", async () => {
      const normalizedRequestId = this.toRequestId(requestId);
      const record = await this.accountContract.strategyRequests(normalizedRequestId);
      if (!record?.account || record.account === "0x0000000000000000000000000000000000000000") {
        throw new NotFoundError(`Strategy request ${normalizedRequestId} not found.`, "strategy_request_not_found");
      }
      return {
        requestId: normalizedRequestId,
        strategyId: record.strategyId,
        strategyIdLabel: this.decodeBytes32Label(record.strategyId),
        adapter: record.adapter,
        account: record.account,
        asset: record.asset,
        assetSymbol: this.resolveAssetSymbol(record.asset),
        recipient: record.recipient,
        kind: Number(record.kind),
        kindLabel: REQUEST_KIND_LABELS[Number(record.kind)] ?? "unknown",
        status: Number(record.status),
        statusLabel: REQUEST_STATUS_LABELS[Number(record.status)] ?? "unknown",
        requestedAssets: Number(record.requestedAssets),
        requestedShares: Number(record.requestedShares),
        settledAssets: Number(record.settledAssets),
        settledShares: Number(record.settledShares),
        remoteRef: this.normalizeOptionalBytes32(record.remoteRef),
        remoteRefLabel: this.decodeBytes32Label(record.remoteRef),
        failureCode: this.normalizeOptionalBytes32(record.failureCode),
        failureCodeLabel: this.decodeBytes32Label(record.failureCode),
        settled: Boolean(record.settled)
      };
    });
  }

  async finalizeXcmRequest(requestId, {
    status,
    settledAssets = 0,
    settledShares = 0,
    remoteRef = ZERO_BYTES32,
    failureCode = ZERO_BYTES32
  } = {}) {
    return this.withGatewayError("finalizeXcmRequest", async () => {
      this.requireSigner("finalizeXcmRequest");
      const normalizedRequestId = this.toRequestId(requestId);
      const normalizedStatus = this.toXcmStatus(status);
      const normalizedRemoteRef = this.toBytes32Value(remoteRef, "remoteRef");
      const normalizedFailureCode = this.toBytes32Value(failureCode, "failureCode");
      let strategyRequest;
      try {
        strategyRequest = await this.getStrategyRequest(normalizedRequestId);
      } catch (error) {
        if (error?.code !== "strategy_request_not_found") {
          throw error;
        }
      }

      const tx = strategyRequest
        ? await this.accountContract.settleStrategyRequest(
            normalizedRequestId,
            normalizedStatus,
            settledAssets,
            settledShares,
            normalizedRemoteRef,
            normalizedFailureCode
          )
        : await this.requireXcmWrapper("finalizeXcmRequest").finalizeRequest(
            normalizedRequestId,
            normalizedStatus,
            settledAssets,
            settledShares,
            normalizedRemoteRef,
            normalizedFailureCode
          );
      await tx.wait();
      return {
        ...(await this.getXcmRequest(normalizedRequestId)),
        strategyRequest: await this.getStrategyRequest(normalizedRequestId).catch(() => undefined),
        settledVia: strategyRequest ? "agent_account" : "xcm_wrapper"
      };
    });
  }

  requireAsset(symbol) {
    const asset = (this.config.supportedAssets ?? []).find((candidate) => candidate.symbol === symbol);
    if (!asset) {
      throw new ValidationError(`Unsupported asset symbol: ${symbol}`);
    }
    return asset;
  }

  assetForAddress(assetAddress) {
    const match = (this.config.supportedAssets ?? []).find(
      (asset) => asset.address?.toLowerCase() === assetAddress?.toLowerCase?.()
    );
    return match ?? { symbol: this.resolveAssetSymbol(assetAddress), address: assetAddress, decimals: 18 };
  }

  assetDecimals(asset) {
    const decimals = Number(asset?.decimals ?? 18);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
      throw new ValidationError(`Asset ${asset?.symbol ?? asset?.address ?? "unknown"} decimals must be an integer in [0, 30].`);
    }
    return decimals;
  }

  toBaseUnits(amount, asset, label = "amount") {
    if (typeof amount === "bigint") {
      if (amount < 0n) throw new ValidationError(`${label} must be non-negative.`);
      return amount;
    }
    const decimals = this.assetDecimals(asset);
    const normalized = this.normalizeDecimalAmount(amount, decimals, label);
    try {
      return parseUnits(normalized, decimals);
    } catch {
      throw new ValidationError(`${label} must fit ${decimals} decimal places for ${asset?.symbol ?? "asset"}.`);
    }
  }

  toDisplayUnits(amount, asset) {
    return Number(formatUnits(amount ?? 0, this.assetDecimals(asset)));
  }

  normalizeDecimalAmount(amount, decimals, label) {
    const value = typeof amount === "string" ? amount.trim() : String(amount ?? "");
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new ValidationError(`${label} must be a non-negative finite number.`);
    }
    if (!value || /e/i.test(value)) {
      return numeric.toFixed(decimals).replace(/\.?0+$/u, "") || "0";
    }
    const [whole, fraction = ""] = value.split(".");
    if (!/^\d+$/u.test(whole || "0") || !/^\d*$/u.test(fraction)) {
      throw new ValidationError(`${label} must be a decimal number.`);
    }
    if (fraction.length <= decimals) {
      return value;
    }
    return numeric.toFixed(decimals).replace(/\.?0+$/u, "") || "0";
  }

  requireAsyncStrategyConfig(strategy, operation) {
    if (!strategy?.strategyId || !strategy?.adapter || !strategy?.asset) {
      throw new ValidationError(`${operation} requires a strategy with strategyId, adapter, and asset metadata.`);
    }
  }

  resolveAssetSymbol(assetAddress) {
    if (!assetAddress) {
      return "DOT";
    }
    const match = (this.config.supportedAssets ?? []).find((asset) => asset.address?.toLowerCase() === assetAddress.toLowerCase());
    return match?.symbol ?? "DOT";
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

  toDisputeReasonCode(reasonCode) {
    return this.toBytes32Value(reasonCode, "reasonCode");
  }

  toRequestId(requestId) {
    if (typeof requestId !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(requestId)) {
      throw new ValidationError("requestId must be a 0x-prefixed 32-byte hex string.");
    }
    return requestId;
  }

  toContentHash(hash) {
    if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) {
      throw new ValidationError("content hash must be a 0x-prefixed 32-byte hex string.");
    }
    return hash.toLowerCase();
  }

  toXcmStatus(status) {
    if (typeof status === "number" && Number.isInteger(status) && status >= 2 && status <= 4) {
      return status;
    }
    if (typeof status === "string") {
      const normalized = status.trim().toLowerCase();
      const index = REQUEST_STATUS_LABELS.indexOf(normalized);
      if (index >= 2) {
        return index;
      }
    }
    throw new ValidationError("status must be one of succeeded, failed, cancelled, or a matching numeric code.");
  }

  toBytes32Value(value, label) {
    if (value === undefined || value === null || value === "") {
      return ZERO_BYTES32;
    }
    if (typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value)) {
      return value;
    }
    if (typeof value === "string") {
      if (value.length <= 31) {
        return encodeBytes32String(value);
      }
      return id(value);
    }
    throw new ValidationError(`${label} must be empty, a short string, or a 0x-prefixed 32-byte hex string.`);
  }

  decodeBytes32Label(value) {
    const normalized = this.normalizeOptionalBytes32(value);
    if (!normalized) {
      return undefined;
    }
    try {
      return decodeBytes32String(normalized);
    } catch {
      return undefined;
    }
  }

  normalizeOptionalBytes32(value) {
    if (typeof value !== "string" || value.toLowerCase() === ZERO_BYTES32) {
      return undefined;
    }
    return value;
  }

  requireXcmWrapper(operation) {
    if (!this.xcmWrapperContract) {
      throw new ConfigError(`${operation} requires XCM_WRAPPER_ADDRESS`);
    }
    return this.xcmWrapperContract;
  }

  normalizeWeight(weight = undefined) {
    const refTime = Number(weight?.refTime ?? 0);
    const proofSize = Number(weight?.proofSize ?? 0);
    if (!Number.isFinite(refTime) || refTime < 0 || !Number.isFinite(proofSize) || proofSize < 0) {
      throw new ValidationError("maxWeight.refTime and maxWeight.proofSize must be non-negative numbers.");
    }
    return {
      refTime: Math.trunc(refTime),
      proofSize: Math.trunc(proofSize)
    };
  }

  toBytesPayload(value, label) {
    if (value === undefined || value === null || value === "") {
      return "0x";
    }
    if (typeof value === "string") {
      if (/^0x[a-fA-F0-9]*$/u.test(value) && value.length % 2 === 0) {
        return value;
      }
      return toUtf8Bytes(value);
    }
    if (typeof value === "object") {
      return toUtf8Bytes(JSON.stringify(value));
    }
    throw new ValidationError(`${label} must be empty, a hex string, a UTF-8 string, or a JSON object.`);
  }

  previewStrategyRequestId({
    strategyId,
    kind,
    account,
    asset,
    recipient,
    assets,
    shares,
    nonce
  }) {
    return keccak256(
      abiCoder.encode(
        ["bytes32", "uint8", "address", "address", "address", "uint256", "uint256", "uint64"],
        [
          this.normalizeStrategyId(strategyId),
          kind,
          account,
          asset,
          recipient,
          assets,
          shares,
          nonce
        ]
      )
    );
  }

  async quoteStrategySharesForAssets(strategy, assets) {
    const adapterContract = new Contract(strategy.adapter, STRATEGY_ADAPTER_ABI, this.provider);
    const [rawTotalAssets, rawTotalShares] = await Promise.all([
      adapterContract.totalAssets(),
      adapterContract.totalShares()
    ]);
    const totalAssets = Number(rawTotalAssets ?? 0);
    const totalShares = Number(rawTotalShares ?? 0);
    if (!(totalAssets > 0) || !(totalShares > 0)) {
      return Number(assets);
    }
    return Math.ceil((Number(assets) * totalShares) / totalAssets);
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
