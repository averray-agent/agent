import { Contract, Interface, getAddress } from "ethers";

import { DEPOSIT_POOL_ABI, ERC20_MOCK_ABI } from "../blockchain/abis.js";
import {
  DEPOSIT_POOL_CAPITAL_SIGNAL_STATEMENT,
  DEPOSIT_POOL_RISK_DISCLOSURE
} from "../core/deposit-pool-disclosure.js";
import { ValidationError } from "../core/errors.js";
import { depositPoolYieldStatus } from "./deposit-pool-yield-status.js";

const ASSET_DECIMALS = 6;
const SHARE_DECIMALS = 6;
const SHARE_PRICE_SCALE = 1_000_000n;

export const DEPOSIT_POOL_WITHDRAWAL_NOTE =
  "Deposited assets are not locked. You may redeem available shares from the pool buffer at any time; withdrawals burn the newest vesting tranches first and reduce the capital-backed capacity signal immediately.";

const BOUNDARY = Object.freeze({
  custody: "depositor_wallet_only",
  platformHoldsFunds: false,
  platformMovesFunds: false,
  platformBrokersFunds: false,
  platformSigns: false,
  platformSeesKeys: false,
  signedTransactionRelay: false,
  statement: "Averray returns information and unsigned transaction templates only. Your wallet verifies, signs, and broadcasts through your chosen RPC."
});

const POOL_INTERFACE = new Interface(DEPOSIT_POOL_ABI);
const TOKEN_INTERFACE = new Interface(ERC20_MOCK_ABI);

function amount(raw, decimals = ASSET_DECIMALS) {
  return { raw: BigInt(raw).toString(), decimals };
}

function clampAtZero(raw) {
  const value = BigInt(raw);
  return value > 0n ? value : 0n;
}

function exactPositiveRaw(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/u.test(normalized) || BigInt(normalized) <= 0n) {
    throw new ValidationError(`${field} must be a positive exact base-unit integer string.`, {
      field,
      unit: field === "shares" ? "pool share raw units (6 decimals)" : "USDC raw units (6 decimals)",
      requestedValue: value
    });
  }
  return BigInt(normalized);
}

function assertOnlyFields(input, allowed) {
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) throw new ValidationError(`Unsupported field '${key}'.`, { field: key });
  }
}

function refusal(reason, details) {
  return new ValidationError(`${reason}: the unsigned transaction would revert on chain.`, {
    reason,
    ...details
  });
}

export class EvmDepositPoolDoorChainReader {
  constructor(provider) {
    this.provider = provider;
  }

  async readSnapshot({ poolAddress, wallet = undefined }) {
    const blockNumber = await this.provider.getBlockNumber();
    const block = await this.provider.getBlock(blockNumber);
    const blockTag = { blockTag: blockNumber };
    const pool = new Contract(poolAddress, DEPOSIT_POOL_ABI, this.provider);
    const [asset, totalAssets, totalSupply, bufferAssets, deployedPrincipal, totalAssetCap, perAgentAssetCap] = await Promise.all([
      pool.asset(blockTag),
      pool.totalAssets(blockTag),
      pool.totalSupply(blockTag),
      pool.bufferAssets(blockTag),
      pool.venuePrincipalCostBasis(blockTag),
      pool.TOTAL_ASSET_CAP(blockTag),
      pool.PER_AGENT_ASSET_CAP(blockTag)
    ]);
    let walletState;
    if (wallet) {
      const token = new Contract(asset, ERC20_MOCK_ABI, this.provider);
      const [assetBalance, depositedAssets, shares, availableShares, allowance] = await Promise.all([
        token.balanceOf(wallet, blockTag),
        pool.assetsOf(wallet, blockTag),
        pool.balanceOf(wallet, blockTag),
        pool.availableShares(wallet, blockTag),
        token.allowance(wallet, poolAddress, blockTag)
      ]);
      walletState = { assetBalance, depositedAssets, shares, availableShares, allowance };
    }
    return {
      blockNumber,
      blockHash: block?.hash ?? null,
      blockTimestamp: block?.timestamp === undefined ? null : Number(block.timestamp),
      asset,
      totalAssets,
      totalSupply,
      bufferAssets,
      deployedPrincipal,
      totalAssetCap,
      perAgentAssetCap,
      wallet: walletState
    };
  }

  async estimateGas(transaction) {
    return this.provider.estimateGas(transaction);
  }

  async convertToShares({ poolAddress, assets, blockNumber }) {
    const pool = new Contract(poolAddress, DEPOSIT_POOL_ABI, this.provider);
    return pool.convertToShares(assets, { blockTag: blockNumber });
  }

  async convertToAssets({ poolAddress, shares, blockNumber }) {
    const pool = new Contract(poolAddress, DEPOSIT_POOL_ABI, this.provider);
    return pool.convertToAssets(shares, { blockTag: blockNumber });
  }
}

export class DepositPoolDoorService {
  constructor({
    poolAddress,
    chainId,
    rpcUrls = [],
    provider,
    chainReader,
    workerExposurePolicy,
    lockedTierService,
    vestingHours = 48
  } = {}) {
    this.poolAddress = poolAddress ? getAddress(poolAddress) : "";
    this.chainId = Number(chainId);
    this.rpcUrls = [...new Set((rpcUrls ?? []).filter(Boolean).map(String))];
    this.chainReader = chainReader ?? (provider ? new EvmDepositPoolDoorChainReader(provider) : undefined);
    this.workerExposurePolicy = workerExposurePolicy;
    this.lockedTierService = lockedTierService;
    this.vestingHours = Number(vestingHours);
  }

  async getInfo(wallet = undefined) {
    if (!this.poolAddress) return unavailable();
    this.#assertReadable();
    const normalizedWallet = wallet ? getAddress(wallet) : undefined;
    const snapshot = normalizeSnapshot(await this.chainReader.readSnapshot({
      poolAddress: this.poolAddress,
      wallet: normalizedWallet
    }));
    const info = await this.#infoFromSnapshot(snapshot, normalizedWallet);
    if (typeof this.lockedTierService?.getPoolTelemetry !== "function") return info;
    return {
      ...info,
      lockedDeposits: await this.lockedTierService.getPoolTelemetry(normalizedWallet)
    };
  }

  async buildTransactions(wallet, input = {}) {
    if (!this.poolAddress) return unavailable();
    this.#assertReadable();
    const normalizedWallet = getAddress(wallet);
    const direction = String(input?.direction ?? "").trim();
    if (direction === "deposit") {
      assertOnlyFields(input, new Set(["direction", "assets"]));
      return this.#buildDeposit(normalizedWallet, exactPositiveRaw(input.assets, "assets"));
    }
    if (direction === "withdraw") {
      assertOnlyFields(input, new Set(["direction", "assets", "shares"]));
      const hasAssets = input.assets !== undefined;
      const hasShares = input.shares !== undefined;
      if (hasAssets === hasShares) {
        throw new ValidationError("Withdraw requires exactly one of assets or shares.");
      }
      return this.#buildWithdraw(normalizedWallet, {
        assets: hasAssets ? exactPositiveRaw(input.assets, "assets") : undefined,
        shares: hasShares ? exactPositiveRaw(input.shares, "shares") : undefined
      });
    }
    throw new ValidationError("direction must be deposit or withdraw.", {
      field: "direction",
      requestedValue: input?.direction
    });
  }

  async #buildDeposit(wallet, assets) {
    const snapshot = normalizeSnapshot(await this.chainReader.readSnapshot({ poolAddress: this.poolAddress, wallet }));
    const managedAfter = snapshot.totalAssets + assets;
    if (managedAfter > snapshot.totalAssetCap) {
      throw refusal("TotalAssetCapExceeded", {
        attempted: amount(managedAfter),
        cap: amount(snapshot.totalAssetCap)
      });
    }
    if (snapshot.wallet.assetBalance < assets) {
      throw refusal("InsufficientBalance", {
        available: amount(snapshot.wallet.assetBalance),
        required: amount(assets)
      });
    }
    // Use the deployed pool's conversion lens at the same block as every cap
    // input. The mirrored arithmetic below is only the contract's cap check;
    // it must never become a second share-price implementation.
    const expectedShares = BigInt(await this.chainReader.convertToShares({
      poolAddress: this.poolAddress,
      assets,
      blockNumber: snapshot.blockNumber
    }));
    if (expectedShares === 0n) throw refusal("ZeroShares", { assets: amount(assets) });
    const supplyAfter = snapshot.totalSupply + expectedShares;
    const attemptedAgentAssets = (snapshot.wallet.shares + expectedShares) * managedAfter / supplyAfter;
    if (attemptedAgentAssets > snapshot.perAgentAssetCap) {
      throw refusal("AgentAssetCapExceeded", {
        agent: wallet,
        attempted: amount(attemptedAgentAssets),
        cap: amount(snapshot.perAgentAssetCap)
      });
    }

    const approveRequired = snapshot.wallet.allowance < assets;
    const templates = [];
    if (approveRequired) {
      const data = TOKEN_INTERFACE.encodeFunctionData("approve", [this.poolAddress, assets]);
      templates.push(await this.#template({
        step: "approve",
        from: wallet,
        to: snapshot.asset,
        data,
        decoded: {
          function: "approve(address,uint256)",
          args: { spender: this.poolAddress, amount: assets.toString(), amountUnit: "USDC raw (6 decimals)" }
        }
      }));
    }
    const depositData = POOL_INTERFACE.encodeFunctionData("deposit", [assets, wallet]);
    templates.push(await this.#template({
      step: "deposit",
      from: wallet,
      to: this.poolAddress,
      data: depositData,
      decoded: {
        function: "deposit(uint256,address)",
        args: { assets: assets.toString(), assetsUnit: "USDC raw (6 decimals)", receiver: wallet }
      },
      prerequisite: approveRequired ? "approve_confirmed_on_chain" : undefined
    }));

    return {
      schemaVersion: 1,
      available: true,
      direction: "deposit",
      wallet,
      pool: this.poolAddress,
      asset: snapshot.asset,
      chainId: this.chainId,
      block: blockProof(snapshot),
      approval: {
        required: approveRequired,
        reason: approveRequired ? "allowance_below_requested_assets" : "allowance_already_sufficient",
        allowanceBefore: amount(snapshot.wallet.allowance),
        allowanceAfter: amount(approveRequired ? assets : snapshot.wallet.allowance)
      },
      preview: {
        assets: amount(assets),
        expectedShares: amount(expectedShares, SHARE_DECIMALS),
        poolHeadroomBefore: amount(clampAtZero(snapshot.totalAssetCap - snapshot.totalAssets)),
        poolHeadroomConsumed: amount(assets),
        perAgentHeadroomBefore: amount(clampAtZero(snapshot.perAgentAssetCap - snapshot.wallet.depositedAssets)),
        perAgentHeadroomConsumed: amount(attemptedAgentAssets - snapshot.wallet.depositedAssets),
        sharePrice: sharePrice(snapshot),
        quoteBlockNumber: snapshot.blockNumber
      },
      templates,
      instructions: approveRequired
        ? [
            "Verify and sign the approve template with this wallet, then broadcast it through one of the returned RPC URLs.",
            "Wait for approval confirmation. Re-run buildDepositPoolTransactions to obtain a live deposit gas estimate, then verify, sign, and broadcast deposit.",
            "Re-read getDepositPoolInfo and explainEligibility after deposit confirmation."
          ]
        : [
            "Verify, sign, and broadcast the deposit template with this wallet through one of the returned RPC URLs.",
            "Re-read getDepositPoolInfo and explainEligibility after deposit confirmation."
          ],
      broadcast: broadcastInstructions(this.rpcUrls),
      boundary: BOUNDARY
    };
  }

  async #buildWithdraw(wallet, requested) {
    const snapshot = normalizeSnapshot(await this.chainReader.readSnapshot({ poolAddress: this.poolAddress, wallet }));
    let shares;
    if (requested.shares !== undefined) {
      shares = requested.shares;
    } else {
      shares = BigInt(await this.chainReader.convertToShares({
        poolAddress: this.poolAddress,
        assets: requested.assets,
        blockNumber: snapshot.blockNumber
      }));
      const floorAssets = BigInt(await this.chainReader.convertToAssets({
        poolAddress: this.poolAddress,
        shares,
        blockNumber: snapshot.blockNumber
      }));
      // convertToShares rounds down. Redeeming by requested assets must round
      // shares up when that floor would return less than the requested amount.
      if (floorAssets < requested.assets) shares += 1n;
    }
    if (shares > snapshot.wallet.availableShares) {
      throw refusal("InsufficientUnlockedShares", {
        available: amount(snapshot.wallet.availableShares, SHARE_DECIMALS),
        required: amount(shares, SHARE_DECIMALS)
      });
    }
    const expectedAssets = BigInt(await this.chainReader.convertToAssets({
      poolAddress: this.poolAddress,
      shares,
      blockNumber: snapshot.blockNumber
    }));
    if (expectedAssets === 0n) throw refusal("ZeroAmount", { shares: amount(shares, SHARE_DECIMALS) });
    if (expectedAssets > snapshot.bufferAssets) {
      throw refusal("InsufficientBuffer", {
        available: amount(snapshot.bufferAssets),
        required: amount(expectedAssets)
      });
    }
    const data = POOL_INTERFACE.encodeFunctionData("redeem", [shares, wallet, wallet]);
    const template = await this.#template({
      step: "redeem",
      from: wallet,
      to: this.poolAddress,
      data,
      decoded: {
        function: "redeem(uint256,address,address)",
        args: {
          shares: shares.toString(),
          sharesUnit: "pool share raw (6 decimals)",
          receiver: wallet,
          owner: wallet
        }
      }
    });
    return {
      schemaVersion: 1,
      available: true,
      direction: "withdraw",
      wallet,
      pool: this.poolAddress,
      asset: snapshot.asset,
      chainId: this.chainId,
      block: blockProof(snapshot),
      preview: {
        requested: requested.assets !== undefined
          ? { assets: amount(requested.assets) }
          : { shares: amount(requested.shares, SHARE_DECIMALS) },
        sharesToRedeem: amount(shares, SHARE_DECIMALS),
        expectedAssets: amount(expectedAssets),
        availableSharesBefore: amount(snapshot.wallet.availableShares, SHARE_DECIMALS),
        bufferAssetsBefore: amount(snapshot.bufferAssets),
        sharePrice: sharePrice(snapshot),
        quoteBlockNumber: snapshot.blockNumber
      },
      templates: [template],
      instructions: [
        "Verify, sign, and broadcast the redeem template with this wallet through one of the returned RPC URLs.",
        "Re-read getDepositPoolInfo and explainEligibility after redemption confirmation."
      ],
      broadcast: broadcastInstructions(this.rpcUrls),
      boundary: BOUNDARY
    };
  }

  async #template({ step, from, to, data, decoded, prerequisite = undefined }) {
    let gasEstimate;
    if (prerequisite) {
      gasEstimate = {
        status: "requires_prerequisite",
        gas: null,
        prerequisite,
        reason: "The deposit simulation would correctly revert until the approve transaction is confirmed. Re-run this tool after approval for a live estimate."
      };
    } else {
      try {
        gasEstimate = {
          status: "estimated",
          gas: BigInt(await this.chainReader.estimateGas({ from, to, data, value: 0n })).toString(),
          source: "eth_estimateGas at quote time"
        };
      } catch (error) {
        throw refusal("GasEstimateUnavailable", { step, message: error?.message ?? String(error) });
      }
    }
    return {
      step,
      unsigned: true,
      from,
      to: getAddress(to),
      data,
      value: "0",
      chainId: this.chainId,
      gasEstimate,
      decoded
    };
  }

  async #infoFromSnapshot(snapshot, wallet) {
    const yieldState = depositPoolYieldStatus(snapshot.deployedPrincipal);
    const response = {
      schemaVersion: 1,
      available: true,
      pool: this.poolAddress,
      asset: snapshot.asset,
      chainId: this.chainId,
      units: {
        asset: { symbol: "USDC", decimals: ASSET_DECIMALS, input: "exact raw integer string" },
        shares: { symbol: "DepositPool share", decimals: SHARE_DECIMALS, input: "exact raw integer string" }
      },
      block: blockProof(snapshot),
      totalAssets: amount(snapshot.totalAssets),
      totalShares: amount(snapshot.totalSupply, SHARE_DECIMALS),
      // The locked-tier quote consumes this info shape and refuses to price a
      // lock without the pool's share price (poolSnapshot fail-closed check).
      sharePrice: sharePrice(snapshot),
      bufferAssets: amount(snapshot.bufferAssets),
      caps: {
        totalAssetCap: amount(snapshot.totalAssetCap),
        perAgentAssetCap: amount(snapshot.perAgentAssetCap),
        poolHeadroom: amount(clampAtZero(snapshot.totalAssetCap - snapshot.totalAssets))
      },
      ...yieldState,
      disclosure: { statement: DEPOSIT_POOL_RISK_DISCLOSURE },
      capitalSignal: {
        statement: DEPOSIT_POOL_CAPITAL_SIGNAL_STATEMENT,
        vesting: {
          model: "linear_per_deposit_tranche",
          durationHours: this.vestingHours,
          withdrawalBurnOrder: "lifo"
        },
        catalogueEffect: "none"
      },
      withdrawal: { status: "open", note: DEPOSIT_POOL_WITHDRAWAL_NOTE },
      broadcast: broadcastInstructions(this.rpcUrls),
      boundary: BOUNDARY
    };
    if (wallet) {
      const capacity = await this.#capacityForWallet(wallet);
      response.wallet = {
        address: wallet,
        assetBalance: amount(snapshot.wallet.assetBalance),
        depositedAssets: amount(snapshot.wallet.depositedAssets),
        shares: amount(snapshot.wallet.shares, SHARE_DECIMALS),
        availableShares: amount(snapshot.wallet.availableShares, SHARE_DECIMALS),
        allowanceToPool: amount(snapshot.wallet.allowance),
        perAgentHeadroom: amount(clampAtZero(snapshot.perAgentAssetCap - snapshot.wallet.depositedAssets)),
        vestedAssets: amount(capacity.vestedAssetsRaw),
        vesting: {
          model: "linear_per_deposit_tranche",
          durationHours: capacity.vestingHours,
          withdrawalBurnOrder: "lifo",
          available: capacity.vestingAvailable,
          ...(capacity.evaluatedAt ? { evaluatedAt: capacity.evaluatedAt } : {}),
          tranches: capacity.tranches
        },
        openExposureRaise: amount(capacity.openExposureRaiseRaw),
        openExposureCap: amount(capacity.openExposureCapRaw),
        externalRewardCeiling: amount(capacity.externalRewardCeilingRaw)
      };
    }
    return response;
  }

  async #capacityForWallet(wallet) {
    if (typeof this.workerExposurePolicy?.capacityForWallet === "function") {
      return this.workerExposurePolicy.capacityForWallet(wallet);
    }
    return {
      vestedAssetsRaw: "0",
      openExposureRaiseRaw: "0",
      openExposureCapRaw: "2500000",
      externalRewardCeilingRaw: "1000000",
      vestingHours: this.vestingHours,
      vestingAvailable: false,
      tranches: []
    };
  }

  #assertReadable() {
    if (!this.chainReader) throw new Error("DepositPool door requires a chain reader when configured.");
    if (!Number.isSafeInteger(this.chainId) || this.chainId <= 0) {
      throw new Error("DepositPool door requires a positive chainId.");
    }
  }
}

function normalizeSnapshot(input) {
  const wallet = input.wallet
    ? Object.fromEntries(Object.entries(input.wallet).map(([key, value]) => [key, BigInt(value)]))
    : undefined;
  return {
    ...input,
    asset: getAddress(input.asset),
    blockNumber: Number(input.blockNumber),
    totalAssets: BigInt(input.totalAssets),
    totalSupply: BigInt(input.totalSupply),
    bufferAssets: BigInt(input.bufferAssets),
    deployedPrincipal: BigInt(input.deployedPrincipal),
    totalAssetCap: BigInt(input.totalAssetCap),
    perAgentAssetCap: BigInt(input.perAgentAssetCap),
    wallet
  };
}

function sharePrice(snapshot) {
  return {
    model: "principal-cost-basis",
    assetsPerShare: amount(
      snapshot.totalSupply === 0n
        ? SHARE_PRICE_SCALE
        : snapshot.totalAssets * SHARE_PRICE_SCALE / snapshot.totalSupply
    ),
    numeratorAssetsRaw: snapshot.totalAssets.toString(),
    denominatorSharesRaw: snapshot.totalSupply.toString()
  };
}

function blockProof(snapshot) {
  return {
    number: snapshot.blockNumber,
    hash: snapshot.blockHash ?? null,
    ...(snapshot.blockTimestamp === null || snapshot.blockTimestamp === undefined
      ? {}
      : {
          timestamp: snapshot.blockTimestamp,
          timestampIso: new Date(snapshot.blockTimestamp * 1_000).toISOString()
        })
  };
}

function broadcastInstructions(rpcUrls) {
  return {
    rpcUrls,
    method: "eth_sendRawTransaction",
    signer: "your own wallet",
    feeAsset: "DOT",
    note: "Sign locally and submit through your own RPC. Averray has no signed-transaction relay."
  };
}

function unavailable() {
  return { schemaVersion: 1, available: false, reason: "deposit_pool_not_configured" };
}
