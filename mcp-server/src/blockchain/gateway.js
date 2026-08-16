import {
  AbiCoder,
  Contract,
  Wallet,
  decodeBytes32String,
  encodeBytes32String,
  formatUnits,
  getAddress,
  getBytes,
  id,
  keccak256,
  parseUnits,
  toUtf8Bytes
} from "ethers";
import {
  AGENT_ACCOUNT_ABI,
  CREDIT_POOL_ABI,
  DEPOSIT_POOL_ABI,
  DEPOSIT_POOL_V2_ABI,
  ERC20_MOCK_ABI,
  ESCROW_CORE_ABI,
  ESCROW_CORE_LEGACY_ABI,
  ESCROW_CORE_V1_DRAIN_ABI,
  HYDRATION_USDC_ADAPTER_V22_ABI,
  REPUTATION_SBT_ABI,
  STRATEGY_ADAPTER_ABI,
  TREASURY_POLICY_ABI,
  XCM_WRAPPER_ABI,
  ZERO_BYTES32
} from "./abis.js";
import { loadBlockchainConfig } from "./config.js";
import { KmsSigner } from "./kms-signer.js";
import { applyGasFeeBuffer } from "./fee-buffer.js";
import {
  bindSignerToWriteBroadcaster,
  createRpcProvider,
  createWriteRpcBroadcaster,
  describeRpcProvider
} from "./rpc-provider.js";
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
  DEFAULT_WORKER_DEPOSIT_VESTING_HOURS,
  calculateDepositVesting
} from "../core/deposit-vesting.js";
import {
  BlockchainRevertError,
  ConfigError,
  ConflictError,
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
const ESCROW_JOB_STATE_REJECTED = 4;
const ESCROW_JOB_STATE_CLOSED = 6;
const RECOVERY_LOG_CHUNK_SIZE = 50_000;
const RECOVERY_FROM_BLOCK_SAFETY_MARGIN = 1_000;
const DEPOSIT_POOL_EVENT_LOG_CHUNK_SIZE = 2_000;
const CREDIT_POOL_EVENT_LOG_CHUNK_SIZE = 2_000;
const XCM_STRATEGY_EVENT_LOG_CHUNK_SIZE = 50_000;
const POOL_STRATEGY_ID = encodeBytes32String("HYDRATION_USDC_POOL_V1").toLowerCase();
const VESTING_ATTESTATION_TYPEHASH = id(
  "VestingAttestation(address borrower,bytes32 loanId,uint256 pledgeShares,uint256 amount,uint256 vestedRaw,uint64 validUntil,uint256 nonce,uint256 chainId,address creditPool)"
);
const JOB_CLOSED_TOPIC0 = id("JobClosed(bytes32,address,uint256)").toLowerCase();
const JOB_REJECTED_TOPIC0 = id("JobRejected(bytes32,bytes32)").toLowerCase();
const RESERVATION_SETTLED_TOPIC0 =
  "0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee";
const EMPTY_EXTERNAL_SCHEMA = {
  schemaHash: ZERO_BYTES32,
  schemaUrl: "",
  schemaIssuer: ZERO_ADDRESS,
  schemaSignature: "0x"
};
const CREATE_SINGLE_PAYOUT_WITH_SCHEMA =
  "createSinglePayoutJob(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32,(bytes32,string,address,bytes))";
const CREATE_SINGLE_PAYOUT_FEE_WAIVED_WITH_SCHEMA =
  "createSinglePayoutJobFeeWaived(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32,(bytes32,string,address,bytes))";

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

function decodeStrategyLabel(strategyId) {
  try {
    return decodeBytes32String(strategyId);
  } catch {
    return strategyId;
  }
}

function deriveStrategyLaneVerdict({ approved }) {
  return approved
    ? { status: "ok", reason: "wrapper_registered_and_policy_approved" }
    : { status: "blocked", reason: "strategy_not_policy_approved" };
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

function exactUint(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new ValidationError(`${label} must be an exact unsigned integer.`);
  }
  return BigInt(normalized);
}

export class BlockchainGateway {
  constructor(config = loadBlockchainConfig(), { logger = undefined, now = () => Date.now() } = {}) {
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.depositPoolVestingEventCache = undefined;
    this.creditPoolVestingEventCache = undefined;
    this.xcmStrategyRegistryEventCache = undefined;
    if (!config.enabled) {
      this.provider = undefined;
      this.writeBroadcaster = undefined;
      this.signer = undefined;
      this.policyContract = undefined;
      this.accountContract = undefined;
      this.escrowContract = undefined;
      this.v1EscrowContract = undefined;
      this.legacyEscrowContract = undefined;
      this.primaryEscrowContractLayout = undefined;
      this.drainingEscrowContract = undefined;
      this.arbitratorDrainingEscrowContract = undefined;
      this.reputationContract = undefined;
      this.xcmWrapperContract = undefined;
      this.hydrationUsdcAdapterContract = undefined;
      this.depositPoolContract = undefined;
      this.depositPoolV2Contract = undefined;
      this.creditPoolContract = undefined;
      return;
    }

    this.provider = createRpcProvider(config);
    this.writeBroadcaster = createWriteRpcBroadcaster(config);
    // Raise the fee ceiling by a small buffer so a Polkadot Hub tx isn't left
    // underpriced when the per-block fee multiplier rises during KMS-sign latency.
    applyGasFeeBuffer(this.provider, config.gasFeeBufferBps, logger);
    const baseSigner = createSigner(config, this.provider, { logger });
    this.signer = bindSignerToWriteBroadcaster(
      baseSigner,
      this.provider,
      this.writeBroadcaster
    );
    this.arbitratorSigner = config.arbitratorSignerPrivateKey
      ? bindSignerToWriteBroadcaster(
          new Wallet(config.arbitratorSignerPrivateKey, this.provider),
          this.provider,
          this.writeBroadcaster
        )
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
    // Until the v2 ceremony updates the manifest, the primary address still
    // serves EscrowCore v1. Keep its exact ABI available so a v2 tuple decode
    // failure does not fall through to the pre-waiver legacy semantics.
    this.v1EscrowContract = new Contract(
      config.escrowCoreAddress,
      ESCROW_CORE_V1_DRAIN_ABI,
      this.signer ?? this.provider
    );
    this.legacyEscrowContract = new Contract(
      config.escrowCoreAddress,
      ESCROW_CORE_LEGACY_ABI,
      this.signer ?? this.provider
    );
    this.primaryEscrowContractLayout = undefined;
    this.drainingEscrowContract = config.legacyEscrowCoreAddress
      ? new Contract(
          config.legacyEscrowCoreAddress,
          ESCROW_CORE_V1_DRAIN_ABI,
          this.signer ?? this.provider
        )
      : undefined;
    this.arbitratorDrainingEscrowContract = config.legacyEscrowCoreAddress
      ? new Contract(
          config.legacyEscrowCoreAddress,
          ESCROW_CORE_V1_DRAIN_ABI,
          this.arbitratorSigner ?? this.provider
        )
      : undefined;
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
    this.hydrationUsdcAdapterContract = config.hydrationUsdcAdapterAddress
      ? new Contract(
          config.hydrationUsdcAdapterAddress,
          HYDRATION_USDC_ADAPTER_V22_ABI,
          this.signer ?? this.provider
        )
      : undefined;
    this.depositPoolContract = config.depositPoolAddress
      ? new Contract(
          config.depositPoolAddress,
          DEPOSIT_POOL_ABI,
          this.provider
        )
      : undefined;
    this.depositPoolV2Contract = config.depositPoolV2Address
      ? new Contract(config.depositPoolV2Address, DEPOSIT_POOL_V2_ABI, this.provider)
      : undefined;
    this.creditPoolContract = config.creditPoolAddress
      ? new Contract(config.creditPoolAddress, CREDIT_POOL_ABI, this.signer ?? this.provider)
      : undefined;
  }

  isEnabled() {
    return this.config.enabled;
  }

  isSignerConfigured() {
    return Boolean(this.signer);
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
        xcmWrapperConfigured: this.hasXcmWrapper(),
        rpcEndpointCount: this.config.rpcUrls?.length ?? 1
      };
    } catch (error) {
      return {
        ok: false,
        backend: "blockchain",
        enabled: true,
        signerConfigured: Boolean(this.signer),
        arbitratorSignerConfigured: Boolean(this.arbitratorSigner),
        xcmWrapperConfigured: this.hasXcmWrapper(),
        rpcEndpointCount: this.config.rpcUrls?.length ?? 1,
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
  // AgentAccountCore position. Settled worker rewards and protocol fees land
  // in ordinary AAC positions; they appear in `liquid` (or reduce debt), not
  // in this raw EOA balance until the account owner withdraws.
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

  /**
   * Enumerate the wrapper's current strategy registry from its append-only
   * StrategyAdapterUpdated log, then re-read each mapping at one head block.
   * The log supplies only candidate ids; no adapter or allocation is trusted
   * until the corresponding live contract read succeeds.
   */
  async getTreasuryStrategyLanes() {
    return this.withGatewayError("getTreasuryStrategyLanes", async () => {
      if (!this.provider || !this.xcmWrapperContract) {
        throw new Error("XCM wrapper reads are not configured");
      }
      const deploymentBlock = Number(this.config?.xcmWrapperDeploymentBlock);
      if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) {
        throw new Error("XCM wrapper deployment block is not configured");
      }
      const headBlock = Number(await this.provider.getBlockNumber());
      if (!Number.isSafeInteger(headBlock) || headBlock < deploymentBlock) {
        throw new Error(`XCM wrapper head ${headBlock} predates deployment block ${deploymentBlock}`);
      }
      const events = await this.#readXcmStrategyRegistryEvents(deploymentBlock, headBlock);
      const strategyIds = [...new Set(events.map((event) => event.strategyId))];
      const at = { blockTag: headBlock };
      const rows = [];
      for (const strategyId of strategyIds) {
        const adapter = getAddress(await this.xcmWrapperContract.strategyAdapter(strategyId, at));
        if (adapter === ZERO_ADDRESS) continue;
        rows.push(await this.readTreasuryStrategyLane({ strategyId, adapter, blockTag: headBlock }));
      }
      const block = await this.provider.getBlock(headBlock);
      return {
        available: true,
        wrapper: getAddress(this.config.xcmWrapperAddress),
        block: {
          number: headBlock,
          hash: block?.hash ?? null,
          timestamp: block?.timestamp === undefined ? undefined : Number(block.timestamp),
          timestampIso: block?.timestamp === undefined
            ? undefined
            : new Date(Number(block.timestamp) * 1_000).toISOString()
        },
        rows
      };
    });
  }

  async readTreasuryStrategyLane({ strategyId, adapter, blockTag }) {
    const at = { blockTag };
    const adapterContract = new Contract(adapter, STRATEGY_ADAPTER_ABI, this.provider);
    const [adapterStrategyId, asset, riskLabel, approved] = await Promise.all([
      adapterContract.strategyId(at),
      adapterContract.asset(at),
      adapterContract.riskLabel(at),
      this.policyContract.approvedStrategies(adapter, at)
    ]);
    if (String(adapterStrategyId).toLowerCase() !== strategyId) {
      throw new Error(`Wrapper strategy ${strategyId} points to an adapter with a different strategyId`);
    }
    const isPoolLane = strategyId === POOL_STRATEGY_ID;
    if (isPoolLane && !this.depositPoolContract) {
      throw new Error("Pool strategy is registered but DepositPool reads are not configured");
    }
    const allocationRaw = isPoolLane
      ? await this.depositPoolContract.venuePrincipalCostBasis(at)
      : await adapterContract.totalAssets(at);
    const assetConfig = (this.config.supportedAssets ?? []).find(
      (candidate) => String(candidate.address).toLowerCase() === String(asset).toLowerCase()
    );
    if (!assetConfig) {
      throw new Error(`Registered strategy ${strategyId} uses an unsupported asset`);
    }
    return {
      strategyId,
      strategyLabel: decodeStrategyLabel(strategyId),
      laneAddress: adapter,
      asset: getAddress(asset),
      assetSymbol: assetConfig.symbol,
      riskLabel: String(riskLabel),
      allocation: this.toDisplayUnits(allocationRaw, assetConfig),
      allocationRaw: this.toRawString(allocationRaw),
      allocationSource: isPoolLane
        ? "DepositPool.venuePrincipalCostBasis"
        : "strategyAdapter.totalAssets",
      policyApproved: Boolean(approved),
      verdict: deriveStrategyLaneVerdict({ approved: Boolean(approved) })
    };
  }

  async #readXcmStrategyRegistryEvents(deploymentBlock, headBlock) {
    if (this.xcmStrategyRegistryEventCache?.headBlock === headBlock) {
      return this.xcmStrategyRegistryEventCache.events;
    }
    const canExtend = this.xcmStrategyRegistryEventCache
      && this.xcmStrategyRegistryEventCache.headBlock >= deploymentBlock
      && this.xcmStrategyRegistryEventCache.headBlock < headBlock;
    const fromBlock = canExtend ? this.xcmStrategyRegistryEventCache.headBlock + 1 : deploymentBlock;
    const events = canExtend ? [...this.xcmStrategyRegistryEventCache.events] : [];
    const topic0 = this.xcmWrapperContract.interface.getEvent("StrategyAdapterUpdated").topicHash;
    for (let start = fromBlock; start <= headBlock; start += XCM_STRATEGY_EVENT_LOG_CHUNK_SIZE) {
      const end = Math.min(headBlock, start + XCM_STRATEGY_EVENT_LOG_CHUNK_SIZE - 1);
      const logs = await this.provider.getLogs({
        address: this.config.xcmWrapperAddress,
        topics: [topic0],
        fromBlock: start,
        toBlock: end
      });
      for (const log of logs) {
        const decoded = this.xcmWrapperContract.interface.parseLog(log);
        events.push({
          strategyId: String(decoded.args.strategyId).toLowerCase(),
          blockNumber: Number(log.blockNumber),
          logIndex: Number(log.index ?? log.logIndex ?? 0)
        });
      }
    }
    events.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
    this.xcmStrategyRegistryEventCache = { headBlock, events };
    return events;
  }

  async getActiveCreditPoolLoans(wallet) {
    return this.withGatewayError("getActiveCreditPoolLoans", async () => {
      if (!this.creditPoolContract) throw new Error("CreditPool reads are not configured");
      const normalizedWallet = getAddress(wallet);
      const events = await this.readCreditPoolLoanEvents();
      const closed = new Set(events
        .filter((event) => event.type === "LoanClosed")
        .map((event) => event.loanId));
      const loanIds = [...new Set(events
        .filter((event) => event.type === "LoanOriginated"
          && String(event.borrower).toLowerCase() === normalizedWallet.toLowerCase()
          && !closed.has(event.loanId))
        .map((event) => event.loanId))];
      const headBlock = Number(await this.provider.getBlockNumber());
      const loans = await Promise.all(loanIds.map(async (loanId) => {
        const value = await this.creditPoolContract.loans(loanId, { blockTag: headBlock });
        return {
          loanId,
          borrower: getAddress(value.borrower),
          blockNumber: headBlock,
          outstandingPrincipalRaw: this.toRawString(value.outstandingPrincipal),
          outstandingInterestRaw: this.toRawString(value.outstandingInterest),
          outstandingRaw: this.toRawString(
            BigInt(value.outstandingPrincipal) + BigInt(value.outstandingInterest)
          ),
          pledgedSharesRaw: this.toRawString(value.pledgeShares),
          status: Number(value.status)
        };
      }));
      return loans.filter((loan) => loan.status === 1 && loan.borrower === normalizedWallet);
    });
  }

  async getDefaultClaimStakeBps() {
    return this.withGatewayError("getDefaultClaimStakeBps", async () => Number(await this.policyContract.defaultClaimStakeBps()));
  }

  async getClaimEconomicsConfig({
    requireWaiverInputs = false,
    requireBondInputs = false
  } = {}) {
    return this.withGatewayError("getClaimEconomicsConfig", async () => {
      const optional = async (promise, fallback) => promise.catch(() => fallback);
      const onboardingWaiverClaimCountRead = this.policyContract.onboardingWaiverClaimCount();
      const [claimFeeBps, claimFeeVerifierBps, onboardingWaiverClaimCount] = await Promise.all([
        requireBondInputs
          ? this.policyContract.claimFeeBps()
          : optional(this.policyContract.claimFeeBps(), 0),
        optional(this.policyContract.claimFeeVerifierBps(), 7000),
        requireWaiverInputs
          ? onboardingWaiverClaimCountRead
          : optional(onboardingWaiverClaimCountRead, 0)
      ]);
      const minClaimFeeByAsset = {};
      const minClaimFeeRawByAsset = {};
      await Promise.all((this.config.supportedAssets ?? []).map(async (asset) => {
        const symbol = asset.symbol ?? this.resolveAssetSymbol(asset.address);
        const rawMinimum = requireBondInputs
          ? await this.policyContract.minClaimFeeByAsset(asset.address)
          : await optional(this.policyContract.minClaimFeeByAsset(asset.address), 0);
        minClaimFeeByAsset[symbol] = this.toDisplayUnits(
          rawMinimum,
          asset
        );
        minClaimFeeRawByAsset[symbol] = this.toRawString(rawMinimum);
      }));
      return {
        claimFeeBps: Number(claimFeeBps),
        claimFeeVerifierBps: Number(claimFeeVerifierBps),
        onboardingWaiverClaimCount: Number(onboardingWaiverClaimCount),
        minClaimFeeByAsset,
        minClaimFeeRawByAsset
      };
    });
  }

  async getDisputeWindowSeconds() {
    return this.withGatewayError(
      "getDisputeWindowSeconds",
      async () => Number(await this.escrowContract.DISPUTE_WINDOW())
    );
  }

  async getProtocolFeeConfig() {
    return this.withGatewayError("getProtocolFeeConfig", async () => {
      if (typeof this.escrowContract?.protocolFeeBps !== "function") {
        return {
          supported: false,
          protocolFeeBps: 0,
          maxProtocolFeeBps: 0,
          treasuryAccount: undefined
        };
      }
      const gasRetentionSupported = await this.readGasRetentionCapability(this.escrowContract);
      const [protocolFeeBps, maxProtocolFeeBps, treasuryAccount, posterFeeFloorRaw] = await Promise.all([
        this.escrowContract.protocolFeeBps(),
        this.escrowContract.MAX_PROTOCOL_FEE_BPS(),
        this.escrowContract.treasuryAccount(),
        gasRetentionSupported
          ? this.escrowContract.posterFeeFloorRaw()
          : 0n
      ]);
      return {
        supported: true,
        protocolFeeBps: Number(protocolFeeBps),
        posterFeeBps: Number(protocolFeeBps),
        posterFeeFloorRaw: this.toRawString(posterFeeFloorRaw),
        gasRetentionSupported,
        maxProtocolFeeBps: Number(maxProtocolFeeBps),
        treasuryAccount
      };
    });
  }

  async previewProtocolFeeForAsset(assetSymbol, rewardAmount) {
    return this.withGatewayError("previewProtocolFeeForAsset", async () => {
      const asset = this.requireAsset(assetSymbol);
      const rewardAmountRaw = this.toBaseUnits(rewardAmount, asset, "job reward");
      if (typeof this.escrowContract?.previewProtocolFee !== "function") {
        return {
          asset: asset.symbol,
          rewardAmount: this.toDisplayUnits(rewardAmountRaw, asset),
          rewardAmountRaw: rewardAmountRaw.toString(),
          protocolFeeAmount: 0,
          protocolFeeAmountRaw: "0",
          protocolFeeBps: 0
        };
      }
      const gasRetentionSupported = await this.readGasRetentionCapability(this.escrowContract);
      const [protocolFeeAmountRaw, protocolFeeBps, posterFeeFloorRaw] = await Promise.all([
        this.escrowContract.previewProtocolFee(rewardAmountRaw),
        this.escrowContract.protocolFeeBps(),
        gasRetentionSupported
          ? this.escrowContract.posterFeeFloorRaw()
          : 0n
      ]);
      return {
        asset: asset.symbol,
        rewardAmount: this.toDisplayUnits(rewardAmountRaw, asset),
        rewardAmountRaw: rewardAmountRaw.toString(),
        protocolFeeAmount: this.toDisplayUnits(protocolFeeAmountRaw, asset),
        protocolFeeAmountRaw: protocolFeeAmountRaw.toString(),
        protocolFeeBps: Number(protocolFeeBps),
        posterFeeFloorRaw: posterFeeFloorRaw.toString()
      };
    });
  }

  async getWorkerClaimCount(wallet) {
    return this.withGatewayError("getWorkerClaimCount", async () => {
      if (typeof this.escrowContract?.workerClaimCount !== "function") {
        throw new Error("EscrowCore.workerClaimCount selector is unavailable");
      }
      return Number(await this.escrowContract.workerClaimCount(wallet));
    });
  }

  async getClaimEconomicsDecisionState(jobId) {
    return this.withGatewayError("getClaimEconomicsDecisionState", async () => {
      const live = await this.readEscrowJob(jobId);
      const contractLayout = live.contractLayout === "legacy" ? "legacy" : "current";
      const escrowContract = this.escrowContractForLiveJob(live);
      const exists = Number(live.state) !== 0;
      const claimFeeRetainedOnSuccess = contractLayout === "current"
        && await this.readRetainedClaimFeeCapability(escrowContract);
      const gasRetentionSupported = contractLayout === "current"
        && await this.readGasRetentionCapability(escrowContract);
      if (contractLayout === "legacy" || !exists) {
        return {
          state: Number(live.state),
          exists,
          contractLayout,
          onboardingWaiverEligible: false,
          claimFeeRetainedOnSuccess,
          gasRetentionSupported
        };
      }
      if (typeof escrowContract?.onboardingWaiverEligibleJobs !== "function") {
        throw new Error("EscrowCore.onboardingWaiverEligibleJobs selector is unavailable");
      }
      return {
        state: Number(live.state),
        exists,
        contractLayout,
        claimFeeRetainedOnSuccess,
        gasRetentionSupported,
        onboardingWaiverEligible: Boolean(
          await escrowContract.onboardingWaiverEligibleJobs(this.toJobId(jobId))
        )
      };
    });
  }

  async readRetainedClaimFeeCapability(escrowContract) {
    if (typeof escrowContract?.retainsClaimFeeOnSuccess !== "function") return false;
    try {
      return Boolean(await escrowContract.retainsClaimFeeOnSuccess());
    } catch {
      // A predecessor runtime or a temporarily unreadable optional capability
      // fails conservatively: brokered gas remains operator exposure.
      return false;
    }
  }

  async readGasRetentionCapability(escrowContract) {
    if (typeof escrowContract?.supportsGasRetention !== "function") return false;
    try {
      return Boolean(await escrowContract.supportsGasRetention());
    } catch {
      return false;
    }
  }

  async previewGasRetentionForJob(jobId, assetSymbol, rewardAmount, { brokered, waived } = {}) {
    return this.withGatewayError("previewGasRetentionForJob", async () => {
      const live = await this.readEscrowJob(jobId);
      const escrowContract = this.escrowContractForLiveJob(live);
      const supported = await this.readGasRetentionCapability(escrowContract);
      const asset = this.requireAsset(assetSymbol);
      const rewardRaw = this.toBaseUnits(rewardAmount, asset, "job reward");
      if (!supported) {
        return {
          supported: false,
          brokered: Boolean(brokered),
          waived: Boolean(waived),
          retainedRaw: "0",
          retained: 0,
          netRewardRaw: rewardRaw.toString(),
          netReward: this.toDisplayUnits(rewardRaw, asset)
        };
      }
      const [flatRaw, capBps, retainedRaw] = await Promise.all([
        escrowContract.retentionFlatRaw(),
        escrowContract.retentionCapBps(),
        escrowContract.previewGasRetention(rewardRaw, Boolean(brokered), Boolean(waived))
      ]);
      return {
        supported: true,
        brokered: Boolean(brokered),
        waived: Boolean(waived),
        retentionFlatRaw: this.toRawString(flatRaw),
        retentionFlat: this.toDisplayUnits(flatRaw, asset),
        retentionCapBps: Number(capBps),
        rewardRaw: rewardRaw.toString(),
        retainedRaw: retainedRaw.toString(),
        retained: this.toDisplayUnits(retainedRaw, asset),
        netRewardRaw: (rewardRaw - retainedRaw).toString(),
        netReward: this.toDisplayUnits(rewardRaw - retainedRaw, asset),
        source: "escrow_v3_claim_schedule"
      };
    });
  }

  async readDepositVesting(wallet, {
    now = new Date(this.now()),
    vestingHours = DEFAULT_WORKER_DEPOSIT_VESTING_HOURS
  } = {}) {
    try {
      const [events, creditEvents] = await Promise.all([
        this.readDepositPoolPrincipalEvents(),
        this.config?.creditPoolAddress ? this.readCreditPoolLoanEvents() : []
      ]);
      const migration = this.config?.depositPoolVestingMigration;
      const migratedWallet = migration?.wallet?.toLowerCase() === String(wallet).toLowerCase();
      return {
        ...calculateDepositVesting(events, {
          wallet,
          now,
          vestingHours,
          creditEvents,
          initialTranches: migratedWallet ? migration.preservedTranches : []
        }),
        available: true,
        source: "deposit_pool_events",
        headBlock: this.depositPoolVestingEventCache?.headBlock
      };
    } catch (error) {
      this.logger?.warn?.(
        { wallet, error: redactProviderError(error) || "deposit_pool_vesting_read_failed" },
        "deposit_pool_vesting.read_failed"
      );
      return {
        vestedRaw: 0n,
        principalRaw: 0n,
        vestingHours,
        evaluatedAt: new Date(now).toISOString(),
        tranches: [],
        available: false,
        source: "deposit_pool_events",
        error: "deposit_pool_vesting_read_failed"
      };
    }
  }

  async readDepositPoolPrincipalEvents() {
    const poolAddress = this.config?.depositPoolV2Address ?? this.config?.depositPoolAddress;
    const deploymentBlock = Number(
      this.config?.depositPoolV2Address
        ? this.config?.depositPoolV2DeploymentBlock
        : this.config?.depositPoolDeploymentBlock
    );
    if (!this.provider || !poolAddress || !Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) {
      throw new Error("DepositPool event history is not configured");
    }
    const poolInterface = (this.depositPoolV2Contract ?? this.depositPoolContract)?.interface;
    if (typeof poolInterface?.parseLog !== "function") {
      throw new Error("DepositPool event interface is unavailable");
    }

    const headBlock = Number(await this.provider.getBlockNumber());
    if (!Number.isSafeInteger(headBlock) || headBlock < deploymentBlock) {
      throw new Error(`DepositPool event head ${headBlock} predates deployment block ${deploymentBlock}`);
    }
    if (this.depositPoolVestingEventCache?.headBlock === headBlock) {
      return this.depositPoolVestingEventCache.events;
    }

    const canExtend = this.depositPoolVestingEventCache
      && this.depositPoolVestingEventCache.headBlock >= deploymentBlock
      && this.depositPoolVestingEventCache.headBlock < headBlock;
    const fromBlock = canExtend
      ? this.depositPoolVestingEventCache.headBlock + 1
      : deploymentBlock;
    const decodedEvents = canExtend
      ? [...this.depositPoolVestingEventCache.events]
      : [];
    const logs = [];
    for (let start = fromBlock; start <= headBlock; start += DEPOSIT_POOL_EVENT_LOG_CHUNK_SIZE) {
      const end = Math.min(headBlock, start + DEPOSIT_POOL_EVENT_LOG_CHUNK_SIZE - 1);
      logs.push(...await this.provider.getLogs({ address: poolAddress, fromBlock: start, toBlock: end }));
    }

    const principalLogs = [];
    for (const log of logs) {
      let decoded;
      try {
        decoded = poolInterface.parseLog(log);
      } catch {
        continue;
      }
      if (decoded?.name !== "Deposit" && decoded?.name !== "Withdraw") continue;
      const ignoredMigrationDeposit = this.config?.depositPoolVestingMigration?.ignoredTransferEvents?.newDepositTx;
      if (ignoredMigrationDeposit && String(log.transactionHash).toLowerCase() === ignoredMigrationDeposit) continue;
      principalLogs.push({
        type: decoded.name,
        owner: String(decoded.args.owner),
        assetsRaw: BigInt(decoded.args.assets).toString(),
        blockNumber: Number(log.blockNumber),
        logIndex: Number(log.index ?? log.logIndex ?? 0),
        txHash: log.transactionHash
      });
    }

    const timestamps = new Map();
    await Promise.all([...new Set(principalLogs.map((event) => event.blockNumber))].map(async (blockNumber) => {
      const block = await this.provider.getBlock(blockNumber);
      const timestamp = Number(block?.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new Error(`DepositPool event block ${blockNumber} has no readable timestamp`);
      }
      timestamps.set(blockNumber, timestamp);
    }));
    decodedEvents.push(...principalLogs.map((event) => ({
      ...event,
      blockTimestamp: timestamps.get(event.blockNumber)
    })));
    decodedEvents.sort((left, right) => (
      left.blockNumber - right.blockNumber || left.logIndex - right.logIndex
    ));
    this.depositPoolVestingEventCache = { headBlock, events: decodedEvents };
    return decodedEvents;
  }

  async readCreditPoolLoanEvents() {
    const poolAddress = this.config?.creditPoolAddress;
    const deploymentBlock = Number(this.config?.creditPoolDeploymentBlock);
    if (!this.provider || !poolAddress || !Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) {
      throw new Error("CreditPool event history is not configured");
    }
    const poolInterface = this.creditPoolContract?.interface;
    if (typeof poolInterface?.parseLog !== "function") {
      throw new Error("CreditPool event interface is unavailable");
    }
    const headBlock = Number(await this.provider.getBlockNumber());
    if (!Number.isSafeInteger(headBlock) || headBlock < deploymentBlock) {
      throw new Error(`CreditPool event head ${headBlock} predates deployment block ${deploymentBlock}`);
    }
    if (this.creditPoolVestingEventCache?.headBlock === headBlock) {
      return this.creditPoolVestingEventCache.events;
    }
    const canExtend = this.creditPoolVestingEventCache
      && this.creditPoolVestingEventCache.headBlock >= deploymentBlock
      && this.creditPoolVestingEventCache.headBlock < headBlock;
    const fromBlock = canExtend ? this.creditPoolVestingEventCache.headBlock + 1 : deploymentBlock;
    const decodedEvents = canExtend ? [...this.creditPoolVestingEventCache.events] : [];
    const logs = [];
    for (let start = fromBlock; start <= headBlock; start += CREDIT_POOL_EVENT_LOG_CHUNK_SIZE) {
      const end = Math.min(headBlock, start + CREDIT_POOL_EVENT_LOG_CHUNK_SIZE - 1);
      logs.push(...await this.provider.getLogs({ address: poolAddress, fromBlock: start, toBlock: end }));
    }
    const loanBorrowers = new Map(
      decodedEvents
        .filter((event) => event.type === "LoanOriginated")
        .map((event) => [event.loanId, event.borrower])
    );
    const relevant = [];
    for (const log of logs) {
      let decoded;
      try {
        decoded = poolInterface.parseLog(log);
      } catch {
        continue;
      }
      if (decoded?.name !== "LoanOriginated" && decoded?.name !== "LoanClosed") continue;
      const loanId = String(decoded.args.loanId).toLowerCase();
      if (decoded.name === "LoanOriginated") loanBorrowers.set(loanId, String(decoded.args.borrower));
      relevant.push({
        type: decoded.name,
        loanId,
        borrower: decoded.name === "LoanOriginated"
          ? String(decoded.args.borrower)
          : loanBorrowers.get(loanId),
        blockNumber: Number(log.blockNumber),
        logIndex: Number(log.index ?? log.logIndex ?? 0),
        txHash: log.transactionHash
      });
    }
    const timestamps = new Map();
    await Promise.all([...new Set(relevant.map((event) => event.blockNumber))].map(async (blockNumber) => {
      const block = await this.provider.getBlock(blockNumber);
      const timestamp = Number(block?.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < 0) {
        throw new Error(`CreditPool event block ${blockNumber} has no readable timestamp`);
      }
      timestamps.set(blockNumber, timestamp);
    }));
    decodedEvents.push(...relevant.map((event) => ({
      ...event,
      blockTimestamp: timestamps.get(event.blockNumber)
    })));
    decodedEvents.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
    this.creditPoolVestingEventCache = { headBlock, events: decodedEvents };
    return decodedEvents;
  }

  async readCreditPosition(wallet) {
    if (!this.creditPoolContract || !this.depositPoolV2Contract) {
      return { available: false, reason: "credit_pool_not_configured" };
    }
    return this.withGatewayError("readCreditPosition", async () => {
      const normalizedWallet = getAddress(wallet);
      const [outstandingDebt, pledgedShares, depositedShares, vested] = await Promise.all([
        this.creditPoolContract.outstandingDebt(normalizedWallet),
        this.depositPoolV2Contract.pledgedShares(normalizedWallet),
        this.depositPoolV2Contract.balanceOf(normalizedWallet),
        this.readDepositVesting(normalizedWallet)
      ]);
      const pledgedAssets = await this.depositPoolV2Contract.convertToAssets(pledgedShares);
      const ltvBps = await this.creditPoolContract.ltvBps();
      const collateralBase = BigInt(pledgedAssets) < BigInt(vested.vestedRaw)
        ? BigInt(pledgedAssets)
        : BigInt(vested.vestedRaw);
      const grossWalletLimit = collateralBase * BigInt(ltvBps) / 10_000n;
      const loanable = grossWalletLimit > BigInt(outstandingDebt)
        ? grossWalletLimit - BigInt(outstandingDebt)
        : 0n;
      return {
        available: Boolean(vested.available),
        outstandingDebtRaw: this.toRawString(outstandingDebt),
        depositedSharesRaw: this.toRawString(depositedShares),
        pledgedSharesRaw: this.toRawString(pledgedShares),
        pledgedAssetsRaw: this.toRawString(pledgedAssets),
        vestedRaw: this.toRawString(vested.vestedRaw),
        grossWalletLimitRaw: this.toRawString(grossWalletLimit),
        loanableRaw: this.toRawString(loanable),
        ltvBps: Number(ltvBps),
        source: "credit_pool_and_deposit_pool_v2_live_reads"
      };
    });
  }

  async signCreditVestingAttestation({ borrower, loanId, pledgeShares, amount, vestedRaw, validUntil, nonce }) {
    this.requireSigner("signCreditVestingAttestation");
    if (!this.creditPoolContract || !this.config?.creditPoolAddress) {
      throw new ConfigError("CreditPool is not configured.");
    }
    const [network, operator, signerAddress] = await Promise.all([
      this.provider.getNetwork(),
      this.creditPoolContract.operator(),
      this.signer.getAddress()
    ]);
    if (String(operator).toLowerCase() !== String(signerAddress).toLowerCase()) {
      throw new ConfigError("Configured signer is not the CreditPool vesting attestor.");
    }
    const payloadHash = keccak256(abiCoder.encode(
      ["bytes32", "address", "bytes32", "uint256", "uint256", "uint256", "uint64", "uint256", "uint256", "address"],
      [
        VESTING_ATTESTATION_TYPEHASH,
        getAddress(borrower),
        this.toBytes32Value(loanId, "loanId"),
        this.normalizeUint256(pledgeShares, "pledgeShares"),
        this.normalizeUint256(amount, "amount"),
        this.normalizeUint256(vestedRaw, "vestedRaw"),
        this.normalizeUint256(validUntil, "validUntil"),
        this.normalizeUint256(nonce, "nonce"),
        network.chainId,
        this.config.creditPoolAddress
      ]
    ));
    return this.signer.signMessage(getBytes(payloadHash));
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
            signerIsStrategySettler: false,
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
        signerIsAgentTransferBroker,
        signerIsStrategySettler,
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
        signerAddress && typeof this.policyContract.agentTransferBroker === "function"
          ? optionalBool("agentTransferBroker(signer)", this.policyContract.agentTransferBroker(signerAddress))
          : false,
        signerAddress && typeof this.policyContract.strategySettler === "function"
          ? optionalBool("strategySettler(signer)", this.policyContract.strategySettler(signerAddress))
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
          signerIsAgentTransferBroker,
          signerIsStrategySettler,
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
      const hasRequestedShares = requestedShares !== undefined
        && requestedShares !== null
        && String(requestedShares).trim() !== "";
      const shares = hasRequestedShares
        ? this.toBaseUnits(requestedShares, asset, "strategy withdraw shares")
        : await this.quoteStrategySharesForAssets(strategy, baseAmount);
      if (shares <= 0n) {
        throw new ValidationError("strategy withdraw shares must be greater than zero.");
      }
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

  /**
   * Relay an already-signed AgentAccountCore transfer without converting the
   * amount through display units. Recovery callers sign the contract's exact
   * raw uint256 amount, so a decimal round-trip here would invalidate both the
   * EIP-712 authorization and the accounting proof.
   */
  async submitAuthorizedAgentTransfer({ from, recipient, asset, amountRaw, nonce, deadline, signature }) {
    return this.withGatewayError("submitAuthorizedAgentTransfer", async () => {
      this.requireSigner("submitAuthorizedAgentTransfer");
      const normalizedFrom = getAddress(from);
      const normalizedRecipient = getAddress(recipient);
      const normalizedAsset = getAddress(asset);
      const supported = (this.config.supportedAssets ?? []).find(
        (candidate) => candidate.address?.toLowerCase() === normalizedAsset.toLowerCase()
      );
      if (!supported) {
        throw new ValidationError(`Unsupported asset address: ${normalizedAsset}`);
      }
      const amount = this.normalizeUint256(amountRaw, "amount");
      if (amount === 0n) {
        throw new ValidationError("amount must be positive.");
      }
      const normalizedNonce = this.normalizeUint256(nonce, "nonce");
      const normalizedDeadline = this.normalizeUint256(deadline, "deadline");
      const normalizedSignature = this.normalizeSignature(signature, "signature");

      const tx = await this.accountContract.sendToAgentFor(
        normalizedFrom,
        normalizedRecipient,
        normalizedAsset,
        amount,
        normalizedNonce,
        normalizedDeadline,
        normalizedSignature
      );
      const receipt = await tx.wait();
      const transfer = (receipt?.logs ?? []).map((log) => {
        try {
          return this.accountContract.interface.parseLog(log);
        } catch {
          return null;
        }
      }).find((parsed) => parsed?.name === "AgentTransfer"
        && String(parsed.args.from).toLowerCase() === normalizedFrom.toLowerCase()
        && String(parsed.args.to).toLowerCase() === normalizedRecipient.toLowerCase()
        && String(parsed.args.asset).toLowerCase() === normalizedAsset.toLowerCase()
        && BigInt(parsed.args.amount) === amount);
      if (!transfer) {
        throw new ExternalServiceError(
          "Agent transfer transaction confirmed without the exact AgentTransfer event.",
          "agent_transfer_event_missing",
          { operation: "submitAuthorizedAgentTransfer", txHash: receipt?.hash ?? tx.hash }
        );
      }
      return {
        txHash: receipt?.hash ?? tx.hash,
        blockNumber: Number(receipt.blockNumber),
        from: normalizedFrom,
        recipient: normalizedRecipient,
        asset: normalizedAsset,
        amountRaw: amount.toString()
      };
    });
  }

  async claimJob(jobId, wallet) {
    return this.withGatewayError("claimJob", async () => {
      this.requireSigner("claimJob");
      const chainJobId = this.toJobId(jobId);
      const escrowContract = await this.escrowContractForJob(jobId);
      const signerAddress = await this.signer.getAddress();
      const tx = wallet && wallet.toLowerCase() !== signerAddress.toLowerCase()
        ? await escrowContract.claimJobFor(chainJobId, wallet)
        : await escrowContract.claimJob(chainJobId);
      await tx.wait();
    });
  }

  async prepareDirectClaimJob(jobId) {
    return this.withGatewayError("prepareDirectClaimJob", async () => {
      const live = await this.readEscrowJob(jobId);
      const escrowContract = this.escrowContractForLiveJob(live);
      return {
        to: live.escrowAddress,
        value: "0",
        function: "claimJob(bytes32)",
        args: [this.toJobId(jobId)],
        data: escrowContract.interface.encodeFunctionData("claimJob", [this.toJobId(jobId)])
      };
    });
  }

  async handleClaimTimeout(jobId) {
    return this.withGatewayError("handleClaimTimeout", async () => {
      this.requireSigner("handleClaimTimeout");
      const escrowContract = await this.escrowContractForJob(jobId);
      const tx = await escrowContract.handleClaimTimeout(this.toJobId(jobId));
      await tx.wait();
    });
  }

  async previewClaimEconomics(wallet, jobId) {
    return this.withGatewayError("previewClaimEconomics", async () => {
      const live = await this.readEscrowJob(jobId);
      const escrowContract = this.escrowContractForLiveJob(live);
      const economics = await escrowContract.previewClaimEconomics(wallet, this.toJobId(jobId));
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
        await this.ensureOnboardingWaiverEligibility(
          this.toJobId(instanceJobId),
          job,
          live.contractLayout,
          live.escrowAddress
        );
        return this.publicEscrowJob(live);
      }

      const rewardAmount = this.toBaseUnits(job.rewardAmount ?? 0, asset, "job reward");
      const claimStake = this.toBaseUnits(claimStakeAmount ?? 0, asset, "claim lock amount");
      const usesRecurringTemplateReserve = this.usesRecurringTemplateReserve(job);
      const protocolFeeWaived = job?.onboardingWaiverEligible === true;
      const protocolFee = (
        protocolFeeWaived
        || live.contractLayout !== "rc1"
        || typeof this.escrowContract?.previewProtocolFee !== "function"
      )
        ? 0n
        : BigInt(await this.escrowContract.previewProtocolFee(rewardAmount));
      const totalRequired = usesRecurringTemplateReserve
        ? rewardAmount + protocolFee
        : rewardAmount + protocolFee + claimStake;
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
      await this.ensureOnboardingWaiverEligibility(
        this.toJobId(instanceJobId),
        job,
        live.contractLayout,
        live.escrowAddress
      );
      return this.getJob(instanceJobId);
    });
  }

  async getPooledFundingAccount() {
    return this.withGatewayError("getPooledFundingAccount", async () => {
      this.requireSigner("getPooledFundingAccount");
      return String(await this.signer.getAddress()).toLowerCase();
    });
  }

  async createEscrowFundedExternalJob(draft) {
    return this.withGatewayError("createEscrowFundedExternalJob", async () => {
      this.requireSigner("createEscrowFundedExternalJob");
      const args = Array.isArray(draft?.calldata?.args) ? draft.calldata.args : [];
      if (args.length !== 9 || String(args[0]).toLowerCase() !== String(draft?.jobId).toLowerCase()) {
        throw new ValidationError(
          "Escrow-funded external job requires the deterministic nine-field creation recipe."
        );
      }
      const asset = this.requireAsset(draft?.definition?.rewardAsset ?? "USDC");
      if (String(args[1]).toLowerCase() !== asset.address.toLowerCase()) {
        throw new ValidationError("Escrow-funded external job asset does not match the configured Hub asset.");
      }
      const live = await this.readEscrowJob(draft.jobId);
      if (Number(live.state) !== 0) {
        throw new ConflictError(
          "The deterministic Hub escrow job already exists. No payment was settled; request a fresh posting definition.",
          "external_escrow_job_exists",
          { jobId: draft.jobId, action: "change_definition_and_retry", posterFunds: "unchanged" }
        );
      }

      const rewardRaw = exactUint(args[2], "external reward");
      const opsReserveRaw = exactUint(args[3], "external ops reserve");
      const contingencyReserveRaw = exactUint(args[4], "external contingency reserve");
      const escrowContract = this.escrowContractForLiveJob(live);
      if (typeof escrowContract?.previewProtocolFee !== "function") {
        throw new ExternalServiceError(
          "Hub escrow cannot quote the current protocol fee. No payment was settled; wait for the Hub service to recover and retry.",
          "external_escrow_fee_unavailable",
          { action: "retry_when_hub_healthy", posterFunds: "unchanged" }
        );
      }
      const protocolFeeRaw = BigInt(await escrowContract.previewProtocolFee(rewardRaw));
      const requiredRaw = rewardRaw + opsReserveRaw + contingencyReserveRaw + protocolFeeRaw;
      const quotedRequiredRaw = exactUint(
        draft?.fundingRequirement?.posterReservedRaw,
        "quoted external reserve"
      );
      if (requiredRaw !== quotedRequiredRaw) {
        throw new ConflictError(
          "The live Hub protocol fee changed after the 402 quote. No payment was settled; request a fresh 402 response before retrying.",
          "external_escrow_quote_expired",
          {
            action: "retry_for_fresh_quote",
            posterFunds: "unchanged",
            quotedRaw: quotedRequiredRaw.toString(),
            currentRaw: requiredRaw.toString()
          }
        );
      }

      const pooledAccount = String(await this.signer.getAddress()).toLowerCase();
      const position = await this.accountContract.positions(pooledAccount, asset.address);
      const availableRaw = BigInt(position.liquid ?? 0);
      if (availableRaw < requiredRaw) {
        throw new InsufficientLiquidityError(asset.symbol, {
          reason: "x402_pooled_float_shortfall",
          requiredRaw: requiredRaw.toString(),
          availableRaw: availableRaw.toString(),
          shortfallRaw: (requiredRaw - availableRaw).toString(),
          account: pooledAccount,
          action: "retry_after_float_rebalance",
          posterFunds: "unchanged"
        });
      }

      const tx = await this.createSinglePayoutJobForJob(
        { ...draft.definition, id: draft.jobId },
        live.contractLayout,
        String(args[0]),
        asset.address,
        rewardRaw,
        opsReserveRaw,
        contingencyReserveRaw,
        Number(args[5]),
        String(args[6]),
        String(args[7]),
        String(args[8])
      );
      const receipt = await tx.wait();
      let fundedAt = new Date().toISOString();
      try {
        const block = await this.provider.getBlock(receipt.blockNumber);
        if (Number.isSafeInteger(Number(block?.timestamp))) {
          fundedAt = new Date(Number(block.timestamp) * 1000).toISOString();
        }
      } catch {
        // The receipt still proves finalized creation; wall time is an honest
        // fallback if the follow-up block timestamp read is unavailable.
      }
      return {
        jobId: String(args[0]).toLowerCase(),
        specHash: String(args[8]).toLowerCase(),
        poster: pooledAccount,
        asset: asset.address.toLowerCase(),
        reward: rewardRaw.toString(),
        opsReserve: opsReserveRaw.toString(),
        contingencyReserve: contingencyReserveRaw.toString(),
        fundedAt,
        txHash: String(tx.hash).toLowerCase(),
        blockNumber: String(receipt.blockNumber),
        finalized: true
      };
    });
  }

  async ensureOnboardingWaiverEligibility(
    chainJobId,
    job,
    contractLayout = "current",
    escrowAddress = this.config.escrowCoreAddress
  ) {
    if (contractLayout === "legacy" || job?.onboardingWaiverEligible !== true) {
      return;
    }
    const escrowContract = this.escrowContractForLiveJob({ contractLayout, escrowAddress });
    if (typeof escrowContract.onboardingWaiverEligibleJobs !== "function"
      || typeof escrowContract.setOnboardingWaiverEligible !== "function") {
      return;
    }
    let current = false;
    try {
      current = await escrowContract.onboardingWaiverEligibleJobs(chainJobId);
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
      tx = await escrowContract.setOnboardingWaiverEligible(chainJobId, true);
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
      const escrowContract = await this.escrowContractForJob(jobId);
      const evidenceHash = typeof evidence === "string" && /^0x[a-fA-F0-9]{64}$/u.test(evidence)
        ? evidence
        : hashCanonicalContent(evidence);
      const signerAddress = worker ? await this.signer.getAddress() : undefined;
      const tx = worker && worker.toLowerCase() !== signerAddress.toLowerCase()
        ? await escrowContract.submitWorkFor(chainJobId, worker, evidenceHash)
        : await escrowContract.submitWork(chainJobId, evidenceHash);
      await tx.wait();
    });
  }

  async prepareDirectSubmitWork(jobId, evidence) {
    return this.withGatewayError("prepareDirectSubmitWork", async () => {
      const live = await this.readEscrowJob(jobId);
      const escrowContract = this.escrowContractForLiveJob(live);
      const evidenceHash = typeof evidence === "string" && /^0x[a-fA-F0-9]{64}$/u.test(evidence)
        ? evidence
        : hashCanonicalContent(evidence);
      return {
        to: live.escrowAddress,
        value: "0",
        function: "submitWork(bytes32,bytes32)",
        args: [this.toJobId(jobId), evidenceHash],
        data: escrowContract.interface.encodeFunctionData(
          "submitWork",
          [this.toJobId(jobId), evidenceHash]
        )
      };
    });
  }

  async getLatestEvidence(jobId) {
    return this.withGatewayError("getLatestEvidence", async () => {
      const live = await this.readEscrowJob(jobId);
      const escrowContract = this.escrowContractForLiveJob(live);
      return String(await escrowContract.latestEvidence(this.toJobId(jobId))).toLowerCase();
    });
  }

  async resolveSinglePayout(jobId, approved, reasonCode, metadataURI, reasoningHash = ZERO_BYTES32) {
    return this.withGatewayError("resolveSinglePayout", async () => {
      this.requireSigner("resolveSinglePayout");
      const startedAt = Date.now();
      const escrowContract = await this.escrowContractForJob(jobId);
      const tx = await escrowContract.resolveSinglePayout(
        this.toJobId(jobId),
        approved,
        this.toReasonCode(reasonCode),
        metadataURI,
        reasoningHash
      );
      // Ethers wraps the runner's TransactionResponse in a
      // ContractTransactionResponse and may replace/drop its provider metadata.
      // Resolve the write endpoint by tx hash from the broadcaster first.
      const providerUsed = this.writeBroadcaster?.takeProviderUsed?.(tx.hash)
        ?? describeRpcProvider(tx.provider);
      this.logger?.info?.(
        {
          jobId,
          txHash: tx.hash,
          providerUsed,
          submitDurationMs: Date.now() - startedAt
        },
        "blockchain.resolve_single_payout.submitted"
      );
      // Return the settle/payout tx receipt (additive — mirrors openDispute /
      // resolveDispute below) so callers can surface the on-chain payout tx to
      // the worker instead of discarding it. Settlement behavior is unchanged.
      const receipt = await tx.wait();
      const settlement = this.extractSettlementSplit(receipt, escrowContract);
      const gasRetention = this.extractGasRetention(receipt, escrowContract);
      const durationMs = Date.now() - startedAt;
      this.logger?.info?.(
        {
          jobId,
          txHash: tx.hash,
          blockNumber: receipt?.blockNumber,
          durationMs,
          providerUsed
        },
        "blockchain.resolve_single_payout.confirmed"
      );
      return {
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        status: Number(receipt?.status ?? 0),
        ...(settlement ? { settlement: { ...settlement, ...(gasRetention ? { gasRetention } : {}) } } : {})
      };
    });
  }

  /**
   * Recover the successful resolveSinglePayout receipt after chain state moved
   * but the local terminal write did not. The exact job-bound terminal event
   * locates the transaction; approved payouts are then corroborated against
   * both SettlementSplit and the deployed five-field AAC ReservationSettled
   * logs. Any ambiguity or unavailable proof fails closed.
   */
  async recoverSinglePayoutReceipt(jobId, { outcome, worker, submittedAt } = {}) {
    return this.withGatewayError("recoverSinglePayoutReceipt", async () => {
      if (!this.provider) {
        throw new ExternalServiceError("Payout receipt recovery requires a readable chain provider.");
      }
      if (outcome !== "approved" && outcome !== "rejected") {
        throw new ValidationError(`Cannot recover terminal payout evidence for outcome ${JSON.stringify(outcome)}.`);
      }
      const chainJobId = this.toJobId(jobId).toLowerCase();
      const job = await this.readEscrowJob(jobId);
      const expectedState = outcome === "approved"
        ? ESCROW_JOB_STATE_CLOSED
        : ESCROW_JOB_STATE_REJECTED;
      if (Number(job.state) !== expectedState) {
        throw new ExternalServiceError(
          `Escrow job ${chainJobId} is state ${job.state}, expected terminal state ${expectedState}.`
        );
      }
      if (worker && !sameAddress(worker, job.worker)) {
        throw new ExternalServiceError(
          `Escrow worker ${job.worker} does not match session worker ${worker}.`
        );
      }

      const latestBlock = await this.provider.getBlockNumber();
      const submittedBlock = await this.findBlockAtOrAfterTimestamp(submittedAt, latestBlock);
      const fromBlock = Math.max(0, submittedBlock - RECOVERY_FROM_BLOCK_SAFETY_MARGIN);
      const escrowAddress = normalizedAddress(job.escrowAddress, "escrow recovery address");
      const terminalTopic0 = outcome === "approved" ? JOB_CLOSED_TOPIC0 : JOB_REJECTED_TOPIC0;
      const matches = await this.getLogsChunked({
        address: escrowAddress,
        topics: [terminalTopic0, chainJobId],
        fromBlock,
        toBlock: latestBlock
      });
      const txHashes = [...new Set(matches
        .map((log) => String(log.transactionHash ?? "").toLowerCase())
        .filter((value) => /^0x[a-f0-9]{64}$/u.test(value)))];
      if (txHashes.length !== 1) {
        throw new ExternalServiceError(
          `Terminal event lookup for ${chainJobId} found ${txHashes.length} transactions; expected exactly one.`
        );
      }

      const txHash = txHashes[0];
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt || Number(receipt.status) !== 1) {
        throw new ExternalServiceError(`Recovered transaction ${txHash} has no successful receipt.`);
      }
      if (receipt.to && !sameAddress(receipt.to, escrowAddress)) {
        throw new ExternalServiceError(
          `Recovered transaction ${txHash} targets ${receipt.to}, expected ${escrowAddress}.`
        );
      }
      const escrowContract = this.escrowContractForLiveJob(job);
      this.assertRecoveredTerminalEvent({
        receipt,
        escrowContract,
        escrowAddress,
        chainJobId,
        job,
        outcome
      });
      const settlement = outcome === "approved"
        ? this.extractRecoveredSettlement(receipt, escrowContract, job)
        : undefined;

      return {
        txHash,
        blockNumber: Number(receipt.blockNumber),
        status: Number(receipt.status),
        ...(settlement ? { settlement } : {})
      };
    });
  }

  async findBlockAtOrAfterTimestamp(timestamp, latestBlock) {
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) {
      throw new ValidationError("Payout receipt recovery requires the session submittedAt timestamp.");
    }
    let low = 0;
    let high = Number(latestBlock);
    if (!Number.isInteger(high) || high < 0) {
      throw new ExternalServiceError(`Chain returned invalid latest block ${latestBlock}.`);
    }
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const block = await this.provider.getBlock(middle);
      const blockTimestampMs = Number(block?.timestamp) * 1_000;
      if (!Number.isFinite(blockTimestampMs)) {
        throw new ExternalServiceError(`Chain block ${middle} has no readable timestamp.`);
      }
      if (blockTimestampMs < timestampMs) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  async getLogsChunked({ address, topics, fromBlock, toBlock }) {
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += RECOVERY_LOG_CHUNK_SIZE) {
      const end = Math.min(toBlock, start + RECOVERY_LOG_CHUNK_SIZE - 1);
      logs.push(...await this.provider.getLogs({ address, topics, fromBlock: start, toBlock: end }));
    }
    return logs;
  }

  assertRecoveredTerminalEvent({ receipt, escrowContract, escrowAddress, chainJobId, job, outcome }) {
    const expectedName = outcome === "approved" ? "JobClosed" : "JobRejected";
    const matches = [];
    for (const log of receipt.logs ?? []) {
      if (!sameAddress(log.address, escrowAddress)) continue;
      let parsed;
      try {
        parsed = escrowContract?.interface?.parseLog?.(log);
      } catch {
        continue;
      }
      if (parsed?.name === expectedName && String(parsed.args.jobId).toLowerCase() === chainJobId) {
        matches.push(parsed);
      }
    }
    if (matches.length !== 1) {
      throw new ExternalServiceError(
        `Recovered receipt has ${matches.length} job-bound ${expectedName} events; expected exactly one.`
      );
    }
    if (outcome === "approved") {
      const closed = matches[0];
      if (!sameAddress(closed.args.worker, job.worker)) {
        throw new ExternalServiceError("Recovered JobClosed worker does not match the live escrow job.");
      }
      if (closed.args.releasedAmount.toString() !== String(job.releasedRaw)) {
        throw new ExternalServiceError("Recovered JobClosed amount does not match the live escrow job.");
      }
    }
  }

  extractRecoveredSettlement(receipt, escrowContract, job) {
    const settlement = this.extractSettlementSplit(receipt, escrowContract);
    const gasRetention = this.extractGasRetention(receipt, escrowContract);
    if (!settlement) {
      throw new ExternalServiceError("Recovered approved receipt has no deployed SettlementSplit evidence.");
    }
    const retainedRaw = BigInt(gasRetention?.retainedRaw ?? "0");
    const grossWorkerRewardRaw = BigInt(settlement.workerAmountRaw) + retainedRaw;
    if (
      !sameAddress(settlement.worker, job.worker)
      || !sameAddress(settlement.asset, job.asset)
      || grossWorkerRewardRaw !== BigInt(job.releasedRaw)
      || settlement.protocolFeeAmountRaw !== String(job.protocolFeeReleasedRaw ?? "0")
      || (gasRetention && (
        !sameAddress(gasRetention.worker, job.worker)
        || gasRetention.rewardRaw !== String(job.releasedRaw)
      ))
    ) {
      throw new ExternalServiceError("Recovered SettlementSplit does not match the live escrow job.");
    }

    const reservations = [];
    const accountAddress = normalizedAddress(this.config.agentAccountAddress, "AgentAccountCore address");
    for (const log of receipt.logs ?? []) {
      if (
        !sameAddress(log.address, accountAddress)
        || String(log?.topics?.[0] ?? "").toLowerCase() !== RESERVATION_SETTLED_TOPIC0
      ) continue;
      let parsed;
      try {
        parsed = this.accountContract?.interface?.parseLog?.(log);
      } catch (error) {
        throw new ExternalServiceError(
          `Recovered ReservationSettled log does not match the deployed five-field ABI: ${error?.message ?? error}`
        );
      }
      if (parsed?.name !== "ReservationSettled") continue;
      reservations.push({
        account: parsed.args.account,
        recipient: parsed.args.recipient,
        asset: parsed.args.asset,
        amountRaw: parsed.args.amount.toString()
      });
    }
    const expectedCount = 1
      + (settlement.protocolFeeAmountRaw === "0" ? 0 : 1)
      + (retainedRaw === 0n ? 0 : 1);
    if (reservations.length !== expectedCount) {
      throw new ExternalServiceError(
        `Recovered payout has ${reservations.length} AAC reservations; expected ${expectedCount}.`
      );
    }
    const workerMatches = reservations.filter((entry) =>
      sameAddress(entry.account, job.poster)
      && sameAddress(entry.recipient, settlement.worker)
      && sameAddress(entry.asset, settlement.asset)
      && entry.amountRaw === settlement.workerAmountRaw
    );
    if (workerMatches.length !== 1) {
      throw new ExternalServiceError("AAC worker reservation does not corroborate SettlementSplit.");
    }
    const treasuryAmounts = reservations
      .filter((entry) =>
        sameAddress(entry.account, job.poster)
        && sameAddress(entry.recipient, settlement.treasuryAccount)
        && sameAddress(entry.asset, settlement.asset)
      )
      .map((entry) => entry.amountRaw)
      .sort();
    const expectedTreasuryAmounts = [
      ...(settlement.protocolFeeAmountRaw === "0" ? [] : [settlement.protocolFeeAmountRaw]),
      ...(retainedRaw === 0n ? [] : [retainedRaw.toString()])
    ].sort();
    if (JSON.stringify(treasuryAmounts) !== JSON.stringify(expectedTreasuryAmounts)) {
      throw new ExternalServiceError("AAC treasury reservations do not corroborate poster fee and gas retention.");
    }
    return {
      ...settlement,
      ...(gasRetention ? { gasRetention } : {})
    };
  }

  async openDispute(jobId, participant) {
    return this.withGatewayError("openDispute", async () => {
      this.requireSigner("openDispute");
      const chainJobId = this.toJobId(jobId);
      const escrowContract = await this.escrowContractForJob(jobId);
      const signerAddress = participant ? await this.signer.getAddress() : undefined;
      const tx = participant && participant.toLowerCase() !== signerAddress.toLowerCase()
        ? await escrowContract.openDisputeFor(chainJobId, participant)
        : await escrowContract.openDispute(chainJobId);
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
      await this.requireArbitratorSigner("resolveDispute");
      const job = await this.getJob(jobId);
      const escrowContract = this.escrowContractForLiveJob(job, { arbitrator: true });
      const asset = this.assetForAddress(job.asset);
      const workerPayoutBase = this.toBaseUnits(workerPayout, asset, "dispute worker payout");
      const tx = await escrowContract.resolveDispute(
        this.toJobId(jobId),
        workerPayoutBase,
        this.toDisputeReasonCode(reasonCode),
        metadataURI
      );
      const receipt = await tx.wait();
      const settlement = this.extractSettlementSplit(receipt, escrowContract);
      return {
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        status: Number(receipt?.status ?? 0),
        ...(settlement ? { settlement } : {})
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
    let primary;
    if (this.primaryEscrowContractLayout === "v1") {
      primary = this.normalizeEscrowJob(
        await this.v1EscrowContract.jobs(normalizedJobId),
        "v1",
        this.config.escrowCoreAddress
      );
    } else if (this.primaryEscrowContractLayout === "legacy") {
      primary = this.normalizeEscrowJob(
        await this.legacyEscrowContract.jobs(normalizedJobId),
        "legacy",
        this.config.escrowCoreAddress
      );
    } else {
      try {
        primary = this.normalizeEscrowJob(
          await this.escrowContract.jobs(normalizedJobId),
          "rc1",
          this.config.escrowCoreAddress
        );
        this.primaryEscrowContractLayout = "rc1";
      } catch (error) {
        if (!this.isEscrowJobDecodeError(error)) {
          throw error;
        }
        if (this.v1EscrowContract) {
          try {
            primary = this.normalizeEscrowJob(
              await this.v1EscrowContract.jobs(normalizedJobId),
              "v1",
              this.config.escrowCoreAddress
            );
            this.primaryEscrowContractLayout = "v1";
          } catch (v1Error) {
            if (!this.isEscrowJobDecodeError(v1Error) || !this.legacyEscrowContract) {
              throw v1Error;
            }
            primary = this.normalizeEscrowJob(
              await this.legacyEscrowContract.jobs(normalizedJobId),
              "legacy",
              this.config.escrowCoreAddress
            );
            this.primaryEscrowContractLayout = "legacy";
          }
        } else if (this.legacyEscrowContract) {
          primary = this.normalizeEscrowJob(
            await this.legacyEscrowContract.jobs(normalizedJobId),
            "legacy",
            this.config.escrowCoreAddress
          );
          this.primaryEscrowContractLayout = "legacy";
        } else {
          throw error;
        }
      }
    }
    if (Number(primary.state) !== 0 || !this.drainingEscrowContract) return primary;

    const draining = this.normalizeEscrowJob(
      await this.drainingEscrowContract.jobs(normalizedJobId),
      "v1-drain",
      this.config.legacyEscrowCoreAddress
    );
    return Number(draining.state) === 0 ? primary : draining;
  }

  normalizeEscrowJob(job, contractLayout, escrowAddress = this.config.escrowCoreAddress) {
    const asset = this.assetForAddress(job.asset);
    return {
      contractLayout,
      escrowAddress,
      poster: job.poster,
      worker: job.worker,
      asset: job.asset,
      specHash: job.specHash ?? ZERO_BYTES32,
      reward: this.toDisplayUnits(job.reward, asset),
      rewardRaw: job.reward?.toString?.() ?? String(job.reward),
      opsReserve: this.toDisplayUnits(job.opsReserve ?? 0, asset),
      opsReserveRaw: job.opsReserve?.toString?.() ?? "0",
      contingencyReserve: this.toDisplayUnits(job.contingencyReserve ?? 0, asset),
      contingencyReserveRaw: job.contingencyReserve?.toString?.() ?? "0",
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
      disputedAt: Number(job.disputedAt ?? 0),
      protocolFee: this.toDisplayUnits(job.protocolFee ?? 0, asset),
      protocolFeeRaw: job.protocolFee?.toString?.() ?? "0",
      protocolFeeReleased: this.toDisplayUnits(job.protocolFeeReleased ?? 0, asset),
      protocolFeeReleasedRaw: job.protocolFeeReleased?.toString?.() ?? "0",
      protocolFeeBps: Number(job.protocolFeeBps ?? 0),
      protocolFeeWaived: Boolean(job.protocolFeeWaived ?? false)
    };
  }

  publicEscrowJob(job) {
    const { contractLayout: _contractLayout, ...publicJob } = job;
    return publicJob;
  }

  async escrowContractForJob(jobId, options = {}) {
    if (!this.config.legacyEscrowCoreAddress) {
      return options.arbitrator ? this.arbitratorEscrowContract : this.escrowContract;
    }
    return this.escrowContractForLiveJob(await this.readEscrowJob(jobId), options);
  }

  escrowContractForLiveJob(job, { arbitrator = false } = {}) {
    if (
      this.config.legacyEscrowCoreAddress
      && job?.escrowAddress?.toLowerCase?.() === this.config.legacyEscrowCoreAddress.toLowerCase()
    ) {
      return arbitrator
        ? this.arbitratorDrainingEscrowContract
        : this.drainingEscrowContract;
    }
    if (job?.contractLayout === "v1") {
      return arbitrator ? this.arbitratorEscrowContract : this.v1EscrowContract;
    }
    return arbitrator ? this.arbitratorEscrowContract : this.escrowContract;
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
    externalSchema = EMPTY_EXTERNAL_SCHEMA,
    protocolFeeWaived = false
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
    if (contractLayout === "v1") {
      if (this.hasExternalSchemaMetadata(externalSchema)) {
        return this.v1EscrowContract[CREATE_SINGLE_PAYOUT_WITH_SCHEMA](
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
      return this.v1EscrowContract.createSinglePayoutJob(
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
    if (protocolFeeWaived) {
      if (this.hasExternalSchemaMetadata(externalSchema)) {
        return this.escrowContract[CREATE_SINGLE_PAYOUT_FEE_WAIVED_WITH_SCHEMA](
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
      return this.escrowContract.createSinglePayoutJobFeeWaived(
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
      const params = {
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
        ...externalSchema,
        ...(contractLayout === "v1"
          ? {}
          : { protocolFeeWaived: job?.onboardingWaiverEligible === true })
      };
      const escrowContract = contractLayout === "v1"
        ? this.v1EscrowContract
        : this.escrowContract;
      return escrowContract.createSinglePayoutJobFromRecurringReserve(params);
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
      externalSchema,
      job?.onboardingWaiverEligible === true
    );
  }

  extractSettlementSplit(receipt, contract = this.escrowContract) {
    for (const log of receipt?.logs ?? []) {
      let parsed;
      try {
        parsed = contract?.interface?.parseLog?.(log);
      } catch {
        continue;
      }
      if (parsed?.name !== "SettlementSplit") continue;
      const asset = this.assetForAddress(parsed.args.asset);
      return {
        worker: parsed.args.worker,
        treasuryAccount: parsed.args.treasuryAccount,
        asset: parsed.args.asset,
        assetSymbol: asset.symbol,
        workerAmount: this.toDisplayUnits(parsed.args.workerAmount, asset),
        workerAmountRaw: parsed.args.workerAmount.toString(),
        protocolFeeAmount: this.toDisplayUnits(parsed.args.protocolFeeAmount, asset),
        protocolFeeAmountRaw: parsed.args.protocolFeeAmount.toString(),
        protocolFeeBps: Number(parsed.args.protocolFeeBps)
      };
    }
    return undefined;
  }

  extractGasRetention(receipt, contract = this.escrowContract) {
    for (const log of receipt?.logs ?? []) {
      let parsed;
      try {
        parsed = contract?.interface?.parseLog?.(log);
      } catch {
        continue;
      }
      if (parsed?.name !== "GasRetentionApplied") continue;
      return {
        worker: parsed.args.worker,
        retainedRaw: parsed.args.retainedRaw.toString(),
        rewardRaw: parsed.args.rewardRaw.toString()
      };
    }
    return undefined;
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

  async getXcmRequestParameters(requestId) {
    return this.withGatewayError("getXcmRequestParameters", async () => {
      const contract = this.requireXcmWrapper("getXcmRequestParameters");
      const normalizedRequestId = this.toRequestId(requestId);
      const parameters = await contract.getRequestParameters(normalizedRequestId);
      return {
        requestId: normalizedRequestId,
        sellAmountRaw: this.toRawString(parameters.sellAmount),
        minimumOutputRaw: this.toRawString(parameters.minimumOutput),
        maxFeePerLegRaw: this.toRawString(parameters.maxFeePerLeg),
        dispatchDeadlineRaw: this.toRawString(parameters.dispatchDeadline)
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

  async getHydrationAdapterRequest(requestId, wrapperRequest = undefined) {
    if (!this.hydrationUsdcAdapterContract || !this.config.hydrationUsdcAdapterAddress) {
      return undefined;
    }
    const normalizedRequestId = this.toRequestId(requestId);
    const liveWrapperRequest = wrapperRequest ?? await this.getXcmRequest(normalizedRequestId);
    if (
      String(liveWrapperRequest?.queuedBy ?? "").toLowerCase()
        !== this.config.hydrationUsdcAdapterAddress.toLowerCase()
    ) {
      return undefined;
    }
    const record = await this.hydrationUsdcAdapterContract.getAdapterRequest(normalizedRequestId);
    if (!record?.requester || record.requester === ZERO_ADDRESS) {
      throw new NotFoundError(
        `Hydration adapter request ${normalizedRequestId} not found.`,
        "strategy_request_not_found"
      );
    }
    return {
      requestId: normalizedRequestId,
      adapter: this.config.hydrationUsdcAdapterAddress,
      account: record.account,
      recipient: record.recipient,
      kind: Number(record.kind),
      kindLabel: REQUEST_KIND_LABELS[Number(record.kind)] ?? "unknown",
      status: Number(record.status),
      statusLabel: REQUEST_STATUS_LABELS[Number(record.status)] ?? "unknown",
      requestedAssetsRaw: this.toRawString(record.requestedAssets),
      requestedSharesRaw: this.toRawString(record.requestedShares),
      settledAssetsRaw: this.toRawString(record.settledAssets),
      settledSharesRaw: this.toRawString(record.settledShares),
      remoteRef: this.normalizeOptionalBytes32(record.remoteRef),
      failureCode: this.normalizeOptionalBytes32(record.failureCode),
      settled: Boolean(record.settled)
    };
  }

  async finalizeXcmRequest(requestId, {
    status,
    settledAssets = 0,
    settledShares = 0,
    observedRemoteBalanceRaw = 0,
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
      const normalizedObservedRemoteBalance = this.normalizeUint256(
        observedRemoteBalanceRaw,
        "observedRemoteBalanceRaw"
      );
      let strategyRequest;
      try {
        strategyRequest = await this.getStrategyRequest(normalizedRequestId);
      } catch (error) {
        if (error?.code !== "strategy_request_not_found") {
          throw error;
        }
      }
      const wrapperRequest = strategyRequest ? undefined : await this.getXcmRequest(normalizedRequestId);
      const adapterRequest = strategyRequest
        ? undefined
        : await this.getHydrationAdapterRequest(normalizedRequestId, wrapperRequest);
      const settlementRequest = strategyRequest ?? adapterRequest;
      if (settlementRequest?.settled) {
        if (!this.strategySettlementMatches(
          settlementRequest,
          normalizedStatus,
          normalizedSettledAssets,
          normalizedSettledShares,
          normalizedRemoteRef,
          normalizedFailureCode
        )) {
          throw new ValidationError("Strategy XCM request is already settled with a different outcome.");
        }
        return {
          ...(wrapperRequest ?? await this.getXcmRequest(normalizedRequestId)),
          ...(strategyRequest ? { strategyRequest } : { adapterRequest }),
          settledVia: strategyRequest ? "agent_account" : "strategy_adapter",
          alreadySettled: true
        };
      }
      this.validateStrategySettlementOutcome(
        settlementRequest,
        normalizedStatus,
        normalizedSettledAssets,
        normalizedSettledShares
      );
      const settlementPreflight = await this.preflightStrategySettlementRatio(
        settlementRequest,
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
        : adapterRequest
          ? await this.hydrationUsdcAdapterContract.settleRequest(
              normalizedRequestId,
              normalizedStatus,
              normalizedSettledAssets,
              normalizedSettledShares,
              normalizedObservedRemoteBalance,
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
        ...(strategyRequest
          ? { strategyRequest: await this.getStrategyRequest(normalizedRequestId).catch(() => undefined) }
          : adapterRequest
            ? {
                adapterRequest: await this.getHydrationAdapterRequest(normalizedRequestId)
                  .catch(() => undefined)
              }
            : {}),
        ...(settlementPreflight ? { settlementPreflight } : {}),
        settledVia: strategyRequest ? "agent_account" : adapterRequest ? "strategy_adapter" : "xcm_wrapper",
        alreadySettled: false
      };
    });
  }

  async preflightXcmSettlementOutcome(requestId, {
    status,
    settledAssets = 0,
    settledShares = 0
  } = {}) {
    return this.withGatewayError("preflightXcmSettlementOutcome", async () => {
      const normalizedRequestId = this.toRequestId(requestId);
      const normalizedStatus = this.toXcmStatus(status);
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
      const wrapperRequest = strategyRequest ? undefined : await this.getXcmRequest(normalizedRequestId);
      const adapterRequest = strategyRequest
        ? undefined
        : await this.getHydrationAdapterRequest(normalizedRequestId, wrapperRequest);
      const settlementRequest = strategyRequest ?? adapterRequest;
      this.validateStrategySettlementOutcome(
        settlementRequest,
        normalizedStatus,
        normalizedSettledAssets,
        normalizedSettledShares
      );
      const settlementPreflight = await this.preflightStrategySettlementRatio(
        settlementRequest,
        normalizedStatus,
        normalizedSettledAssets,
        normalizedSettledShares
      );
      return {
        requestId: normalizedRequestId,
        ok: true,
        strategyBacked: Boolean(strategyRequest),
        adapterBacked: Boolean(adapterRequest),
        ...(settlementPreflight ? { settlementPreflight } : {})
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

  async preflightStrategySettlementRatio(strategyRequest, status, settledAssets, settledShares) {
    if (!strategyRequest || status !== 2) {
      return undefined;
    }

    const { totalAssets, totalShares } = await this.getStrategyAdapterTotals(strategyRequest.adapter);
    if (strategyRequest.kind === 0) {
      const expectedShares = totalAssets <= 0n || totalShares <= 0n
        ? settledAssets
        : (settledAssets * totalShares) / totalAssets;
      if (settledShares !== expectedShares) {
        throw new ValidationError(
          `Async strategy deposit settlement ratio mismatch: expected settledShares=${expectedShares.toString()} for settledAssets=${settledAssets.toString()}.`
        );
      }
      return {
        kind: "deposit",
        adapter: strategyRequest.adapter,
        totalAssetsRaw: totalAssets.toString(),
        totalSharesRaw: totalShares.toString(),
        expectedSharesRaw: expectedShares.toString()
      };
    }

    if (strategyRequest.kind === 1) {
      const requestedShares = BigInt(strategyRequest.requestedSharesRaw ?? 0);
      const maxAssets = totalShares <= 0n ? 0n : (requestedShares * totalAssets) / totalShares;
      if (settledAssets > maxAssets) {
        throw new ValidationError(
          `Async strategy withdraw settlement ratio mismatch: settledAssets=${settledAssets.toString()} exceeds maxAssets=${maxAssets.toString()}.`
        );
      }
      return {
        kind: "withdraw",
        adapter: strategyRequest.adapter,
        totalAssetsRaw: totalAssets.toString(),
        totalSharesRaw: totalShares.toString(),
        maxAssetsRaw: maxAssets.toString()
      };
    }

    return undefined;
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

  async requireArbitratorSigner(operation) {
    if (!this.arbitratorSigner) {
      throw new ConfigError(
        `${operation} requires an arbitrator signer, but no blockchain signer is configured.`,
        {
          operation,
          reason: "arbitrator_signer_missing"
        }
      );
    }

    const status = await this.getTreasuryPolicyStatus();
    if (status?.roles?.arbitratorSignerIsArbitrator !== true) {
      throw new ConfigError(
        `${operation} refused: the configured arbitrator signer is not the approved on-chain arbitrator. ` +
          "Arbitration must be completed out-of-band with the registered hardware arbitrator.",
        {
          operation,
          reason: "arbitrator_signer_not_on_chain_arbitrator",
          arbitratorSignerAddress: status?.roles?.arbitratorSignerAddress
        }
      );
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
    const { totalAssets, totalShares } = await this.getStrategyAdapterTotals(strategy.adapter);
    const requestedAssets = BigInt(assets ?? 0);
    if (totalAssets <= 0n || totalShares <= 0n) {
      return requestedAssets;
    }
    return (requestedAssets * totalShares) / totalAssets;
  }

  async getStrategyAdapterTotals(adapterAddress) {
    const adapterContract = new Contract(adapterAddress, STRATEGY_ADAPTER_ABI, this.provider);
    const [rawTotalAssets, rawTotalShares] = await Promise.all([
      adapterContract.totalAssets(),
      adapterContract.totalShares()
    ]);
    return {
      totalAssets: BigInt(rawTotalAssets ?? 0),
      totalShares: BigInt(rawTotalShares ?? 0)
    };
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

function normalizedAddress(value, label) {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/u.test(normalized)) {
    throw new ValidationError(`${label} is not a 20-byte EVM address.`);
  }
  return normalized;
}

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
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
