import { randomUUID } from "node:crypto";

import { getAddress } from "ethers";

import { ConfigError, ConflictError, ExternalServiceError, ValidationError } from "../core/errors.js";
import { loadDeploymentManifest } from "../core/health-capability.js";
import { GuardedSchedulerLoop, schedulerRunTimeoutMs, summaryErrorsOutcome } from "./guarded-scheduler-loop.js";
import {
  AAC_IDLE_DEPOSIT_POOL_V21,
  DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
  DEPLOYED_DEPOSIT_POOL_V21,
  EvmIdleBalanceAllocationChain
} from "./idle-balance-allocation-chain.js";
import { IDLE_BALANCE_ALLOCATION_ROUTE_LIVE_ENV } from "./idle-balance-consent-service.js";

export const IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED_ENV = "IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED";
export const IDLE_BALANCE_ALLOCATION_WORKING_HEADROOM_RAW_ENV =
  "IDLE_BALANCE_ALLOCATION_WORKING_HEADROOM_RAW";
export const IDLE_BALANCE_ALLOCATION_MIN_TICK_RAW_ENV = "IDLE_BALANCE_ALLOCATION_MIN_TICK_RAW";
export const IDLE_BALANCE_ALLOCATION_MAX_COUNT_PER_RUN_ENV =
  "IDLE_BALANCE_ALLOCATION_MAX_COUNT_PER_RUN";
export const IDLE_BALANCE_ALLOCATION_MAX_TOTAL_RAW_PER_RUN_ENV =
  "IDLE_BALANCE_ALLOCATION_MAX_TOTAL_RAW_PER_RUN";
export const IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_RAW_ENV = "IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_RAW";
export const IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_BPS_ENV = "IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_BPS";
export const IDLE_BALANCE_ALLOCATION_INTERVAL_MS_ENV = "IDLE_BALANCE_ALLOCATION_INTERVAL_MS";

export const DEFAULT_WORKING_HEADROOM_RAW = 2_000_000n;
export const DEFAULT_MIN_ALLOCATION_TICK_RAW = 500_000n;
export const DEFAULT_MAX_ALLOCATIONS_PER_RUN = 25;
export const DEFAULT_MAX_ALLOCATION_TOTAL_RAW = 100_000_000n;
export const DEFAULT_FLOAT_TARGET_RAW = 10_000_000n;
export const DEFAULT_FLOAT_TARGET_BPS = 2_500;

const BPS = 10_000n;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_SCAN_LIMIT = 1_000;
const LOCK_TTL_SECONDS = 300;
const RUN_LOCK_ID = "idle-balance-allocation-keeper:run";
const FLOAT_STATE_SCOPE = "idle-balance-allocation-keeper:float";
const NOTICE_7_DAYS_SECONDS = 7 * 24 * 60 * 60;

export function loadIdleBalanceAllocationKeeperConfig(env = process.env, {
  agentAccountAddress,
  assetAddress,
  poolAddress,
  adapterAddress
} = {}) {
  const deploymentManifest = loadDeploymentManifest(env);
  const routeLive = parseBoolean(env[IDLE_BALANCE_ALLOCATION_ROUTE_LIVE_ENV], false,
    IDLE_BALANCE_ALLOCATION_ROUTE_LIVE_ENV);
  const keeperEnabled = parseBoolean(env[IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED_ENV], false,
    IDLE_BALANCE_ALLOCATION_KEEPER_ENABLED_ENV);
  const config = {
    enabled: routeLive && keeperEnabled,
    routeLive,
    keeperEnabled,
    intervalMs: positiveInteger(env[IDLE_BALANCE_ALLOCATION_INTERVAL_MS_ENV], DEFAULT_INTERVAL_MS,
      IDLE_BALANCE_ALLOCATION_INTERVAL_MS_ENV),
    workingHeadroomRaw: unsignedInteger(
      env[IDLE_BALANCE_ALLOCATION_WORKING_HEADROOM_RAW_ENV],
      DEFAULT_WORKING_HEADROOM_RAW,
      IDLE_BALANCE_ALLOCATION_WORKING_HEADROOM_RAW_ENV
    ),
    minAllocationTickRaw: positiveBigInt(
      env[IDLE_BALANCE_ALLOCATION_MIN_TICK_RAW_ENV],
      DEFAULT_MIN_ALLOCATION_TICK_RAW,
      IDLE_BALANCE_ALLOCATION_MIN_TICK_RAW_ENV
    ),
    maxAllocationsPerRun: positiveInteger(
      env[IDLE_BALANCE_ALLOCATION_MAX_COUNT_PER_RUN_ENV],
      DEFAULT_MAX_ALLOCATIONS_PER_RUN,
      IDLE_BALANCE_ALLOCATION_MAX_COUNT_PER_RUN_ENV
    ),
    maxAllocationTotalRaw: positiveBigInt(
      env[IDLE_BALANCE_ALLOCATION_MAX_TOTAL_RAW_PER_RUN_ENV],
      DEFAULT_MAX_ALLOCATION_TOTAL_RAW,
      IDLE_BALANCE_ALLOCATION_MAX_TOTAL_RAW_PER_RUN_ENV
    ),
    floatTargetRaw: unsignedInteger(
      env[IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_RAW_ENV],
      DEFAULT_FLOAT_TARGET_RAW,
      IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_RAW_ENV
    ),
    floatTargetBps: boundedBasisPoints(
      env[IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_BPS_ENV],
      DEFAULT_FLOAT_TARGET_BPS,
      IDLE_BALANCE_ALLOCATION_FLOAT_TARGET_BPS_ENV
    ),
    allocationExclusions: operatorFundingExclusions(deploymentManifest),
    scanLimit: DEFAULT_SCAN_LIMIT,
    lockTtlSeconds: LOCK_TTL_SECONDS,
    agentAccountAddress,
    assetAddress,
    poolAddress,
    adapterAddress
  };
  if (config.enabled) assertLiveConfig(config);
  return config;
}

export function createIdleBalanceAllocationKeeper({
  gateway,
  stateStore,
  consentService,
  env = process.env,
  logger = console,
  now = () => new Date()
} = {}) {
  const usdc = gateway?.config?.supportedAssets?.find(
    (asset) => String(asset.symbol ?? "").toUpperCase() === "USDC"
  );
  const config = loadIdleBalanceAllocationKeeperConfig(env, {
    agentAccountAddress: gateway?.config?.agentAccountAddress,
    assetAddress: usdc?.address,
    poolAddress: gateway?.config?.depositPoolV21Address,
    adapterAddress: gateway?.config?.aacPoolAggregatorAdapterAddress
  });
  const chain = config.enabled
    ? new EvmIdleBalanceAllocationChain({
        provider: gateway?.provider,
        signer: gateway?.signer,
        agentAccountAddress: config.agentAccountAddress,
        assetAddress: config.assetAddress,
        poolAddress: config.poolAddress,
        adapterAddress: config.adapterAddress
      })
    : undefined;
  return new IdleBalanceAllocationKeeperService({
    config,
    stateStore,
    consentService,
    chainReader: chain,
    movementGateway: chain,
    settlementSignerReader: () => gateway?.signer?.getAddress(),
    logger,
    now
  });
}

export class IdleBalanceAllocationKeeperService {
  constructor({
    config,
    stateStore,
    consentService,
    chainReader,
    movementGateway,
    settlementSignerReader,
    logger = console,
    now = () => new Date(),
    ownerFactory = randomUUID
  } = {}) {
    this.config = config ?? loadIdleBalanceAllocationKeeperConfig({});
    this.stateStore = stateStore;
    this.consentService = consentService;
    this.chainReader = chainReader;
    this.movementGateway = movementGateway;
    this.settlementSignerReader = settlementSignerReader;
    this.logger = logger;
    this.now = now;
    this.ownerFactory = ownerFactory;
    this.running = false;
    this.timer = undefined;
    this.lastRun = undefined;
    if (this.config.enabled) this.#assertRuntime();
    this.schedulerLoop = new GuardedSchedulerLoop({
      host: this,
      name: "idle-balance-allocation-keeper",
      intervalMs: this.config.intervalMs,
      runTimeoutMs: schedulerRunTimeoutMs(this.config.intervalMs),
      runOnce: (at) => this.runOnce(at),
      evaluateOutcome: (summary) => summaryErrorsOutcome(summary, "idle_balance_allocation_keeper_errors"),
      logger: this.logger
    });
  }

  start() {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    void this.schedulerLoop.runOnceAndSchedule();
  }

  stop() {
    this.running = false;
    this.schedulerLoop.stop();
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      routeLive: this.config.routeLive,
      keeperEnabled: this.config.keeperEnabled,
      running: this.running,
      strategyId: AAC_IDLE_DEPOSIT_POOL_V21,
      adapter: this.config.adapterAddress ?? DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
      pool: this.config.poolAddress ?? DEPLOYED_DEPOSIT_POOL_V21,
      workingHeadroomRaw: this.config.workingHeadroomRaw.toString(),
      minAllocationTickRaw: this.config.minAllocationTickRaw.toString(),
      maxAllocationsPerRun: this.config.maxAllocationsPerRun,
      maxAllocationTotalRaw: this.config.maxAllocationTotalRaw.toString(),
      floatTargetBps: this.config.floatTargetBps,
      floatTargetCapRaw: this.config.floatTargetRaw.toString(),
      allocationExclusions: this.config.allocationExclusions,
      lastRun: this.lastRun,
      ...this.schedulerLoop.getStatus()
    };
  }

  async runOnce(at = this.now()) {
    const summary = {
      startedAt: at.toISOString(),
      finishedAt: undefined,
      candidateCount: 0,
      allocationCount: 0,
      allocationTotalRaw: "0",
      deallocationCount: 0,
      floatAction: null,
      skipped: [],
      errors: []
    };
    if (!this.config.enabled) {
      summary.skipped.push({ reason: "allocation_keeper_disabled" });
      return this.#finish(summary);
    }

    const owner = this.ownerFactory();
    let acquired;
    try {
      acquired = await this.stateStore.acquireClaimLock(RUN_LOCK_ID, owner, this.config.lockTtlSeconds);
    } catch (error) {
      return this.#failRun(summary, "allocation_keeper_lock_unreadable", error);
    }
    if (!acquired) {
      summary.skipped.push({ reason: "allocation_keeper_lock_held" });
      return this.#finish(summary);
    }

    try {
      try {
        summary.floatAction = await this.#manageFloat();
      } catch (error) {
        return this.#failRun(summary, error?.code ?? "allocation_keeper_float_unreadable", error);
      }
      if (!await this.#processQueuedDeallocations(summary)) return this.#finish(summary);

      let candidates;
      try {
        candidates = await this.stateStore.listIdleBalanceConsents({ limit: this.config.scanLimit });
      } catch (error) {
        return this.#failRun(summary, "idle_balance_consent_store_unreadable", error);
      }
      summary.candidateCount = candidates.length;
      let allocationExclusions;
      try {
        allocationExclusions = await this.#resolveAllocationExclusions();
      } catch (error) {
        return this.#failRun(summary, "allocation_exclusion_wallet_unreadable", error);
      }
      let allocatedTotal = 0n;
      for (const candidate of candidates) {
        if (summary.allocationCount >= this.config.maxAllocationsPerRun) break;
        if (allocatedTotal >= this.config.maxAllocationTotalRaw) break;
        if (candidate?.status !== "active" || !candidate.wallet) continue;
        if (allocationExclusions.has(String(candidate.wallet).toLowerCase())) {
          this.#skip(summary, candidate.wallet, "allocation_excluded_operator_funding_source");
          continue;
        }
        const remaining = this.config.maxAllocationTotalRaw - allocatedTotal;
        let result;
        try {
          result = await this.#allocateCandidate(candidate.wallet, remaining, summary);
        } catch (error) {
          this.#fail(summary, error?.code ?? "allocation_candidate_failed", error, { wallet: candidate.wallet });
          return this.#finish(summary);
        }
        if (!result) continue;
        allocatedTotal += BigInt(result.amountRaw);
        summary.allocationCount += 1;
        summary.allocationTotalRaw = allocatedTotal.toString();
      }
      return this.#finish(summary);
    } finally {
      try {
        await this.stateStore.releaseClaimLock(RUN_LOCK_ID, owner);
      } catch (error) {
        this.#logRefusal("allocation_keeper_lock_release_failed", error);
      }
    }
  }

  /**
   * Authenticated-route entry point. Consent is intentionally absent: exit is
   * governed only by the caller's shares and currently available adapter
   * float. Revoked and expired wallets retain the same exit path.
   */
  async deallocate(walletInput, { amountRaw } = {}) {
    this.#assertEnabledForMovement();
    const wallet = getAddress(String(walletInput ?? "").toLowerCase());
    const amount = exactPositiveAmount(amountRaw, "amountRaw");
    return this.#withWalletLock(wallet, async () => {
      const [floatState, sharesBeforeRaw] = await Promise.all([
        this.#readFloatState(),
        this.#readStrategyShares(wallet)
      ]);
      const availableAssets = assetsForShares(sharesBeforeRaw, floatState.totalAssetsRaw, floatState.totalSharesRaw);
      if (amount > availableAssets) {
        throw new ConflictError(
          "Requested deallocation exceeds this wallet's deployed strategy assets.",
          "idle_balance_deallocation_exceeds_position",
          { requestedRaw: amount.toString(), availableRaw: availableAssets.toString() }
        );
      }
      const float = BigInt(floatState.maxWithdrawRaw ?? floatState.floatRaw);
      if (amount > float) {
        const queuedAt = this.now().toISOString();
        const queued = await this.stateStore.upsertIdleBalanceDeallocationRequest({
          schemaVersion: 1,
          kind: "idle_balance_deallocation_request_v1",
          wallet: wallet.toLowerCase(),
          status: "queued",
          reason: "adapter_float_insufficient",
          amountRaw: amount.toString(),
          strategyId: AAC_IDLE_DEPOSIT_POOL_V21,
          adapter: getAddress(this.config.adapterAddress),
          queuedAt,
          updatedAt: queuedAt,
          earliestExitSeconds: NOTICE_7_DAYS_SECONDS,
          estimatedEarliestAt: new Date(this.now().getTime() + NOTICE_7_DAYS_SECONDS * 1_000).toISOString()
        });
        return { accepted: false, status: "queued", reason: "adapter_float_insufficient", request: queued };
      }
      await this.#markDeallocationExecuting(wallet);
      const completed = await this.#executeDeallocation(wallet, amount, sharesBeforeRaw, {
        source: "authenticated_agent_exit"
      });
      await this.#markDeallocationCompleted(wallet, completed.evidence);
      return { accepted: true, status: "deallocated", ...completed };
    });
  }

  async #allocateCandidate(walletInput, remainingRaw, summary) {
    const wallet = getAddress(String(walletInput).toLowerCase());
    return this.#withWalletLock(wallet, async () => {
      let position;
      try {
        position = await this.chainReader.getAccountPosition(wallet);
      } catch (error) {
        this.#skip(summary, wallet, "allocation_chain_position_unreadable", error);
        return undefined;
      }
      const liquid = BigInt(position.liquidRaw ?? 0);
      const debt = BigInt(position.debtOutstandingRaw ?? 0);
      const withdrawable = liquid > debt ? liquid - debt : 0n;
      let amount = withdrawable > this.config.workingHeadroomRaw
        ? withdrawable - this.config.workingHeadroomRaw
        : 0n;
      if (amount > remainingRaw) amount = remainingRaw;
      if (amount < this.config.minAllocationTickRaw) {
        this.#skip(summary, wallet, "allocation_below_minimum_tick");
        return undefined;
      }

      let sharesBeforeRaw;
      try {
        sharesBeforeRaw = await this.#readStrategyShares(wallet);
      } catch (error) {
        this.#skip(summary, wallet, error?.code ?? "allocation_chain_shares_unreadable", error);
        return undefined;
      }

      // This is the authorization boundary. No scan-time consent object is
      // trusted, and no further preparatory read is allowed between this fresh
      // durable assessment and the send.
      let consent;
      try {
        consent = await this.consentService.assessAllocationAttempt(wallet);
      } catch (error) {
        this.#skip(summary, wallet, "idle_balance_consent_unreadable", error);
        return undefined;
      }
      if (!consent?.allowed) {
        this.#skip(summary, wallet, consent?.reason ?? "idle_balance_consent_invalid");
        return undefined;
      }

      let movement;
      try {
        movement = await this.movementGateway.allocateIdleFunds(wallet, amount.toString());
      } catch (error) {
        this.#skip(summary, wallet, error?.code ?? "allocation_keeper_chain_write_failed", error);
        return undefined;
      }
      const sharesAfterRaw = await this.#resolveSharesAfter(wallet, sharesBeforeRaw, movement);
      const evidence = await this.#recordMovement({
        movement: "allocation",
        wallet,
        amountRaw: movement.amountRaw ?? amount.toString(),
        movementResult: movement,
        sharesBeforeRaw,
        sharesAfterRaw,
        consent: {
          required: true,
          termsHash: consent.termsHash,
          checkedAt: consent.checkedAt
        }
      });
      return { amountRaw: amount.toString(), evidence };
    }, {
      onBusy: () => this.#skip(summary, wallet, "allocation_wallet_lock_held")
    });
  }

  async #processQueuedDeallocations(summary) {
    let healthy = true;
    let queued;
    try {
      queued = await this.stateStore.listIdleBalanceDeallocationRequests({ status: "queued" });
    } catch (error) {
      this.#fail(summary, "idle_balance_deallocation_queue_unreadable", error);
      return false;
    }
    for (const request of queued) {
      let wallet;
      try {
        wallet = getAddress(request.wallet);
        await this.#withWalletLock(wallet, async () => {
          let floatState;
          let sharesBeforeRaw;
          try {
            [floatState, sharesBeforeRaw] = await Promise.all([
              this.#readFloatState(),
              this.#readStrategyShares(wallet)
            ]);
          } catch (error) {
            this.#fail(summary, error?.code ?? "queued_deallocation_chain_unreadable", error, { wallet });
            healthy = false;
            return;
          }
          const amount = BigInt(request.amountRaw);
          if (amount > BigInt(floatState.maxWithdrawRaw ?? floatState.floatRaw)) return;
          const availableAssets = assetsForShares(
            sharesBeforeRaw,
            floatState.totalAssetsRaw,
            floatState.totalSharesRaw
          );
          if (amount > availableAssets) {
            await this.stateStore.upsertIdleBalanceDeallocationRequest({
              ...request,
              status: "refused",
              reason: "idle_balance_deallocation_exceeds_position",
              updatedAt: this.now().toISOString()
            });
            return;
          }
          try {
            await this.#markDeallocationExecuting(wallet);
            const completed = await this.#executeDeallocation(wallet, amount, sharesBeforeRaw, {
              source: "queued_agent_exit"
            });
            await this.#markDeallocationCompleted(wallet, completed.evidence);
            summary.deallocationCount += 1;
          } catch (error) {
            this.#fail(summary, error?.code ?? "queued_deallocation_failed", error, { wallet });
            healthy = false;
          }
        });
      } catch (error) {
        this.#fail(summary, error?.code ?? "queued_deallocation_lock_failed", error, { wallet });
        healthy = false;
      }
    }
    return healthy;
  }

  async #executeDeallocation(wallet, amount, sharesBeforeRaw, { source }) {
    const movement = await this.movementGateway.deallocateIdleFunds(wallet, amount.toString());
    const sharesAfterRaw = await this.#resolveSharesAfter(wallet, sharesBeforeRaw, movement);
    const evidence = await this.#recordMovement({
      movement: "deallocation",
      wallet,
      amountRaw: movement.amountRaw ?? amount.toString(),
      movementResult: movement,
      sharesBeforeRaw,
      sharesAfterRaw,
      consent: {
        required: false,
        reason: "exit_never_requires_consent"
      },
      source
    });
    return { amountRaw: evidence.amountRaw, evidence };
  }

  async #manageFloat() {
    const floatState = await this.#readFloatState();
    let persisted;
    try {
      persisted = await this.stateStore.getServiceState(FLOAT_STATE_SCOPE);
    } catch (error) {
      throw namedError("allocation_keeper_float_state_unreadable", "Persisted float state could not be read.", error);
    }
    let queued;
    try {
      queued = await this.stateStore.listIdleBalanceDeallocationRequests({ status: "queued" });
    } catch (error) {
      throw namedError("idle_balance_deallocation_queue_unreadable", "Deallocation queue could not be read.", error);
    }
    const queuedTotal = queued.reduce((total, request) => total + BigInt(request.amountRaw ?? 0), 0n);
    const proportionalTarget = proportionalFloatTarget({
      totalAssetsRaw: floatState.totalAssetsRaw,
      targetBps: this.config.floatTargetBps,
      absoluteCapRaw: this.config.floatTargetRaw
    });
    // Queued exits sit above the operating target: the 25% decision sizes
    // ordinary instant liquidity, while already-promised exits remain fully backed.
    const target = proportionalTarget + queuedTotal;
    const current = BigInt(floatState.floatRaw);

    const pending = persisted?.pendingExit;
    if (pending) {
      if (!pending.requestId) {
        throw namedError(
          "allocation_keeper_float_exit_submission_unreconciled",
          "A prior float-exit submission has no confirmed request id; operator reconciliation is required."
        );
      }
      let exit;
      try {
        exit = await this.chainReader.getFloatExit(pending.requestId);
      } catch (error) {
        throw namedError("allocation_keeper_float_exit_unreadable", "Pending float exit could not be read.", error);
      }
      if (
        getAddress(exit.owner) !== getAddress(this.config.adapterAddress)
        || getAddress(exit.receiver) !== getAddress(this.config.adapterAddress)
      ) {
        throw namedError("allocation_keeper_float_exit_binding_invalid",
          "Persisted float exit is not owned by and payable to the deployed adapter.");
      }
      if (!exit.fulfilled && Number(exit.unlockAt) <= Math.floor(this.now().getTime() / 1_000)) {
        const needed = target > current ? target - current : 0n;
        const pendingAssets = assetsForShares(
          exit.sharesRaw,
          floatState.poolAssetsRaw,
          floatState.poolSharesRaw
        );
        // A legacy request may lock more shares than the relative target needs.
        // There is no cancel/resize entrypoint, so leave an oversized matured
        // request unfulfilled until exit demand needs its full value.
        if (pendingAssets > needed) {
          return {
            action: "leaveOversizedFloatExit",
            reason: "pending_exit_exceeds_relative_float_need",
            requestId: pending.requestId,
            unlockAt: exit.unlockAt,
            requestedAssetsRaw: pendingAssets.toString(),
            neededAssetsRaw: needed.toString(),
            targetRaw: target.toString()
          };
        }
        const result = await this.movementGateway.fulfilFloatExit(pending.requestId);
        await this.stateStore.upsertServiceState(FLOAT_STATE_SCOPE, {
          pendingExit: null,
          lastAction: { action: "fulfilFloatExit", ...result, at: this.now().toISOString() }
        });
        return { action: "fulfilFloatExit", requestId: pending.requestId, ...result };
      }
      if (!exit.fulfilled) {
        return {
          action: "awaitFloatExit",
          requestId: pending.requestId,
          unlockAt: exit.unlockAt,
          targetRaw: target.toString()
        };
      }
      await this.stateStore.upsertServiceState(FLOAT_STATE_SCOPE, { pendingExit: null });
    }
    // Keep the working float target intact after every queued exit is paid.
    // This makes replenishment genuinely prior to queue service rather than
    // paying a queue from the operational float and repairing it next tick.
    if (current > target) {
      const amount = current - target;
      const result = await this.movementGateway.sweepToPool(amount.toString());
      await this.stateStore.upsertServiceState(FLOAT_STATE_SCOPE, {
        lastAction: { action: "sweepToPool", amountRaw: amount.toString(), ...result, at: this.now().toISOString() }
      });
      return { action: "sweepToPool", amountRaw: amount.toString(), targetRaw: target.toString(), ...result };
    }
    if (current < target && BigInt(floatState.poolSharesRaw ?? 0) > 0n) {
      const deficit = target - current;
      const poolAssets = BigInt(floatState.poolAssetsRaw ?? 0);
      const exitAssets = deficit < poolAssets ? deficit : poolAssets;
      if (exitAssets === 0n) return { action: "none", reason: "pool_assets_unavailable" };
      let poolShares;
      try {
        poolShares = BigInt(await this.chainReader.sharesForPoolAssets(exitAssets.toString()));
      } catch (error) {
        throw namedError("allocation_keeper_float_unreadable", "Pool exit conversion could not be read.", error);
      }
      const availableShares = BigInt(floatState.poolSharesRaw);
      if (poolShares > availableShares) poolShares = availableShares;
      if (poolShares === 0n) return { action: "none", reason: "pool_shares_unavailable" };
      const submitting = {
        status: "submitting",
        poolSharesRaw: poolShares.toString(),
        receiver: getAddress(this.config.adapterAddress),
        requestedAt: this.now().toISOString()
      };
      await this.stateStore.upsertServiceState(FLOAT_STATE_SCOPE, { pendingExit: submitting });
      const result = await this.movementGateway.requestFloatExit({
        poolSharesRaw: poolShares.toString(),
        receiver: getAddress(this.config.adapterAddress)
      });
      if (!result.requestIdRaw) {
        throw namedError("allocation_keeper_float_exit_evidence_missing",
          "requestFloatExit receipt did not contain its request id.");
      }
      const pendingExit = {
        status: "confirmed",
        requestId: result.requestIdRaw,
        poolSharesRaw: poolShares.toString(),
        receiver: getAddress(this.config.adapterAddress),
        requestedAt: this.now().toISOString(),
        txHash: result.txHash
      };
      await this.stateStore.upsertServiceState(FLOAT_STATE_SCOPE, {
        pendingExit,
        lastAction: { action: "requestFloatExit", ...pendingExit }
      });
      return { action: "requestFloatExit", targetRaw: target.toString(), ...pendingExit };
    }
    return {
      action: "none",
      reason: current === target ? "float_at_target" : "pool_shares_unavailable",
      targetRaw: target.toString()
    };
  }

  async #resolveAllocationExclusions() {
    const exclusions = new Map(
      (this.config.allocationExclusions ?? []).map((entry) => [entry.wallet.toLowerCase(), entry])
    );
    const settlementSigner = getAddress(await this.settlementSignerReader());
    exclusions.set(settlementSigner.toLowerCase(), {
      wallet: settlementSigner,
      role: "settlement_signer",
      source: "runtime_signer"
    });
    return exclusions;
  }

  async #readFloatState() {
    try {
      return await this.chainReader.getFloatState();
    } catch (error) {
      throw namedError("allocation_keeper_float_unreadable", "Adapter float state could not be read.", error);
    }
  }

  async #readStrategyShares(wallet) {
    try {
      return String(await this.chainReader.getStrategyShares(wallet));
    } catch (error) {
      throw namedError("allocation_chain_shares_unreadable", "AAC strategy shares could not be read.", error);
    }
  }

  async #resolveSharesAfter(wallet, sharesBeforeRaw, movement) {
    if (movement.strategySharesDeltaRaw !== undefined) {
      return (BigInt(sharesBeforeRaw) + BigInt(movement.strategySharesDeltaRaw)).toString();
    }
    return this.#readStrategyShares(wallet);
  }

  async #recordMovement({
    movement,
    wallet,
    amountRaw,
    movementResult,
    sharesBeforeRaw,
    sharesAfterRaw,
    consent,
    source = "keeper_scan"
  }) {
    const before = BigInt(sharesBeforeRaw);
    const after = BigInt(sharesAfterRaw);
    const txHash = String(movementResult.txHash ?? "").toLowerCase();
    const blockNumber = Number(movementResult.blockNumber);
    if (!/^0x[0-9a-f]{64}$/u.test(txHash) || !Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw namedError("allocation_evidence_chain_proof_invalid",
        "Confirmed movement did not return a valid transaction hash and block number.");
    }
    const evidence = {
      schemaVersion: 1,
      kind: "idle_balance_movement_v1",
      id: `idle-balance-movement:${txHash}`,
      wallet: wallet.toLowerCase(),
      movement,
      source,
      amountRaw: String(amountRaw),
      txHash,
      blockNumber,
      strategyId: AAC_IDLE_DEPOSIT_POOL_V21,
      adapter: getAddress(this.config.adapterAddress),
      pool: getAddress(this.config.poolAddress),
      strategySharesBeforeRaw: before.toString(),
      strategySharesAfterRaw: after.toString(),
      strategySharesDeltaRaw: (after - before).toString(),
      consent,
      recordedAt: this.now().toISOString()
    };
    let stored;
    try {
      stored = await this.stateStore.putIdleBalanceMovementEvidence(evidence);
    } catch (error) {
      throw namedError("allocation_evidence_store_unreadable", "Movement evidence could not be persisted.", error);
    }
    if (!stored?.record || stored.record.txHash !== txHash) {
      throw namedError("allocation_evidence_write_conflict", "Movement evidence id was not append-only.");
    }
    return stored.record;
  }

  async #markDeallocationCompleted(wallet, evidence) {
    const existing = await this.stateStore.getIdleBalanceDeallocationRequest(wallet);
    if (!existing) return;
    await this.stateStore.upsertIdleBalanceDeallocationRequest({
      ...existing,
      status: "completed",
      reason: null,
      evidenceId: evidence.id,
      txHash: evidence.txHash,
      updatedAt: this.now().toISOString(),
      completedAt: this.now().toISOString()
    });
  }

  async #markDeallocationExecuting(wallet) {
    const existing = await this.stateStore.getIdleBalanceDeallocationRequest(wallet);
    if (!existing || existing.status !== "queued") return;
    await this.stateStore.upsertIdleBalanceDeallocationRequest({
      ...existing,
      status: "executing",
      reason: null,
      updatedAt: this.now().toISOString()
    });
  }

  async #withWalletLock(wallet, callback, { onBusy } = {}) {
    const owner = this.ownerFactory();
    const lockId = `idle-balance-allocation-keeper:wallet:${wallet.toLowerCase()}`;
    let acquired;
    try {
      acquired = await this.stateStore.acquireClaimLock(lockId, owner, this.config.lockTtlSeconds);
    } catch (error) {
      throw namedError("allocation_keeper_lock_unreadable", "Wallet movement lock could not be read.", error);
    }
    if (!acquired) {
      if (onBusy) return onBusy();
      throw new ConflictError(
        "Another allocation movement for this wallet is already in progress.",
        "allocation_keeper_wallet_lock_held"
      );
    }
    try {
      return await callback();
    } finally {
      try {
        await this.stateStore.releaseClaimLock(lockId, owner);
      } catch (error) {
        this.#logRefusal("allocation_keeper_lock_release_failed", error, { wallet });
      }
    }
  }

  #assertRuntime() {
    const stateMethods = [
      "acquireClaimLock",
      "releaseClaimLock",
      "listIdleBalanceConsents",
      "putIdleBalanceMovementEvidence",
      "listIdleBalanceDeallocationRequests",
      "getIdleBalanceDeallocationRequest",
      "upsertIdleBalanceDeallocationRequest",
      "getServiceState",
      "upsertServiceState"
    ];
    if (stateMethods.some((method) => typeof this.stateStore?.[method] !== "function")) {
      throw new ConfigError("A live allocation keeper requires its complete durable state-store surface.");
    }
    if (typeof this.consentService?.assessAllocationAttempt !== "function") {
      throw new ConfigError("A live allocation keeper requires attempt-time idle-balance consent assessment.");
    }
    if (typeof this.settlementSignerReader !== "function") {
      throw new ConfigError("A live allocation keeper requires its settlement signer exclusion reader.");
    }
    const chainMethods = [
      "getAccountPosition",
      "getStrategyShares",
      "getFloatState",
      "sharesForPoolAssets",
      "getFloatExit"
    ];
    if (chainMethods.some((method) => typeof this.chainReader?.[method] !== "function")) {
      throw new ConfigError("A live allocation keeper requires its fixed deployed-contract read surface.");
    }
    const movementMethods = [
      "allocateIdleFunds",
      "deallocateIdleFunds",
      "sweepToPool",
      "requestFloatExit",
      "fulfilFloatExit"
    ];
    if (movementMethods.some((method) => typeof this.movementGateway?.[method] !== "function")) {
      throw new ConfigError("A live allocation keeper requires exactly its five movement operations.");
    }
  }

  #assertEnabledForMovement() {
    if (!this.config.enabled) {
      throw new ConflictError(
        "Idle-balance allocation movements are disabled behind the route and keeper gates.",
        "allocation_keeper_disabled"
      );
    }
  }

  #skip(summary, wallet, reason, error = undefined) {
    summary.skipped.push({ wallet: wallet?.toLowerCase?.(), reason });
    if (error) this.#logRefusal(reason, error, { wallet });
  }

  #fail(summary, reason, error, details = undefined) {
    summary.errors.push({ reason, message: error?.message ?? String(error), ...(details ?? {}) });
    this.#logRefusal(reason, error, details);
  }

  #failRun(summary, reason, error) {
    this.#fail(summary, reason, error);
    return this.#finish(summary);
  }

  #logRefusal(reason, error, details = undefined) {
    this.logger.warn?.(
      { reason, error: error?.message ?? String(error ?? ""), ...(details ?? {}) },
      "idle_balance_allocation_keeper.refused"
    );
  }

  #finish(summary) {
    summary.finishedAt = this.now().toISOString();
    this.lastRun = summary;
    return summary;
  }
}

function assertLiveConfig(config) {
  requiredAddress(config.agentAccountAddress, "AgentAccountCore");
  requiredAddress(config.assetAddress, "USDC");
  const pool = requiredAddress(config.poolAddress, "DepositPool v2.1");
  const adapter = requiredAddress(config.adapterAddress, "AAC pool aggregator adapter");
  if (pool !== getAddress(DEPLOYED_DEPOSIT_POOL_V21)) {
    throw new ConfigError(`Allocation keeper pool must be deployed v2.1 ${DEPLOYED_DEPOSIT_POOL_V21}.`);
  }
  if (adapter !== getAddress(DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER)) {
    throw new ConfigError(`Allocation keeper adapter must be deployed ${DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER}.`);
  }
  if (!(config.allocationExclusions ?? []).some((entry) => entry.role === "settlement_signer")) {
    throw new ConfigError("A live allocation keeper must exclude the deployment's settlement signer funding wallet.");
  }
}

function operatorFundingExclusions(manifest) {
  const candidates = [
    { wallet: manifest?.verifier, role: "settlement_signer", source: "deployment_manifest.verifier" },
    ...(Array.isArray(manifest?.operatorFundingWallets)
      ? manifest.operatorFundingWallets.map((wallet) => ({
          wallet,
          role: "operator_funding_source",
          source: "deployment_manifest.operatorFundingWallets"
        }))
      : [])
  ];
  const exclusions = new Map();
  for (const candidate of candidates) {
    if (!candidate.wallet) continue;
    const wallet = requiredAddress(candidate.wallet, candidate.role);
    exclusions.set(wallet.toLowerCase(), { ...candidate, wallet });
  }
  return [...exclusions.values()];
}

function requiredAddress(value, label) {
  try {
    return getAddress(String(value ?? ""));
  } catch {
    throw new ConfigError(`A live allocation keeper requires a valid ${label} address.`);
  }
}

function parseBoolean(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${name} must be a boolean.`);
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive integer.`);
  return parsed;
}

function boundedBasisPoints(value, fallback, name) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > Number(BPS)) {
    throw new ConfigError(`${name} must be an integer between 1 and 10000.`);
  }
  return parsed;
}

function unsignedInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim();
  if (!/^\d+$/u.test(raw)) throw new ConfigError(`${name} must be an exact base-unit integer.`);
  return BigInt(raw);
}

function positiveBigInt(value, fallback, name) {
  const parsed = unsignedInteger(value, fallback, name);
  if (parsed <= 0n) throw new ConfigError(`${name} must be positive.`);
  return parsed;
}

function exactPositiveAmount(value, field) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/u.test(raw) || BigInt(raw) <= 0n) {
    throw new ValidationError(`${field} must be an exact positive integer in USDC base units.`, { field });
  }
  return BigInt(raw);
}

function assetsForShares(sharesRaw, totalAssetsRaw, totalSharesRaw) {
  const shares = BigInt(sharesRaw ?? 0);
  const totalAssets = BigInt(totalAssetsRaw ?? 0);
  const totalShares = BigInt(totalSharesRaw ?? 0);
  if (shares === 0n || totalAssets === 0n || totalShares === 0n) return 0n;
  return shares * totalAssets / totalShares;
}

export function proportionalFloatTarget({ totalAssetsRaw, targetBps, absoluteCapRaw }) {
  const proportional = BigInt(totalAssetsRaw ?? 0) * BigInt(targetBps) / BPS;
  const cap = BigInt(absoluteCapRaw ?? 0);
  return proportional < cap ? proportional : cap;
}

function namedError(code, message, cause = undefined) {
  return new ExternalServiceError(message, code, cause ? { cause: cause?.message ?? String(cause) } : undefined);
}
