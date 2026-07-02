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
import { KmsSigner } from "./kms-signer.js";
import {
  buildKmsCredentialsProvider,
  PROFILE_BLOCKCHAIN_SIGNER,
} from "../services/aws-credentials.js";
import { buildXcmRequestPayload } from "./xcm-message-builder.js";
import { hashCanonicalContent } from "../core/canonical-content.js";
import {
  EXTERNAL_SCHEMA_EIP712_VERSION,
  getRegisteredJobSchemaRegistration
} from "../core/job-schema-registry.js";
import { redactProviderError } from "../core/redact-provider-error.js";
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
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const EMPTY_EXTERNAL_SCHEMA = {
  schemaHash: ZERO_BYTES32,
  schemaUrl: "",
  schemaIssuer: ZERO_ADDRESS,
  schemaSignature: "0x"
};
const CREATE_SINGLE_PAYOUT_WITH_SCHEMA =
  "createSinglePayoutJob(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32,(bytes32,string,address,bytes))";

function summarizeSupportedAssets(assets = []) {
  return assets.map(summarizeSupportedAsset);
}

function summarizeSupportedAsset(asset) {
  const summary = {
    symbol: asset.symbol,
    address: asset.address,
    assetClass: asset.assetClass ?? "custom",
    assetId: asset.assetId,
    foreignAssetIndex: asset.foreignAssetIndex,
    decimals: asset.decimals
  };
  if (asset.minBalanceRaw !== undefined) {
    summary.minBalanceRaw = asset.minBalanceRaw;
  }
  return summary;
}

function summarizeAssetPosition(position, asset, toDisplayUnits, toRawString) {
  const liquid = BigInt(position.liquid ?? 0);
  const reserved = BigInt(position.reserved ?? 0);
  const strategyAllocated = BigInt(position.strategyAllocated ?? 0);
  const collateralLocked = BigInt(position.collateralLocked ?? 0);
  const jobStakeLocked = BigInt(position.jobStakeLocked ?? 0);
  const debtOutstanding = BigInt(position.debtOutstanding ?? 0);
  return {
    liquid: toDisplayUnits(liquid, asset),
    liquidRaw: toRawString(liquid),
    reserved: toDisplayUnits(reserved, asset),
    reservedRaw: toRawString(reserved),
    strategyAllocated: toDisplayUnits(strategyAllocated, asset),
    strategyAllocatedRaw: toRawString(strategyAllocated),
    collateralLocked: toDisplayUnits(collateralLocked, asset),
    collateralLockedRaw: toRawString(collateralLocked),
    jobStakeLocked: toDisplayUnits(jobStakeLocked, asset),
    jobStakeLockedRaw: toRawString(jobStakeLocked),
    debtOutstanding: toDisplayUnits(debtOutstanding, asset),
    debtOutstandingRaw: toRawString(debtOutstanding)
  };
}

function canAutoMintAsset(asset) {
  return (asset?.assetClass ?? "custom") === "custom";
}

export class BlockchainGateway {
  constructor(config = loadBlockchainConfig(), { logger = undefined } = {}) {
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
    this.signer = createSigner(config, this.provider, { logger });
    this.arbitratorSigner = config.arbitratorSignerPrivateKey
      ? new Wallet(config.arbitratorSignerPrivateKey, this.provider)
      : this.signer;
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
    this.arbitratorEscrowContract = new Contract(
      config.escrowCoreAddress,
      ESCROW_CORE_ABI,
      this.arbitratorSigner ?? this.provider
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

  async getExternalSchemaSigningDomain() {
    if (!this.isEnabled()) {
      return undefined;
    }
    const network = await this.provider.getNetwork();
    return {
      chainId: network.chainId.toString(),
      verifyingContract: this.config.escrowCoreAddress
    };
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
        arbitratorSignerConfigured: Boolean(this.arbitratorSigner),
        xcmWrapperConfigured: this.hasXcmWrapper()
      };
    } catch (error) {
      return {
        ok: false,
        backend: "blockchain",
        enabled: true,
        signerConfigured: Boolean(this.signer),
        arbitratorSignerConfigured: Boolean(this.arbitratorSigner),
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
      const raw = {
        liquid: {},
        reserved: {},
        strategyAllocated: {},
        collateralLocked: {},
        jobStakeLocked: {},
        debtOutstanding: {}
      };

      for (const asset of this.config.supportedAssets) {
        const position = await this.accountContract.positions(wallet, asset.address);
        raw.liquid[asset.symbol] = this.toRawString(position.liquid);
        raw.reserved[asset.symbol] = this.toRawString(position.reserved);
        raw.strategyAllocated[asset.symbol] = this.toRawString(position.strategyAllocated);
        raw.collateralLocked[asset.symbol] = this.toRawString(position.collateralLocked);
        raw.jobStakeLocked[asset.symbol] = this.toRawString(position.jobStakeLocked);
        raw.debtOutstanding[asset.symbol] = this.toRawString(position.debtOutstanding);
        liquid[asset.symbol] = this.toDisplayUnits(position.liquid, asset);
        reserved[asset.symbol] = this.toDisplayUnits(position.reserved, asset);
        strategyAllocated[asset.symbol] = this.toDisplayUnits(position.strategyAllocated, asset);
        collateralLocked[asset.symbol] = this.toDisplayUnits(position.collateralLocked, asset);
        jobStakeLocked[asset.symbol] = this.toDisplayUnits(position.jobStakeLocked, asset);
        debtOutstanding[asset.symbol] = this.toDisplayUnits(position.debtOutstanding, asset);
      }

      return {
        wallet,
        liquid,
        reserved,
        strategyAllocated,
        collateralLocked,
        jobStakeLocked,
        debtOutstanding,
        raw
      };
    });
  }

  // Reads the worker's raw ERC-20 wallet (EOA) balance per supported asset.
  // This is DISTINCT from getAccountSummary's `liquid`, which is the
  // AgentAccountCore position. A settled job reward lands in the worker's EOA,
  // not their AAC position — so it shows up here but NOT in `liquid` until the
  // worker deposits it. Callers must keep the two separate: EOA funds are
  // paid-out, not yet stakeable in-platform.
  async getWalletTokenBalances(wallet) {
    return this.withGatewayError("getWalletTokenBalances", async () => {
      const walletBalance = {};
      const raw = {};
      const results = await Promise.all(
        this.config.supportedAssets.map(async (asset) => {
          const token = new Contract(asset.address, ERC20_MOCK_ABI, this.provider);
          const balance = await token.balanceOf(wallet);
          return { asset, balance };
        })
      );
      for (const { asset, balance } of results) {
        raw[asset.symbol] = this.toRawString(balance);
        walletBalance[asset.symbol] = this.toDisplayUnits(balance, asset);
      }
      return { walletBalance, raw };
    });
  }

  async getAccountPosition(wallet, symbol) {
    return this.withGatewayError("getAccountPosition", async () => {
      const asset = this.requireAsset(String(symbol ?? "").trim().toUpperCase());
      const position = await this.accountContract.positions(wallet, asset.address);
      return {
        wallet,
        asset: summarizeSupportedAsset(asset),
        source: {
          contract: "AgentAccountCore",
          address: this.config.agentAccountAddress,
          method: "positions",
          field: "liquid"
        },
        position: summarizeAssetPosition(
          position,
          asset,
          this.toDisplayUnits.bind(this),
          this.toRawString.bind(this)
        )
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
        const asset = this.assetForStrategy(strategy);
        const normalizedStrategyId = this.normalizeStrategyId(strategy.strategyId);
        const [rawShares, rawPendingWithdrawalShares, rawPendingDepositAssets] = await Promise.all([
          this.accountContract.strategyShares(wallet, normalizedStrategyId),
          this.accountContract.pendingStrategyWithdrawalShares(wallet, normalizedStrategyId),
          asset.address
            ? this.accountContract.pendingStrategyAssets(wallet, asset.address)
            : Promise.resolve(0n)
        ]);
        entries.push({
          strategyId: strategy.strategyId,
          shares: this.toDisplayUnits(rawShares, asset),
          sharesRaw: this.toRawString(rawShares),
          pendingWithdrawalShares: this.toDisplayUnits(rawPendingWithdrawalShares, asset),
          pendingWithdrawalSharesRaw: this.toRawString(rawPendingWithdrawalShares),
          pendingDepositAssets: this.toDisplayUnits(rawPendingDepositAssets, asset),
          pendingDepositAssetsRaw: this.toRawString(rawPendingDepositAssets)
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
        const asset = this.assetForStrategy(strategy);
        const adapterContract = new Contract(strategy.adapter, STRATEGY_ADAPTER_ABI, this.provider);
        try {
          const [rawTotalAssets, rawTotalShares, liveRiskLabel] = await Promise.all([
            adapterContract.totalAssets(),
            adapterContract.totalShares().catch(() => undefined),
            adapterContract.riskLabel().catch(() => strategy.riskLabel ?? "")
          ]);
          const totalAssets = this.toDisplayUnits(rawTotalAssets ?? 0, asset);
          const totalShares = this.toDisplayUnits(rawTotalShares ?? 0, asset);
          const sharePrice = totalShares > 0 ? totalAssets / totalShares : undefined;
          const performanceBps = Number.isFinite(sharePrice)
            ? Math.round((sharePrice - 1) * 10_000)
            : undefined;
          return {
            strategyId: strategy.strategyId,
            adapter: strategy.adapter,
            totalAssets,
            totalAssetsRaw: this.toRawString(rawTotalAssets ?? 0),
            totalShares,
            totalSharesRaw: this.toRawString(rawTotalShares ?? 0),
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

  async getWorkerClaimCount(wallet) {
    return this.withGatewayError("getWorkerClaimCount", async () => {
      if (typeof this.escrowContract?.workerClaimCount !== "function") {
        return 0;
      }
      return Number(await this.escrowContract.workerClaimCount(wallet));
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
          settlementReady: false,
          contracts: {
            escrowCoreAddress: this.config.escrowCoreAddress || undefined,
            agentAccountAddress: this.config.agentAccountAddress || undefined,
            reputationSbtAddress: this.config.reputationSbtAddress || undefined,
            supportedAssets: summarizeSupportedAssets(this.config.supportedAssets)
          },
          roles: {
            signerAddress: undefined,
            arbitratorSignerAddress: undefined,
            signerIsVerifier: false,
            arbitratorSignerIsArbitrator: false,
            signerIsSettlementBroker: false,
            escrowIsAgentAccountEscrowOperator: false,
            escrowAgentAccountMatchesConfig: false,
            agentAccountIsOutflowRecorder: false
          },
          readErrors: [],
          risk: {}
        };
      }

      const [signerAddress, arbitratorSignerAddress] = await Promise.all([
        this.signer?.getAddress?.(),
        this.arbitratorSigner?.getAddress?.()
      ]);
      const readErrors = [];
      const optionalRead = async (field, promise, fallback) => {
        try {
          return await promise;
        } catch (error) {
          readErrors.push({
            field,
            message: error?.shortMessage ?? error?.message ?? "read failed"
          });
          return fallback;
        }
      };
      const optionalBool = async (field, promise, fallback = false) => Boolean(
        await optionalRead(field, promise, fallback)
      );
      const [
        owner,
        pauser,
        paused,
        signerIsVerifier,
        arbitratorSignerIsArbitrator,
        signerIsSettlementBroker,
        escrowIsAgentAccountEscrowOperator,
        agentAccountIsOutflowRecorder,
        escrowCoreAgentAccountAddress,
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
        optionalRead("owner", this.policyContract.owner(), undefined),
        optionalRead("pauser", this.policyContract.pauser(), undefined),
        optionalRead("paused", this.policyContract.paused(), undefined),
        signerAddress ? optionalBool("verifiers(signer)", this.policyContract.verifiers(signerAddress)) : false,
        arbitratorSignerAddress && typeof this.policyContract.arbitrators === "function"
          ? optionalBool("arbitrators(arbitratorSigner)", this.policyContract.arbitrators(arbitratorSignerAddress))
          : false,
        signerAddress
          ? optionalBool("settlementBroker(signer)", this.policyContract.settlementBroker(signerAddress))
          : false,
        this.config.escrowCoreAddress && typeof this.accountContract.escrowOperators === "function"
          ? optionalBool(
              "AgentAccountCore.escrowOperators(escrowCore)",
              this.accountContract.escrowOperators(this.config.escrowCoreAddress)
            )
          : false,
        this.config.agentAccountAddress
          ? optionalBool("outflowRecorder(agentAccount)", this.policyContract.outflowRecorder(this.config.agentAccountAddress))
          : false,
        this.config.escrowCoreAddress && typeof this.escrowContract?.accounts === "function"
          ? optionalRead("EscrowCore.accounts()", this.escrowContract.accounts(), undefined)
          : undefined,
        optionalRead("dailyOutflowCap", this.policyContract.dailyOutflowCap(), 0),
        optionalRead("perAccountBorrowCap", this.policyContract.perAccountBorrowCap(), 0),
        optionalRead("minimumCollateralRatioBps", this.policyContract.minimumCollateralRatioBps(), 0),
        optionalRead("defaultClaimStakeBps", this.policyContract.defaultClaimStakeBps(), 0),
        optionalRead("claimFeeBps", this.policyContract.claimFeeBps(), 0),
        optionalRead("claimFeeVerifierBps", this.policyContract.claimFeeVerifierBps(), 7000),
        optionalRead("onboardingWaiverClaimCount", this.policyContract.onboardingWaiverClaimCount(), 0),
        optionalRead("rejectionSkillPenalty", this.policyContract.rejectionSkillPenalty(), 0),
        optionalRead("rejectionReliabilityPenalty", this.policyContract.rejectionReliabilityPenalty(), 0),
        optionalRead("disputeLossSkillPenalty", this.policyContract.disputeLossSkillPenalty(), 0),
        optionalRead("disputeLossReliabilityPenalty", this.policyContract.disputeLossReliabilityPenalty(), 0)
      ]);
      // Post role-split (#724): EscrowCore drives AgentAccountCore purely via the
      // escrowOperators mechanism — the legacy serviceOperator escrow path is gone.
      const agentAccountEscrowAuthorizationMode = escrowIsAgentAccountEscrowOperator
        ? "escrowOperators"
        : "missing";
      const agentAccountEscrowAuthorized = escrowIsAgentAccountEscrowOperator;
      const escrowAgentAccountMatchesConfig = Boolean(
        escrowCoreAgentAccountAddress
          && this.config.agentAccountAddress
          && String(escrowCoreAgentAccountAddress).toLowerCase() === String(this.config.agentAccountAddress).toLowerCase()
      );
      const supportedAssets = await Promise.all((this.config.supportedAssets ?? []).map(async (asset) => ({
        ...summarizeSupportedAsset(asset),
        approved: asset.address
          ? await optionalBool(`approvedAssets(${asset.symbol ?? asset.address})`, this.policyContract.approvedAssets(asset.address))
          : false
      })));
      const signerFunding = signerAddress ? {
        account: signerAddress,
        agentAccountAddress: this.config.agentAccountAddress,
        assets: await Promise.all((this.config.supportedAssets ?? []).map(async (asset) => {
          const summary = summarizeSupportedAsset(asset);
          const position = await optionalRead(
            `positions(signer,${asset.symbol ?? asset.address})`,
            this.accountContract.positions(signerAddress, asset.address),
            undefined
          );
          if (!position) {
            return {
              ...summary,
              readable: false
            };
          }
          return {
            ...summary,
            readable: true,
            ...summarizeAssetPosition(
              position,
              asset,
              this.toDisplayUnits.bind(this),
              this.toRawString.bind(this)
            )
          };
        }))
      } : undefined;
      const supportedAssetsReady = supportedAssets.length > 0
        && supportedAssets.every((asset) => asset.approved === true);

      return {
        enabled: true,
        policyAddress: this.config.treasuryPolicyAddress,
        paused: paused === undefined ? undefined : Boolean(paused),
        owner,
        pauser,
        settlementReady: Boolean(
          signerIsVerifier
            && signerIsSettlementBroker
            && agentAccountEscrowAuthorized
            && escrowAgentAccountMatchesConfig
            && agentAccountIsOutflowRecorder
            && supportedAssetsReady
            && paused === false
        ),
        contracts: {
          escrowCoreAddress: this.config.escrowCoreAddress,
          agentAccountAddress: this.config.agentAccountAddress,
          escrowCoreAgentAccountAddress,
          reputationSbtAddress: this.config.reputationSbtAddress,
          supportedAssets
        },
        roles: {
          signerAddress,
          arbitratorSignerAddress,
          signerIsVerifier,
          arbitratorSignerIsArbitrator,
          signerIsSettlementBroker,
          escrowIsAgentAccountEscrowOperator: agentAccountEscrowAuthorized,
          agentAccountEscrowAuthorizationMode,
          agentAccountEscrowOperatorsGetterReady: escrowIsAgentAccountEscrowOperator,
          escrowAgentAccountMatchesConfig,
          agentAccountIsOutflowRecorder
        },
        signerFunding,
        readErrors,
        risk: this.policyRiskSnapshot({
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
        })
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

      this.requireAutoMintableAsset(asset, "fundAccount");

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

  async ensureClaimStakeLiquidity(wallet, assetSymbol, amount) {
    return this.withGatewayError("ensureClaimStakeLiquidity", async () => {
      if (amount <= 0) {
        return true;
      }
      this.requireSigner("ensureClaimStakeLiquidity");
      const asset = this.requireAsset(assetSymbol);
      const required = this.toBaseUnits(amount, asset, "claim lock amount");
      const account = wallet || await this.signer.getAddress();
      const position = await this.accountContract.positions(account, asset.address);
      const available = BigInt(position.liquid);
      if (available < required) {
        throw new InsufficientLiquidityError(assetSymbol, {
          required: amount,
          available: this.toDisplayUnits(available, asset),
          account
        });
      }
      return true;
    });
  }

  async getBorrowCapacity(wallet, assetSymbol) {
    return this.withGatewayError("getBorrowCapacity", async () => {
      const asset = this.requireAsset(assetSymbol);
      const value = await this.accountContract.getBorrowCapacity(wallet, asset.address);
      return this.toDisplayUnits(value, asset);
    });
  }

  async reserveForJob(wallet, assetSymbol, amount) {
    return this.withGatewayError("reserveForJob", async () => {
      this.requireSigner("reserveForJob");
      const asset = this.requireAsset(assetSymbol);
      const baseAmount = this.toBaseUnits(amount, asset, "job reserve amount");
      const tx = await this.accountContract.reserveForJob(wallet, asset.address, baseAmount);
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

  async cancelRecurringTemplateReserve(wallet, assetSymbol, amount, templateId) {
    return this.withGatewayError("cancelRecurringTemplateReserve", async () => {
      this.requireSigner("cancelRecurringTemplateReserve");
      const asset = this.requireAsset(assetSymbol);
      const templateKey = this.toJobId(templateId);
      const baseAmount = this.toBaseUnits(amount, asset, "recurring reserve cancellation amount");
      const tx = await this.accountContract.cancelRecurringTemplateReserve(
        wallet,
        asset.address,
        templateKey,
        baseAmount
      );
      await tx.wait();
      return {
        wallet,
        asset: asset.symbol,
        amount: this.toDisplayUnits(baseAmount, asset),
        amountRaw: baseAmount.toString(),
        templateId,
        templateKey,
        source: "agent_account_recurring_template_cancel"
      };
    });
  }

  async allocateIdleFunds(wallet, strategyId, amount, assetSymbol = "DOT") {
    return this.withGatewayError("allocateIdleFunds", async () => {
      this.requireSigner("allocateIdleFunds");
      const asset = this.requireAsset(assetSymbol);
      const baseAmount = this.toBaseUnits(amount, asset, "strategy allocation amount");
      const tx = await this.accountContract.allocateIdleFunds(wallet, this.normalizeStrategyId(strategyId), baseAmount);
      await tx.wait();
      return this.getAccountSummary(wallet);
    });
  }

  async deallocateIdleFunds(wallet, strategyId, amount, assetSymbol = "DOT") {
    return this.withGatewayError("deallocateIdleFunds", async () => {
      this.requireSigner("deallocateIdleFunds");
      const asset = this.requireAsset(assetSymbol);
      const before = await this.getAccountSummary(wallet);
      const baseAmount = this.toBaseUnits(amount, asset, "strategy deallocation amount");
      const tx = await this.accountContract.deallocateIdleFunds(wallet, this.normalizeStrategyId(strategyId), baseAmount);
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
      const asset = this.assetForStrategy(strategy);
      const baseAmount = this.toBaseUnits(amount, asset, "strategy deposit amount");
      const requestId = this.previewStrategyRequestId({
        strategyId: strategy.strategyId,
        kind: 0,
        account: wallet,
        asset: asset.address,
        recipient: wallet,
        assets: baseAmount,
        shares: 0,
        nonce
      });
      const payload = buildXcmRequestPayload({
        strategy,
        direction: "deposit",
        requestId,
        account: wallet,
        recipient: wallet,
        amount: baseAmount
      });
      const resolvedMaxWeight = await this.resolveXcmMaxWeight(
        maxWeight ?? payload.maxWeight,
        payload.message,
        "requestStrategyDeposit"
      );
      const tx = await this.accountContract.requestStrategyDeposit(wallet, {
        strategyId: this.normalizeStrategyId(strategy.strategyId),
        amount: baseAmount,
        destination: payload.destination,
        message: payload.message,
        maxWeight: resolvedMaxWeight,
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
      const asset = this.assetForStrategy(strategy);
      const baseAmount = this.toBaseUnits(amount, asset, "strategy withdraw amount");
      const shares = Number.isFinite(Number(requestedShares)) && Number(requestedShares) > 0
        ? this.toBaseUnits(requestedShares, asset, "strategy withdraw shares")
        : await this.quoteStrategySharesForAssets(strategy, baseAmount);
      const requestId = this.previewStrategyRequestId({
        strategyId: strategy.strategyId,
        kind: 1,
        account: wallet,
        asset: asset.address,
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
        amount: baseAmount,
        shares
      });
      const resolvedMaxWeight = await this.resolveXcmMaxWeight(
        maxWeight ?? payload.maxWeight,
        payload.message,
        "requestStrategyWithdraw"
      );
      const tx = await this.accountContract.requestStrategyWithdraw(wallet, {
        strategyId: this.normalizeStrategyId(strategy.strategyId),
        shares,
        recipient,
        destination: payload.destination,
        message: payload.message,
        maxWeight: resolvedMaxWeight,
        nonce
      });
      await tx.wait();
      return {
        ...(await this.getAccountSummary(wallet)),
        requestId,
        requestedShares: this.toDisplayUnits(shares, asset),
        requestedSharesRaw: this.toRawString(shares),
        requestedAssets: this.toDisplayUnits(baseAmount, asset),
        requestedAssetsRaw: this.toRawString(baseAmount),
        xcmRequest: await this.getXcmRequest(requestId),
        strategyRequest: await this.getStrategyRequest(requestId)
      };
    });
  }

  async borrow(wallet, assetSymbol, amount) {
    return this.withGatewayError("borrow", async () => {
      this.requireSigner("borrow");
      const asset = this.requireAsset(assetSymbol);
      await this.requireSignerWallet(wallet, "borrow");
      const baseAmount = this.toBaseUnits(amount, asset, "borrow amount");
      const tx = await this.accountContract.borrow(asset.address, baseAmount);
      await tx.wait();
    });
  }

  async repay(wallet, assetSymbol, amount) {
    return this.withGatewayError("repay", async () => {
      this.requireSigner("repay");
      const asset = this.requireAsset(assetSymbol);
      await this.requireSignerWallet(wallet, "repay");
      const baseAmount = this.toBaseUnits(amount, asset, "repay amount");
      const tx = await this.accountContract.repay(asset.address, baseAmount);
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
  async sendToAgent(from, recipient, assetSymbol, amount, authorization = {}) {
    return this.withGatewayError("sendToAgent", async () => {
      this.requireSigner("sendToAgent");
      const asset = this.requireAsset(assetSymbol);
      const baseAmount = this.toBaseUnits(amount, asset, "agent transfer amount");
      const nonce = this.normalizeUint256(authorization?.nonce, "transferAuthorization.nonce");
      const deadline = this.normalizeUint256(authorization?.deadline, "transferAuthorization.deadline");
      const signature = this.normalizeSignature(authorization?.signature, "transferAuthorization.signature");
      const tx = await this.accountContract.sendToAgentFor(
        from,
        recipient,
        asset.address,
        baseAmount,
        nonce,
        deadline,
        signature
      );
      await tx.wait();
    });
  }

  async claimJob(jobId, wallet) {
    return this.withGatewayError("claimJob", async () => {
      this.requireSigner("claimJob");
      const chainJobId = this.toJobId(jobId);
      const signerAddress = await this.signer.getAddress();
      const tx = wallet && wallet.toLowerCase() !== signerAddress.toLowerCase()
        ? await this.escrowContract.claimJobFor(chainJobId, wallet)
        : await this.escrowContract.claimJob(chainJobId);
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
        await this.ensureOnboardingWaiverEligibility(this.toJobId(instanceJobId), job, live.contractLayout);
        return this.publicEscrowJob(live);
      }

      const rewardAmount = this.toBaseUnits(job.rewardAmount ?? 0, asset, "job reward");
      const claimStake = this.toBaseUnits(claimStakeAmount ?? 0, asset, "claim lock amount");
      const usesRecurringTemplateReserve = this.usesRecurringTemplateReserve(job);
      const totalRequired = usesRecurringTemplateReserve ? rewardAmount : rewardAmount + claimStake;
      if (totalRequired <= 0n) {
        throw new ValidationError(`Job ${job.id} has no fundable reward`);
      }

      const signerAddress = await this.signer.getAddress();
      const signerPosition = usesRecurringTemplateReserve
        ? { liquid: 0n }
        : await this.accountContract.positions(signerAddress, asset.address);
      const liquid = BigInt(signerPosition.liquid);
      const shortfall = !usesRecurringTemplateReserve && totalRequired > liquid ? totalRequired - liquid : 0n;

      if (!usesRecurringTemplateReserve && shortfall > 0n) {
        this.requireAutoMintableAsset(asset, "ensureJob", {
          jobId: job.id,
          required: this.toDisplayUnits(totalRequired, asset),
          available: this.toDisplayUnits(liquid, asset),
          shortfall: this.toDisplayUnits(shortfall, asset),
          account: signerAddress
        });
        const token = new Contract(asset.address, ERC20_MOCK_ABI, this.signer);
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
      await this.ensureOnboardingWaiverEligibility(this.toJobId(instanceJobId), job, live.contractLayout);
      return this.getJob(instanceJobId);
    });
  }

  async ensureOnboardingWaiverEligibility(chainJobId, job, contractLayout = "current") {
    if (contractLayout === "legacy" || job?.onboardingWaiverEligible !== true) {
      return;
    }
    if (typeof this.escrowContract.onboardingWaiverEligibleJobs !== "function"
      || typeof this.escrowContract.setOnboardingWaiverEligible !== "function") {
      return;
    }
    let current = false;
    try {
      current = await this.escrowContract.onboardingWaiverEligibleJobs(chainJobId);
    } catch (error) {
      if (this.isMissingOptionalContractSelector(error)) {
        return;
      }
      throw error;
    }
    if (current === true) {
      return;
    }
    let tx;
    try {
      tx = await this.escrowContract.setOnboardingWaiverEligible(chainJobId, true);
    } catch (error) {
      if (this.isMissingOptionalContractSelector(error)) {
        return;
      }
      throw error;
    }
    await tx.wait();
  }

  usesRecurringTemplateReserve(job) {
    return job?.funding?.source === "recurring_template_reserve"
      && Boolean(job?.funding?.wallet)
      && Boolean(job?.funding?.templateId);
  }

  async submitWork(jobId, evidence, worker) {
    return this.withGatewayError("submitWork", async () => {
      this.requireSigner("submitWork");
      const chainJobId = this.toJobId(jobId);
      const evidenceHash = typeof evidence === "string" && /^0x[a-fA-F0-9]{64}$/u.test(evidence)
        ? evidence
        : hashCanonicalContent(evidence);
      const signerAddress = worker ? await this.signer.getAddress() : undefined;
      const tx = worker && worker.toLowerCase() !== signerAddress.toLowerCase()
        ? await this.escrowContract.submitWorkFor(chainJobId, worker, evidenceHash)
        : await this.escrowContract.submitWork(chainJobId, evidenceHash);
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
      // Return the settle/payout tx receipt (additive — mirrors openDispute /
      // resolveDispute below) so callers can surface the on-chain payout tx to
      // the worker instead of discarding it. Settlement behavior is unchanged.
      const receipt = await tx.wait();
      return {
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        status: Number(receipt?.status ?? 0)
      };
    });
  }

  async openDispute(jobId, participant) {
    return this.withGatewayError("openDispute", async () => {
      this.requireSigner("openDispute");
      const chainJobId = this.toJobId(jobId);
      const signerAddress = participant ? await this.signer.getAddress() : undefined;
      const tx = participant && participant.toLowerCase() !== signerAddress.toLowerCase()
        ? await this.escrowContract.openDisputeFor(chainJobId, participant)
        : await this.escrowContract.openDispute(chainJobId);
      const receipt = await tx.wait();
      return {
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        status: Number(receipt?.status ?? 0)
      };
    });
  }

  async resolveDispute(jobId, workerPayout, reasonCode, metadataURI = "") {
    return this.withGatewayError("resolveDispute", async () => {
      this.requireArbitratorSigner("resolveDispute");
      const job = await this.getJob(jobId);
      const asset = this.assetForAddress(job.asset);
      const workerPayoutBase = this.toBaseUnits(workerPayout, asset, "dispute worker payout");
      const tx = await this.arbitratorEscrowContract.resolveDispute(
        this.toJobId(jobId),
        workerPayoutBase,
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

  async isTrustedSchemaIssuer(issuer) {
    return this.withGatewayError("isTrustedSchemaIssuer", async () => {
      if (!this.policyContract?.trustedSchemaIssuers) {
        return false;
      }
      return Boolean(await this.policyContract.trustedSchemaIssuers(issuer));
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
    specHash,
    externalSchema = EMPTY_EXTERNAL_SCHEMA
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
    if (this.hasExternalSchemaMetadata(externalSchema)) {
      return this.escrowContract[CREATE_SINGLE_PAYOUT_WITH_SCHEMA](
        jobId,
        assetAddress,
        reward,
        opsReserve,
        contingencyReserve,
        claimTtl,
        verifierMode,
        category,
        specHash,
        externalSchema
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
    const externalSchema = this.externalSchemaMetadataForJob(job);
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
        specHash,
        ...externalSchema
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
      specHash,
      externalSchema
    );
  }

  externalSchemaMetadataForJob(job) {
    const registration = getRegisteredJobSchemaRegistration(job?.outputSchemaRef, job?.schemaRegistrations);
    if (registration?.registrationVersion !== EXTERNAL_SCHEMA_EIP712_VERSION) {
      return EMPTY_EXTERNAL_SCHEMA;
    }
    return {
      schemaHash: registration.schemaHash,
      schemaUrl: registration.schemaUrl,
      schemaIssuer: registration.schemaIssuer ?? registration.issuer,
      schemaSignature: registration.signature
    };
  }

  hasExternalSchemaMetadata(externalSchema) {
    return Boolean(
      externalSchema
        && externalSchema.schemaHash
        && externalSchema.schemaHash !== ZERO_BYTES32
        && externalSchema.schemaUrl
        && externalSchema.schemaIssuer
        && externalSchema.schemaIssuer !== ZERO_ADDRESS
        && externalSchema.schemaSignature
        && externalSchema.schemaSignature !== "0x"
    );
  }

  isEscrowJobDecodeError(error) {
    const code = String(error?.code ?? "");
    const message = `${error?.shortMessage ?? ""} ${error?.message ?? ""}`;
    return code === "BAD_DATA" || /could not decode result data|decode result data|invalid length/u.test(message);
  }

  isMissingOptionalContractSelector(error) {
    const code = String(error?.code ?? "");
    const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
    const message = `${error?.reason ?? ""} ${error?.shortMessage ?? ""} ${error?.message ?? ""}`;
    return code === "CALL_EXCEPTION"
      && (data === undefined || data === null || data === "0x")
      && /require\(false\)|no data present|could not decode result data/u.test(message);
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
        requestedAssets: this.toDisplayUnits(record.context.assets, this.assetForAddress(record.context.asset)),
        requestedAssetsRaw: this.toRawString(record.context.assets),
        requestedShares: this.toDisplayUnits(record.context.shares, this.assetForAddress(record.context.asset)),
        requestedSharesRaw: this.toRawString(record.context.shares),
        nonce: this.toSafeIntegerOrRaw(record.context.nonce, "nonce"),
        nonceRaw: this.toRawString(record.context.nonce),
        queuedBy: record.queuedBy,
        status: Number(record.status),
        statusLabel: REQUEST_STATUS_LABELS[Number(record.status)] ?? "unknown",
        settledAssets: this.toDisplayUnits(record.settledAssets, this.assetForAddress(record.context.asset)),
        settledAssetsRaw: this.toRawString(record.settledAssets),
        settledShares: this.toDisplayUnits(record.settledShares, this.assetForAddress(record.context.asset)),
        settledSharesRaw: this.toRawString(record.settledShares),
        remoteRef: this.normalizeOptionalBytes32(record.remoteRef),
        remoteRefLabel: this.decodeBytes32Label(record.remoteRef),
        failureCode: this.normalizeOptionalBytes32(record.failureCode),
        failureCodeLabel: this.decodeBytes32Label(record.failureCode),
        createdAt: this.toSafeIntegerOrRaw(record.createdAt, "createdAt"),
        createdAtRaw: this.toRawString(record.createdAt),
        updatedAt: this.toSafeIntegerOrRaw(record.updatedAt, "updatedAt"),
        updatedAtRaw: this.toRawString(record.updatedAt)
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
        requestedAssets: this.toDisplayUnits(record.requestedAssets, this.assetForAddress(record.asset)),
        requestedAssetsRaw: this.toRawString(record.requestedAssets),
        requestedShares: this.toDisplayUnits(record.requestedShares, this.assetForAddress(record.asset)),
        requestedSharesRaw: this.toRawString(record.requestedShares),
        settledAssets: this.toDisplayUnits(record.settledAssets, this.assetForAddress(record.asset)),
        settledAssetsRaw: this.toRawString(record.settledAssets),
        settledShares: this.toDisplayUnits(record.settledShares, this.assetForAddress(record.asset)),
        settledSharesRaw: this.toRawString(record.settledShares),
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
      const normalizedSettledAssets = this.normalizeUint256(settledAssets, "settledAssets");
      const normalizedSettledShares = this.normalizeUint256(settledShares, "settledShares");
      let strategyRequest;
      try {
        strategyRequest = await this.getStrategyRequest(normalizedRequestId);
      } catch (error) {
        if (error?.code !== "strategy_request_not_found") {
          throw error;
        }
      }
      if (strategyRequest?.settled) {
        if (!this.strategySettlementMatches(
          strategyRequest,
          normalizedStatus,
          normalizedSettledAssets,
          normalizedSettledShares,
          normalizedRemoteRef,
          normalizedFailureCode
        )) {
          throw new ValidationError("Strategy XCM request is already settled with a different outcome.");
        }
        return {
          ...(await this.getXcmRequest(normalizedRequestId)),
          strategyRequest,
          settledVia: "agent_account",
          alreadySettled: true
        };
      }
      this.validateStrategySettlementOutcome(
        strategyRequest,
        normalizedStatus,
        normalizedSettledAssets,
        normalizedSettledShares
      );

      const tx = strategyRequest
        ? await this.accountContract.settleStrategyRequest(
            normalizedRequestId,
            normalizedStatus,
            normalizedSettledAssets,
            normalizedSettledShares,
            normalizedRemoteRef,
            normalizedFailureCode
          )
        : await this.requireXcmWrapper("finalizeXcmRequest").finalizeRequest(
            normalizedRequestId,
            normalizedStatus,
            normalizedSettledAssets,
            normalizedSettledShares,
            normalizedRemoteRef,
            normalizedFailureCode
          );
      await tx.wait();
      return {
        ...(await this.getXcmRequest(normalizedRequestId)),
        strategyRequest: await this.getStrategyRequest(normalizedRequestId).catch(() => undefined),
        settledVia: strategyRequest ? "agent_account" : "xcm_wrapper",
        alreadySettled: false
      };
    });
  }

  strategySettlementMatches(strategyRequest, status, settledAssets, settledShares, remoteRef, failureCode) {
    return Number(strategyRequest?.status) === status
      && BigInt(strategyRequest?.settledAssetsRaw ?? 0) === settledAssets
      && BigInt(strategyRequest?.settledSharesRaw ?? 0) === settledShares
      && this.toBytes32Value(strategyRequest?.remoteRef, "remoteRef").toLowerCase() === remoteRef.toLowerCase()
      && this.toBytes32Value(strategyRequest?.failureCode, "failureCode").toLowerCase() === failureCode.toLowerCase();
  }

  validateStrategySettlementOutcome(strategyRequest, status, settledAssets, settledShares) {
    if (!strategyRequest || status !== 2) {
      return;
    }

    if (strategyRequest.kind === 0 && (settledAssets === 0n || settledShares === 0n)) {
      throw new ValidationError(
        "Successful async strategy deposits require non-zero settledAssets and settledShares."
      );
    }
    if (strategyRequest.kind === 1 && settledAssets === 0n) {
      throw new ValidationError("Successful async strategy withdrawals require non-zero settledAssets.");
    }
  }

  requireAutoMintableAsset(asset, operation, details = {}) {
    if (canAutoMintAsset(asset)) {
      return true;
    }
    throw new InsufficientLiquidityError(asset.symbol, {
      ...details,
      operation,
      asset: asset.symbol,
      assetClass: asset.assetClass,
      assetAddress: asset.address,
      reason: `${asset.symbol} is a ${asset.assetClass} settlement asset and cannot be auto-minted. Deposit funded liquidity into AgentAccountCore or use a recurring template reserve before creating or claiming jobs.`
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

  assetForStrategy(strategy = {}) {
    const address = strategy.assetConfig?.address ?? strategy.asset;
    const known = this.assetForAddress(address);
    return {
      ...known,
      ...(strategy.assetConfig ?? {}),
      address: address ?? known.address,
      symbol: strategy.assetConfig?.symbol ?? known.symbol,
      decimals: strategy.assetConfig?.decimals ?? known.decimals ?? 18
    };
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

  toRawString(amount) {
    if (amount === undefined || amount === null) {
      return "0";
    }
    return BigInt(amount).toString();
  }

  toSafeIntegerOrRaw(value, label) {
    const raw = this.toRawString(value);
    const parsed = BigInt(raw);
    if (parsed < 0n) {
      throw new ValidationError(`${label} must be non-negative.`);
    }
    return parsed <= MAX_SAFE_INTEGER_BIGINT ? Number(parsed) : raw;
  }

  policyRiskSnapshot(values) {
    return Object.fromEntries(
      Object.entries(values).flatMap(([key, value]) => {
        const raw = BigInt(value ?? 0);
        const exactNumber = raw >= 0n && raw <= MAX_SAFE_INTEGER_BIGINT;
        return [
          [key, exactNumber ? Number(raw) : null],
          [`${key}Raw`, raw.toString()],
          [`${key}Exact`, exactNumber]
        ];
      })
    );
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

  requireArbitratorSigner(operation) {
    if (!this.arbitratorSigner) {
      throw new ConfigError(`${operation} requires ARBITRATOR_SIGNER_PRIVATE_KEY or SIGNER_PRIVATE_KEY`);
    }
  }

  async requireSignerWallet(wallet, operation) {
    const signerAddress = await this.signer.getAddress();
    if (!wallet || signerAddress.toLowerCase() !== wallet.toLowerCase()) {
      throw new ValidationError(
        `${operation} requires the configured blockchain signer to match the authenticated wallet until a relayed contract primitive exists.`
      );
    }
    return signerAddress;
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
    return {
      refTime: this.normalizeWeightComponent(weight?.refTime ?? weight?.ref_time, "maxWeight.refTime"),
      proofSize: this.normalizeWeightComponent(weight?.proofSize ?? weight?.proof_size, "maxWeight.proofSize")
    };
  }

  async resolveXcmMaxWeight(weight, message, operation) {
    const normalized = this.normalizeWeight(weight);
    if (normalized.refTime > 0n) {
      return normalized;
    }

    if (!this.xcmWrapperContract?.weighMessage) {
      throw new ValidationError(`${operation} requires non-zero maxWeight.refTime or a configured XCM wrapper.`);
    }

    const quoted = this.normalizeWeight(await this.xcmWrapperContract.weighMessage(message));
    if (quoted.refTime <= 0n) {
      throw new ValidationError(`${operation} requires a non-zero XCM weight quote before queuing.`);
    }
    return quoted;
  }

  normalizeWeightComponent(value, label) {
    if (value === undefined || value === null || value === "") {
      return 0n;
    }

    let parsed;
    if (typeof value === "bigint") {
      parsed = value;
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ValidationError(`${label} must be an exact non-negative uint64.`);
      }
      parsed = BigInt(value);
    } else if (typeof value === "string") {
      const normalized = value.trim();
      if (!/^\d+$/u.test(normalized)) {
        throw new ValidationError(`${label} must be an exact non-negative uint64.`);
      }
      parsed = BigInt(normalized);
    } else {
      throw new ValidationError(`${label} must be an exact non-negative uint64.`);
    }

    if (parsed < 0n || parsed > UINT64_MAX) {
      throw new ValidationError(`${label} must fit uint64.`);
    }
    return parsed;
  }

  normalizeUint256(value, label) {
    if (value === undefined || value === null || value === "") {
      return 0n;
    }

    let parsed;
    if (typeof value === "bigint") {
      parsed = value;
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ValidationError(`${label} must be an exact non-negative uint256.`);
      }
      parsed = BigInt(value);
    } else if (typeof value === "string") {
      const normalized = value.trim();
      if (!/^\d+$/u.test(normalized)) {
        throw new ValidationError(`${label} must be an exact non-negative uint256.`);
      }
      parsed = BigInt(normalized);
    } else {
      throw new ValidationError(`${label} must be an exact non-negative uint256.`);
    }

    if (parsed < 0n || parsed > UINT256_MAX) {
      throw new ValidationError(`${label} must fit uint256.`);
    }
    return parsed;
  }

  normalizeSignature(value, label) {
    if (typeof value !== "string" || !/^0x[a-fA-F0-9]{130}$/u.test(value)) {
      throw new ValidationError(`${label} must be a 65-byte hex string.`);
    }
    return value;
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
    const totalAssets = BigInt(rawTotalAssets ?? 0);
    const totalShares = BigInt(rawTotalShares ?? 0);
    const requestedAssets = BigInt(assets ?? 0);
    if (totalAssets <= 0n || totalShares <= 0n) {
      return requestedAssets;
    }
    return (requestedAssets * totalShares + totalAssets - 1n) / totalAssets;
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
    // Redact credential-looking material (RPC URLs with embedded keys, Bearer
    // tokens, JWTs) before this reason is surfaced on /health, logged, or
    // stamped onto the thrown error's rawReason (pre-audit #8).
    return redactProviderError(
      error?.reason ||
        error?.shortMessage ||
        error?.info?.error?.message ||
        error?.info?.payload?.method ||
        error?.message ||
        "unknown_error"
    );
  }
}

/**
 * Construct the right signer for the blockchain config. Phase 3 introduces
 * the `SIGNER_BACKEND` switch:
 *
 *   - "local" (default): existing path — `new Wallet(privateKey, provider)`.
 *     The private key is in process memory; deployment carries the same
 *     pre-Phase-3 risks (vault leak ⇒ signer compromise).
 *   - "kms": KmsSigner wrapping an AWS KMS asymmetric key. The private
 *     key material never leaves KMS. Requires a KMSClient bound to
 *     `config.awsRegion` and a key id at `config.kmsKeyId`.
 *
 * The factory returns `undefined` when neither path is configured (read-only
 * gateway, no signing capability) — matches the pre-Phase-3 contract where
 * an empty SIGNER_PRIVATE_KEY would also yield an undefined signer.
 */
function createSigner(config, provider, { logger = undefined } = {}) {
  if (config.signerBackend === "kms") {
    if (!config.kmsKeyId || !config.awsRegion) {
      // Should be caught upstream by loadBlockchainConfig's required-field
      // check, but defend in depth so a partially-loaded config can't
      // silently construct a half-initialized signer.
      throw new ConfigError(
        "SIGNER_BACKEND=kms requires both KMS_KEY_ID and AWS_REGION",
      );
    }
    // KmsSigner lazy-constructs the KMSClient on first signing call,
    // so importing this module doesn't load the AWS SDK for local-
    // backend deploys.
    //
    // Phase 5a: when AWS_USE_ROLES_ANYWHERE=true, plumb an SDK
    // credentials provider keyed to the blockchain-signer shared-config
    // profile. Null otherwise — KmsSigner falls through to the SDK's
    // default chain (pre-5a behavior, unchanged).
    const credentialsProvider = buildKmsCredentialsProvider({
      profile: PROFILE_BLOCKCHAIN_SIGNER,
    });
    return new KmsSigner({
      region: config.awsRegion,
      keyId: config.kmsKeyId,
      provider,
      logger,
      credentialsProvider,
    });
  }
  // Default "local" path — unchanged from pre-Phase-3 behavior.
  if (!config.signerPrivateKey) {
    return undefined;
  }
  return new Wallet(config.signerPrivateKey, provider);
}
