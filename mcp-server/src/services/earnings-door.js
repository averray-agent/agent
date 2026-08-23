import { Interface, formatUnits, getAddress } from "ethers";

import { AGENT_ACCOUNT_ABI, ERC20_MOCK_ABI } from "../blockchain/abis.js";
import {
  EARNINGS_ACCOUNT_STATEMENT,
  EARNINGS_BOUNDARY,
  EARNINGS_GAS_ACQUISITION_STATEMENT,
  EARNINGS_GAS_STATEMENT,
  EARNINGS_GASLESS_STATUS,
  EARNINGS_OWNERSHIP_STATEMENT,
  EARNINGS_PAYMENT_RELAY_STATUS,
  EARNINGS_WITHDRAWAL_STATEMENT
} from "../core/earnings-door-copy.js";
import {
  DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT,
  countClaimedSessions
} from "../core/claim-economics.js";
import { ValidationError } from "../core/errors.js";
import { buildPublicReputation } from "../core/public-reputation.js";
import { CREDIT_INTEREST_STATEMENT } from "../core/worker-progression.js";

const ACCOUNT_INTERFACE = new Interface(AGENT_ACCOUNT_ABI);
const TOKEN_INTERFACE = new Interface(ERC20_MOCK_ABI);
const DEFAULT_ASSET = "USDC";
export const WITHDRAWAL_STANDING_STATEMENT =
  "Withdrawing never affects your tier, badges, caps, or eligibility — your standing stays with your wallet.";

function amount(raw, decimals) {
  const value = BigInt(raw ?? 0);
  return { raw: value.toString(), decimals: Number(decimals), display: formatUnits(value, Number(decimals)) };
}

function exactPositiveRaw(value, field = "amount") {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new ValidationError(`${field} must be a positive exact base-unit integer string.`, {
      field,
      requestedValue: value
    });
  }
  return BigInt(normalized);
}

function assertOnlyFields(input, allowed) {
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) {
      throw new ValidationError(`Unsupported field '${key}'.`, { field: key });
    }
  }
}

function statementsForSessions(sessions, asset) {
  const symbol = asset.symbol.toUpperCase();
  return sessions.flatMap((session) => {
    const settlement = session?.payoutTx?.settlement;
    const rewardAsset = String(
      settlement?.assetSymbol
      ?? session?.jobSnapshot?.definition?.rewardAsset
      ?? session?.badgeSnapshot?.rewardAsset
      ?? ""
    ).toUpperCase();
    const matchesAddress = settlement?.asset
      && String(settlement.asset).toLowerCase() === asset.address.toLowerCase();
    if (
      Number(session?.payoutTx?.status) !== 1
      || !settlement?.workerAmountRaw
      || (!matchesAddress && rewardAsset !== symbol)
    ) return [];
    return [{
      type: "earnings_in",
      direction: "in",
      amount: amount(settlement.workerAmountRaw, asset.decimals),
      sessionId: session.sessionId,
      jobId: session.jobId,
      txHash: session.payoutTx.txHash,
      blockNumber: Number(session.payoutTx.blockNumber ?? 0),
      occurredAt: session.resolvedAt ?? session.updatedAt ?? null,
      receipt: {
        status: Number(session.payoutTx.status ?? 0),
        protocolFeeAmountRaw: String(settlement.protocolFeeAmountRaw ?? "0")
      }
    }];
  });
}

function statementsForStakeEvents(events, asset) {
  return (events ?? []).flatMap((event) => {
    if (String(event?.data?.asset ?? "").toLowerCase() !== asset.address.toLowerCase()) return [];
    const type = event.topic === "account.job_stake_locked"
      ? "stake_locked"
      : event.topic === "account.job_stake_released"
        ? "stake_released"
        : undefined;
    if (!type) return [];
    return [{
      type,
      direction: type === "stake_locked" ? "locked" : "released",
      amount: amount(event.data.amount, asset.decimals),
      sessionId: event.sessionId ?? null,
      jobId: event.jobId ?? null,
      txHash: event.txHash,
      blockNumber: Number(event.blockNumber ?? 0),
      occurredAt: event.timestamp ?? null
    }];
  });
}

async function collectWalletSessions(stateStore, wallet, { pageSize = 64, maxSessions = 10_000 } = {}) {
  if (typeof stateStore?.listSessionsByWallet !== "function") return [];
  const sessions = [];
  for (let offset = 0; offset < maxSessions; offset += pageSize) {
    const page = await stateStore.listSessionsByWallet(wallet, pageSize, offset);
    if (!Array.isArray(page) || page.length === 0) break;
    sessions.push(...page);
    if (page.length < pageSize) break;
  }
  if (sessions.length >= maxSessions) {
    throw new Error(`Wallet statement exceeded the ${maxSessions} session read cap`);
  }
  return sessions;
}

export class EvmEarningsDoorChainReader {
  constructor(provider) {
    this.provider = provider;
  }

  async gasQuote(transaction, wallet) {
    const [gas, feeData, nativeBalance, blockNumber] = await Promise.all([
      this.provider.estimateGas(transaction),
      this.provider.getFeeData(),
      this.provider.getBalance(wallet),
      this.provider.getBlockNumber()
    ]);
    const unitPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (unitPrice === null || unitPrice === undefined) {
      throw new Error("RPC did not return maxFeePerGas or gasPrice");
    }
    return { gas: BigInt(gas), unitPrice: BigInt(unitPrice), nativeBalance: BigInt(nativeBalance), blockNumber };
  }
}

export class EarningsDoorService {
  constructor({
    agentAccountAddress,
    chainId,
    rpcUrls = [],
    gateway,
    stateStore,
    eventBus,
    workerExposurePolicy,
    workerProgressionService,
    getReputation,
    gasGrantService,
    provider,
    chainReader
  } = {}) {
    this.agentAccountAddress = agentAccountAddress ? getAddress(agentAccountAddress) : "";
    this.chainId = Number(chainId);
    this.rpcUrls = [...new Set((rpcUrls ?? []).filter(Boolean).map(String))];
    this.gateway = gateway;
    this.stateStore = stateStore;
    this.eventBus = eventBus;
    this.workerExposurePolicy = workerExposurePolicy;
    this.workerProgressionService = workerProgressionService;
    this.getReputation = getReputation;
    this.gasGrantService = gasGrantService;
    this.chainReader = chainReader ?? (provider ? new EvmEarningsDoorChainReader(provider) : undefined);
  }

  async getAccount(wallet, assetSymbol = DEFAULT_ASSET) {
    this.#assertAvailable();
    const owner = getAddress(wallet);
    const proof = await this.gateway.getAccountPosition(owner, this.#assetSymbol(assetSymbol));
    const [sessions, stakeReplay] = await Promise.all([
      collectWalletSessions(this.stateStore, owner),
      this.eventBus?.replayDurable
        ? this.eventBus.replayDurable({
            wallet: owner,
            topics: ["account.job_stake_locked", "account.job_stake_released"]
          }, undefined, { limit: 500 })
        : { events: [] }
    ]);
    const asset = proof.asset;
    const statement = [
      ...statementsForSessions(sessions, asset),
      ...statementsForStakeEvents(stakeReplay?.events, asset)
    ].sort((left, right) => String(right.occurredAt ?? "").localeCompare(String(left.occurredAt ?? "")));
    const account = this.#accountFromProof(proof, statement);
    const firstWithdrawalGrant = await this.#grantInspection(owner, proof);
    return {
      schemaVersion: 1,
      available: true,
      framing: EARNINGS_ACCOUNT_STATEMENT,
      account,
      ownershipProof: this.#ownershipProof(owner, asset),
      withdrawal: this.#withdrawalDoor(firstWithdrawalGrant),
      whatYourBalanceCanDo: await this.#retention(owner, account.available.raw),
      boundary: EARNINGS_BOUNDARY
    };
  }

  async buildWithdrawTransactions(wallet, input = {}) {
    this.#assertAvailable();
    assertOnlyFields(input, new Set(["asset", "amount", "destination", "requestGasGrant"]));
    if (input.requestGasGrant !== undefined && typeof input.requestGasGrant !== "boolean") {
      throw new ValidationError("requestGasGrant must be a boolean.", { field: "requestGasGrant" });
    }
    const owner = getAddress(wallet);
    const assetSymbol = this.#assetSymbol(input.asset ?? DEFAULT_ASSET);
    const requested = exactPositiveRaw(input.amount);
    const proof = await this.gateway.getAccountPosition(owner, assetSymbol);
    const liquid = BigInt(proof.position.liquidRaw);
    const account = this.#accountFromProof(proof, []);
    if (requested > liquid) {
      throw new ValidationError("Withdrawal amount exceeds this account's available balance.", {
        reason: "amount_exceeds_available",
        requested: amount(requested, proof.asset.decimals),
        account
      });
    }

    const withdrawData = ACCOUNT_INTERFACE.encodeFunctionData("withdraw", [proof.asset.address, requested]);
    const withdraw = {
      step: "withdraw",
      unsigned: true,
      from: owner,
      to: this.agentAccountAddress,
      data: withdrawData,
      value: "0",
      chainId: this.chainId,
      decoded: {
        function: "withdraw(address,uint256)",
        args: {
          asset: proof.asset.address,
          amount: requested.toString(),
          amountUnit: `${proof.asset.symbol} raw (${proof.asset.decimals} decimals)`
        }
      }
    };
    const destination = input.destination ? getAddress(input.destination) : owner;
    const grantIntent = {
      wallet: owner,
      assetSymbol: proof.asset.symbol,
      assetAddress: proof.asset.address,
      amountRaw: requested.toString(),
      destination,
      liveLiquidRaw: liquid.toString()
    };
    if (
      input.requestGasGrant === true
      && typeof this.gasGrantService?.grantForWithdrawalIntent !== "function"
    ) {
      throw new ValidationError("The first-withdrawal gas grant service is unavailable; no grant was attempted.", {
        reason: "first_withdrawal_gas_grant_unavailable"
      });
    }
    const firstWithdrawalGasGrant = input.requestGasGrant === true
      ? await this.gasGrantService.grantForWithdrawalIntent(grantIntent)
      : await this.#grantInspection(owner, proof);
    withdraw.gas = await this.#gas(withdraw, owner);
    const templates = [withdraw];

    if (input.destination !== undefined) {
      const destination = getAddress(input.destination);
      const transferData = TOKEN_INTERFACE.encodeFunctionData("transfer", [destination, requested]);
      templates.push({
        step: "transfer_to_destination",
        unsigned: true,
        from: owner,
        to: getAddress(proof.asset.address),
        data: transferData,
        value: "0",
        chainId: this.chainId,
        prerequisite: "withdraw_confirmed_on_chain",
        gas: {
          status: "requires_prerequisite",
          reason: "The EOA must receive the withdrawal before an exact transfer simulation is meaningful. Rebuild after withdrawal confirmation for a fresh estimate."
        },
        decoded: {
          function: "transfer(address,uint256)",
          args: {
            to: destination,
            amount: requested.toString(),
            amountUnit: `${proof.asset.symbol} raw (${proof.asset.decimals} decimals)`
          }
        }
      });
    }

    return {
      schemaVersion: 1,
      available: true,
      wallet: owner,
      chainId: this.chainId,
      asset: proof.asset,
      account: {
        ...account,
        availableAfter: amount(liquid - requested, proof.asset.decimals)
      },
      withdrawal: {
        amount: amount(requested, proof.asset.decimals),
        destination,
        firstLandingAddress: owner
      },
      firstWithdrawalGasGrant: firstWithdrawalGasGrant ?? {
        eligible: false,
        status: "unavailable",
        reason: "first_withdrawal_gas_grant_unavailable"
      },
      standing: await this.getStanding(owner),
      templates,
      instructions: [
        "Independently decode every template and verify chainId, from, to, function, asset, amount, and destination before signing.",
        ...(firstWithdrawalGasGrant?.eligible === true
          ? ["If this is your first withdrawal, rebuild with requestGasGrant: true. Your first withdrawal's network fee is on us when the returned eligibility guards pass."]
          : []),
        "Sign and broadcast with this account owner's key through one of the returned public RPC URLs.",
        ...(input.destination
          ? ["Wait for withdrawal confirmation, rebuild for a live transfer gas estimate, then verify, sign, and broadcast the transfer template."]
          : []),
        "Re-read getAccountPosition and the destination token balance after confirmation."
      ],
      broadcast: {
        rpcUrls: this.rpcUrls,
        method: "eth_sendRawTransaction",
        signer: "your own wallet",
        feeAsset: "DOT",
        note: "Sign locally and submit through your own RPC. Averray has no signed-transaction relay."
      },
      whatYourBalanceCanDo: await this.#retention(owner, requested.toString()),
      boundary: EARNINGS_BOUNDARY
    };
  }

  #accountFromProof(proof, statement) {
    return {
      owner: getAddress(proof.wallet),
      asset: proof.asset,
      available: amount(proof.position.liquidRaw, proof.asset.decimals),
      stakedOnOpenWork: amount(proof.position.jobStakeLockedRaw, proof.asset.decimals),
      statement
    };
  }

  #ownershipProof(owner, asset) {
    return {
      statement: EARNINGS_OWNERSHIP_STATEMENT,
      chainId: this.chainId,
      contract: "AgentAccountCore",
      address: this.agentAccountAddress,
      method: "positions(address,address)",
      args: { account: owner, asset: asset.address },
      field: "liquid"
    };
  }

  #withdrawalDoor(firstWithdrawalGrant) {
    return {
      statement: EARNINGS_WITHDRAWAL_STATEMENT,
      http: { method: "POST", path: "/account/withdraw/transactions" },
      mcp: { tool: "buildWithdrawTransactions" },
      gas: {
        asset: "DOT",
        statement: EARNINGS_GAS_STATEMENT,
        acquisition: EARNINGS_GAS_ACQUISITION_STATEMENT,
        gasless: EARNINGS_GASLESS_STATUS,
        firstWithdrawalGrant: firstWithdrawalGrant ?? {
          eligible: false,
          status: "unavailable",
          reason: "first_withdrawal_gas_grant_unavailable"
        }
      },
      paymentRelay: EARNINGS_PAYMENT_RELAY_STATUS
    };
  }

  async #retention(wallet, additionalVestedRaw) {
    let current;
    let projected;
    if (typeof this.workerExposurePolicy?.capacityForWallet === "function") {
      [current, projected] = await Promise.all([
        this.workerExposurePolicy.capacityForWallet(wallet),
        this.workerExposurePolicy.capacityForWallet(wallet, { additionalVestedRaw })
      ]);
    }
    const infoOnly = {
      informationalOnly: true,
      conditionsWithdrawal: false,
      delaysWithdrawal: false,
      pricesWithdrawal: false,
      addsWithdrawalSteps: false,
      templatesRemainComplete: true
    };
    return {
      retentionNotGates: infoOnly,
      rollToPool: {
        available: true,
        amountQuoted: amount(additionalVestedRaw, 6),
        route: { info: "/pool", transactions: "/pool/transactions" },
        vesting: { durationHours: Number(projected?.vestingHours ?? current?.vestingHours ?? 48), projectedAt: "full_vesting" },
        currentCapacity: current ?? null,
        projectedCapacity: projected ?? null,
        note: "A pool deposit begins unvested. The projected capacity is reached only after the 48-hour linear vesting ramp and remains subject to live pool caps."
      },
      stakeForJobs: {
        available: true,
        source: "account.available",
        note: "Where a job's claim tier requires stake, this available balance can fund it. Call preflightJob for the exact job-specific amount."
      }
    };
  }

  async getStanding(wallet, { progression: progressionSource, reputation: reputationSource } = {}) {
    if (
      typeof this.workerProgressionService?.getProgression !== "function"
      || typeof this.getReputation !== "function"
    ) {
      throw new Error("Withdrawal standing requires the canonical worker progression and reputation readers.");
    }
    const waiverClaimsUsedPromise = this.gateway?.isEnabled?.()
      && typeof this.gateway?.getWorkerClaimCount === "function"
      ? this.gateway.getWorkerClaimCount(wallet)
      : collectWalletSessions(this.stateStore, wallet).then(countClaimedSessions);
    const [progression, reputation, waiverClaimsUsed] = await Promise.all([
      progressionSource ?? this.workerProgressionService.getProgression(wallet),
      reputationSource ?? this.getReputation(wallet),
      waiverClaimsUsedPromise
    ]);
    if (!progression) {
      throw new Error("Withdrawal standing is unavailable for this wallet.");
    }
    const creditInterest = {
      eligible: progression.creditInterest?.eligible === true,
      registered: progression.creditInterest?.registered === true
    };
    return {
      claimTier: progression.tier,
      claimTierLabel: "claim tier",
      reputationTier: buildPublicReputation(reputation).tier,
      badges: Array.isArray(progression.badges) ? progression.badges.length : 0,
      waiverSlotsRemaining: Math.max(
        DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT - Math.max(0, Number(waiverClaimsUsed) || 0),
        0
      ),
      creditInterest,
      ...(creditInterest.eligible
        ? {
            registerPath: "/credit/interest",
            creditInterestStatement: CREDIT_INTEREST_STATEMENT
          }
        : {}),
      persists: true,
      statement: WITHDRAWAL_STANDING_STATEMENT
    };
  }

  async #grantInspection(wallet, proof) {
    if (typeof this.gasGrantService?.inspect !== "function") return undefined;
    try {
      return await this.gasGrantService.inspect({
        wallet,
        liquidRaw: proof.position.liquidRaw,
        assetSymbol: proof.asset.symbol,
        assetDecimals: proof.asset.decimals
      });
    } catch {
      return {
        eligible: false,
        status: "unavailable",
        reason: "first_withdrawal_gas_grant_status_read_failed"
      };
    }
  }

  async getGasGrantOpsStatus() {
    if (typeof this.gasGrantService?.getOpsStatus !== "function") {
      return { available: false, reason: "first_withdrawal_gas_grant_unavailable" };
    }
    return this.gasGrantService.getOpsStatus();
  }

  async #gas(template, wallet) {
    try {
      const quote = await this.chainReader.gasQuote({
        from: template.from,
        to: template.to,
        data: template.data,
        value: 0n
      }, wallet);
      const required = quote.gas * quote.unitPrice;
      return {
        status: "measured",
        source: "eth_estimateGas plus live RPC fee data at quote time",
        quoteBlockNumber: Number(quote.blockNumber),
        asset: { symbol: "DOT", decimals: 18 },
        gasUnits: quote.gas.toString(),
        maxFeePerGasRaw: quote.unitPrice.toString(),
        estimatedFee: amount(required, 18),
        walletBalance: amount(quote.nativeBalance, 18),
        sufficient: quote.nativeBalance >= required,
        statement: EARNINGS_GAS_STATEMENT,
        acquisition: EARNINGS_GAS_ACQUISITION_STATEMENT
      };
    } catch (error) {
      throw new ValidationError("A live withdrawal gas estimate is unavailable; no transaction was offered as broadcast-ready.", {
        reason: "gas_estimate_unavailable",
        message: error?.message ?? String(error)
      });
    }
  }

  #assetSymbol(value) {
    const symbol = String(value ?? "").trim().toUpperCase();
    if (!symbol) throw new ValidationError("asset is required.");
    return symbol;
  }

  #assertAvailable() {
    if (!this.agentAccountAddress || !this.gateway?.isEnabled?.()) {
      throw new Error("Earnings door requires the configured AgentAccountCore gateway.");
    }
    if (!this.chainReader) throw new Error("Earnings door requires a chain reader.");
    if (!Number.isSafeInteger(this.chainId) || this.chainId <= 0) {
      throw new Error("Earnings door requires a positive chainId.");
    }
  }
}
