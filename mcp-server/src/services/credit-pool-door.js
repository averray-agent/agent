import { Contract, Interface, getAddress } from "ethers";

import { CREDIT_POOL_ABI, DEPOSIT_POOL_V2_ABI, ERC20_MOCK_ABI } from "../blockchain/abis.js";
import {
  CREDIT_POOL_REPAYMENT_NOTE,
  CREDIT_POOL_RISK_DISCLOSURE
} from "../core/credit-pool-disclosure.js";
import { ValidationError } from "../core/errors.js";

const ASSET_DECIMALS = 6;
const SHARE_DECIMALS = 6;
const BPS = 10_000n;
const ATTESTATION_TTL_SECONDS = 5 * 60;
const CREDIT_INTERFACE = new Interface(CREDIT_POOL_ABI);
const DEPOSIT_INTERFACE = new Interface(DEPOSIT_POOL_V2_ABI);
const TOKEN_INTERFACE = new Interface(ERC20_MOCK_ABI);

const BOUNDARY = Object.freeze({
  custody: "wallet_only",
  platformHoldsFunds: false,
  platformMovesFunds: false,
  platformBrokersFunds: false,
  platformSignsTransactions: false,
  signedTransactionRelay: false,
  vestingAttestation: "The operator signs only a short-lived eligibility fact. Your wallet alone signs and broadcasts every transaction.",
  statement: "Averray returns live information and unsigned transaction templates only. Your wallet verifies, signs, and broadcasts through its chosen RPC."
});

function amount(raw, decimals = ASSET_DECIMALS) {
  return { raw: BigInt(raw).toString(), decimals };
}

function exactPositiveRaw(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new ValidationError(`${field} must be a positive exact base-unit integer string.`, {
      field,
      requestedValue: value
    });
  }
  return BigInt(normalized);
}

function exactLoanId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(normalized)) {
    throw new ValidationError("loanId must be a bytes32 hex string.", { field: "loanId" });
  }
  return normalized;
}

function assertOnlyFields(input, allowed) {
  for (const key of Object.keys(input ?? {})) {
    if (!allowed.has(key)) throw new ValidationError(`Unsupported field '${key}'.`, { field: key });
  }
}

function refuse(reason, details = {}) {
  return new ValidationError(`${reason}: the unsigned transaction would revert on chain.`, {
    reason,
    ...details
  });
}

export class EvmCreditPoolDoorChainReader {
  constructor(provider) {
    this.provider = provider;
  }

  async readSnapshot({ creditPoolAddress, depositPoolAddress, wallet }) {
    const blockNumber = await this.provider.getBlockNumber();
    const block = await this.provider.getBlock(blockNumber);
    const at = { blockTag: blockNumber };
    const credit = new Contract(creditPoolAddress, CREDIT_POOL_ABI, this.provider);
    const deposit = new Contract(depositPoolAddress, DEPOSIT_POOL_V2_ABI, this.provider);
    const [
      asset, configuredDepositPool, operator, totalAssets, totalSupply, bufferAssets,
      principalOutstanding, totalPledgedShares, defaults, ltvBps, interestBps,
      totalAssetCap, perLenderCap, maxLtvBps, maxInterestBps, platformFeeBps, disclosure,
      lenderShares, lenderAssets, lenderAvailableShares, outstandingDebt, nextLoanNonce,
      attestationNonce, depositShares, depositAvailableShares, pledgedShares
    ] = await Promise.all([
      credit.asset(at), credit.depositPool(at), credit.operator(at), credit.totalAssets(at),
      credit.totalSupply(at), credit.bufferAssets(at), credit.principalOutstanding(at),
      credit.totalPledgedShares(at), credit.defaults(at), credit.ltvBps(at), credit.interestBps(at),
      credit.TOTAL_ASSET_CAP(at), credit.PER_LENDER_CAP(at), credit.MAX_LTV_BPS(at),
      credit.MAX_INTEREST_BPS(at), credit.PLATFORM_FEE_BPS(at), credit.RISK_DISCLOSURE(at),
      credit.balanceOf(wallet, at), credit.assetsOf(wallet, at), credit.availableShares(wallet, at),
      credit.outstandingDebt(wallet, at), credit.nextLoanNonce(wallet, at),
      credit.vestingAttestationNonces(wallet, at), deposit.balanceOf(wallet, at),
      deposit.availableShares(wallet, at), deposit.pledgedShares(wallet, at)
    ]);
    if (getAddress(configuredDepositPool) !== getAddress(depositPoolAddress)) {
      throw new Error("CreditPool depositPool binding does not match configured DepositPool v2.");
    }
    const token = new Contract(asset, ERC20_MOCK_ABI, this.provider);
    const [assetBalance, allowance, pledgedAssetValue] = await Promise.all([
      token.balanceOf(wallet, at),
      token.allowance(wallet, creditPoolAddress, at),
      deposit.convertToAssets(pledgedShares, at)
    ]);
    return {
      blockNumber,
      blockHash: block?.hash ?? null,
      blockTimestamp: block?.timestamp === undefined ? null : Number(block.timestamp),
      asset, operator, totalAssets, totalSupply, bufferAssets, principalOutstanding,
      totalPledgedShares, defaults, ltvBps, interestBps, totalAssetCap, perLenderCap,
      maxLtvBps, maxInterestBps, platformFeeBps, disclosure,
      wallet: {
        assetBalance, allowance, lenderShares, lenderAssets, lenderAvailableShares,
        outstandingDebt, nextLoanNonce, attestationNonce, depositShares,
        depositAvailableShares, pledgedShares, pledgedAssetValue
      }
    };
  }

  estimateGas(transaction) {
    return this.provider.estimateGas(transaction);
  }

  async previewLoanId({ creditPoolAddress, wallet, blockNumber }) {
    return new Contract(creditPoolAddress, CREDIT_POOL_ABI, this.provider)
      .previewLoanId(wallet, { blockTag: blockNumber });
  }

  async convertCreditToShares({ creditPoolAddress, assets, blockNumber }) {
    return new Contract(creditPoolAddress, CREDIT_POOL_ABI, this.provider)
      .convertToShares(assets, { blockTag: blockNumber });
  }

  async convertCreditToAssets({ creditPoolAddress, shares, blockNumber }) {
    return new Contract(creditPoolAddress, CREDIT_POOL_ABI, this.provider)
      .convertToAssets(shares, { blockTag: blockNumber });
  }

  async convertDepositToAssets({ depositPoolAddress, shares, blockNumber }) {
    return new Contract(depositPoolAddress, DEPOSIT_POOL_V2_ABI, this.provider)
      .convertToAssets(shares, { blockTag: blockNumber });
  }

  async readLoan({ creditPoolAddress, loanId, blockNumber }) {
    const value = await new Contract(creditPoolAddress, CREDIT_POOL_ABI, this.provider)
      .loans(loanId, { blockTag: blockNumber });
    return {
      borrower: value.borrower,
      outstandingPrincipal: value.outstandingPrincipal,
      outstandingInterest: value.outstandingInterest,
      status: value.status
    };
  }
}

export class CreditPoolDoorService {
  constructor({
    creditPoolAddress,
    depositPoolAddress,
    chainId,
    rpcUrls = [],
    provider,
    chainReader,
    capacityReader,
    vestingAttestor,
    creditBookDoor,
    now = () => Date.now()
  } = {}) {
    this.creditPoolAddress = creditPoolAddress ? getAddress(creditPoolAddress) : "";
    this.depositPoolAddress = depositPoolAddress ? getAddress(depositPoolAddress) : "";
    this.chainId = Number(chainId);
    this.rpcUrls = [...new Set((rpcUrls ?? []).filter(Boolean).map(String))];
    this.chainReader = chainReader ?? (provider ? new EvmCreditPoolDoorChainReader(provider) : undefined);
    this.capacityReader = capacityReader;
    this.vestingAttestor = vestingAttestor;
    this.creditBookDoor = creditBookDoor;
    this.now = now;
  }

  async getInfo(wallet) {
    const receiptGraph = this.creditBookDoor
      ? await this.creditBookDoor.getInfo(wallet)
      : undefined;
    if (!this.creditPoolAddress || !this.depositPoolAddress) {
      if (!receiptGraph?.available) return unavailable();
      return {
        schemaVersion: 2,
        available: true,
        l1: unavailable(),
        receiptGraph
      };
    }
    this.#assertReadReady();
    const normalizedWallet = getAddress(wallet);
    const [snapshot, capacity] = await Promise.all([
      this.#snapshot(normalizedWallet),
      this.#capacity(normalizedWallet)
    ]);
    const response = this.#response(snapshot, normalizedWallet, capacity);
    return receiptGraph ? { ...response, schemaVersion: 2, receiptGraph } : response;
  }

  async buildTransactions(wallet, input = {}) {
    const normalizedWallet = getAddress(wallet);
    const direction = String(input?.direction ?? "").trim();
    if (["cash_consent", "posting_consent", "credit_book_repay"].includes(direction)) {
      if (!this.creditBookDoor) return unavailableCreditBook();
      return this.creditBookDoor.buildTransactions(normalizedWallet, input);
    }
    if (!this.creditPoolAddress || !this.depositPoolAddress) return unavailable();
    this.#assertReadReady();
    if (direction === "deposit") {
      assertOnlyFields(input, new Set(["direction", "assets"]));
      return this.#buildDeposit(normalizedWallet, exactPositiveRaw(input.assets, "assets"));
    }
    if (direction === "withdraw") {
      assertOnlyFields(input, new Set(["direction", "shares"]));
      return this.#buildWithdraw(normalizedWallet, exactPositiveRaw(input.shares, "shares"));
    }
    if (direction === "borrow") {
      assertOnlyFields(input, new Set(["direction", "pledgeShares", "amount"]));
      return this.#buildBorrow(
        normalizedWallet,
        exactPositiveRaw(input.pledgeShares, "pledgeShares"),
        exactPositiveRaw(input.amount, "amount")
      );
    }
    if (direction === "repay") {
      assertOnlyFields(input, new Set(["direction", "loanId", "amount"]));
      return this.#buildRepay(normalizedWallet, exactLoanId(input.loanId), exactPositiveRaw(input.amount, "amount"));
    }
    throw new ValidationError("direction must be deposit, withdraw, borrow, or repay.", {
      field: "direction",
      requestedValue: input?.direction
    });
  }

  async #buildDeposit(wallet, assets) {
    const snapshot = await this.#snapshot(wallet);
    if (snapshot.wallet.assetBalance < assets) {
      throw refuse("InsufficientBalance", { available: amount(snapshot.wallet.assetBalance), required: amount(assets) });
    }
    if (snapshot.totalAssets + assets > snapshot.totalAssetCap) {
      throw refuse("TotalAssetCapExceeded", { attempted: amount(snapshot.totalAssets + assets), cap: amount(snapshot.totalAssetCap) });
    }
    const expectedShares = BigInt(await this.chainReader.convertCreditToShares({
      creditPoolAddress: this.creditPoolAddress,
      assets,
      blockNumber: snapshot.blockNumber
    }));
    const attemptedLenderAssets = snapshot.totalSupply + expectedShares === 0n
      ? assets
      : (snapshot.wallet.lenderShares + expectedShares) * (snapshot.totalAssets + assets)
        / (snapshot.totalSupply + expectedShares);
    if (attemptedLenderAssets > snapshot.perLenderCap) {
      throw refuse("LenderAssetCapExceeded", { attempted: amount(attemptedLenderAssets), cap: amount(snapshot.perLenderCap) });
    }
    const approveRequired = snapshot.wallet.allowance < assets;
    const templates = [];
    if (approveRequired) templates.push(await this.#template({
      step: "approve",
      from: wallet,
      to: snapshot.asset,
      data: TOKEN_INTERFACE.encodeFunctionData("approve", [this.creditPoolAddress, assets]),
      decoded: { function: "approve(address,uint256)", args: { spender: this.creditPoolAddress, amount: assets.toString() } }
    }));
    templates.push(await this.#template({
      step: "deposit",
      from: wallet,
      to: this.creditPoolAddress,
      data: CREDIT_INTERFACE.encodeFunctionData("deposit", [assets, wallet]),
      decoded: { function: "deposit(uint256,address)", args: { assets: assets.toString(), receiver: wallet } },
      prerequisite: approveRequired ? "approve_confirmed_on_chain" : undefined
    }));
    return this.#built(snapshot, wallet, "deposit", templates, {
      assets: amount(assets),
      expectedShares: amount(expectedShares, SHARE_DECIMALS),
      approvalRequired: approveRequired
    });
  }

  async #buildWithdraw(wallet, shares) {
    const snapshot = await this.#snapshot(wallet);
    if (shares > snapshot.wallet.lenderAvailableShares) {
      throw refuse("InsufficientUnlockedShares", {
        available: amount(snapshot.wallet.lenderAvailableShares, SHARE_DECIMALS),
        required: amount(shares, SHARE_DECIMALS)
      });
    }
    const assets = BigInt(await this.chainReader.convertCreditToAssets({
      creditPoolAddress: this.creditPoolAddress,
      shares,
      blockNumber: snapshot.blockNumber
    }));
    if (assets > snapshot.bufferAssets) {
      throw refuse("InsufficientBuffer", { available: amount(snapshot.bufferAssets), required: amount(assets) });
    }
    const template = await this.#template({
      step: "redeem",
      from: wallet,
      to: this.creditPoolAddress,
      data: CREDIT_INTERFACE.encodeFunctionData("redeem", [shares, wallet, wallet]),
      decoded: { function: "redeem(uint256,address,address)", args: { shares: shares.toString(), receiver: wallet, owner: wallet } }
    });
    return this.#built(snapshot, wallet, "withdraw", [template], {
      shares: amount(shares, SHARE_DECIMALS),
      expectedAssets: amount(assets)
    });
  }

  async #buildBorrow(wallet, pledgeShares, requestedAmount) {
    if (typeof this.vestingAttestor !== "function") {
      throw refuse("VestingAttestorUnavailable", {
        response: "Retry when the short-lived eligibility attestor is available; do not pledge first."
      });
    }
    const [snapshot, capacity] = await Promise.all([this.#snapshot(wallet), this.#capacity(wallet)]);
    if (!capacity.vestingAvailable) {
      throw refuse("VestingReadUnavailable", { response: "Retry when the fail-closed D0 vesting read is available." });
    }
    if (pledgeShares > snapshot.wallet.depositAvailableShares) {
      throw refuse("InsufficientUnlockedShares", {
        available: amount(snapshot.wallet.depositAvailableShares, SHARE_DECIMALS),
        required: amount(pledgeShares, SHARE_DECIMALS)
      });
    }
    const pledgeValue = BigInt(await this.chainReader.convertDepositToAssets({
      depositPoolAddress: this.depositPoolAddress,
      shares: pledgeShares,
      blockNumber: snapshot.blockNumber
    }));
    const vested = BigInt(capacity.vestedAssetsRaw);
    const aggregatePledgedValue = snapshot.wallet.pledgedAssetValue + pledgeValue;
    const base = aggregatePledgedValue < vested ? aggregatePledgedValue : vested;
    const grossMaximum = base * snapshot.ltvBps / BPS;
    const maximum = grossMaximum > snapshot.wallet.outstandingDebt
      ? grossMaximum - snapshot.wallet.outstandingDebt
      : 0n;
    if (requestedAmount > maximum) {
      throw refuse("LoanLimitExceeded", { requested: amount(requestedAmount), maximum: amount(maximum) });
    }
    if (requestedAmount > snapshot.bufferAssets) {
      throw refuse("InsufficientBuffer", { available: amount(snapshot.bufferAssets), required: amount(requestedAmount) });
    }
    const loanId = String(await this.chainReader.previewLoanId({
      creditPoolAddress: this.creditPoolAddress,
      wallet,
      blockNumber: snapshot.blockNumber
    })).toLowerCase();
    const validUntil = Math.floor(this.now() / 1_000) + ATTESTATION_TTL_SECONDS;
    const signature = await this.vestingAttestor({
      borrower: wallet,
      loanId,
      pledgeShares,
      amount: requestedAmount,
      vestedRaw: vested,
      validUntil,
      nonce: snapshot.wallet.attestationNonce
    });
    const templates = [
      await this.#template({
        step: "pledge",
        from: wallet,
        to: this.depositPoolAddress,
        data: DEPOSIT_INTERFACE.encodeFunctionData("pledge", [pledgeShares, loanId]),
        decoded: { function: "pledge(uint256,bytes32)", args: { shares: pledgeShares.toString(), loanId } }
      }),
      await this.#template({
        step: "originate",
        from: wallet,
        to: this.creditPoolAddress,
        data: CREDIT_INTERFACE.encodeFunctionData("originate", [pledgeShares, requestedAmount, vested, validUntil, signature]),
        decoded: {
          function: "originate(uint256,uint256,uint256,uint64,bytes)",
          args: {
            pledgeShares: pledgeShares.toString(),
            amount: requestedAmount.toString(),
            vestedRaw: vested.toString(),
            validUntil,
            vestingAttestationNonce: snapshot.wallet.attestationNonce.toString(),
            loanId
          }
        },
        prerequisite: "pledge_confirmed_on_chain"
      })
    ];
    return this.#built(snapshot, wallet, "borrow", templates, {
      loanId,
      pledgeShares: amount(pledgeShares, SHARE_DECIMALS),
      pledgedAssetValue: amount(pledgeValue),
      aggregatePledgedAssetValue: amount(aggregatePledgedValue),
      vestedAssets: amount(vested),
      existingDebt: amount(snapshot.wallet.outstandingDebt),
      grossWalletLimit: amount(grossMaximum),
      maximumLoan: amount(maximum),
      requestedAmount: amount(requestedAmount),
      interestBps: Number(snapshot.interestBps),
      repaymentAmountAtPilotRate: amount(requestedAmount),
      attestationExpiresAt: new Date(validUntil * 1_000).toISOString()
    });
  }

  async #buildRepay(wallet, loanId, assets) {
    const snapshot = await this.#snapshot(wallet);
    const loan = await this.chainReader.readLoan({
      creditPoolAddress: this.creditPoolAddress,
      loanId,
      blockNumber: snapshot.blockNumber
    });
    if (Number(loan.status) !== 1 || getAddress(loan.borrower) !== wallet) {
      throw refuse("LoanNotActive", { loanId });
    }
    const loanOutstanding = BigInt(loan.outstandingPrincipal) + BigInt(loan.outstandingInterest);
    if (assets > loanOutstanding) {
      throw refuse("RepaymentExceedsOutstanding", {
        attempted: amount(assets),
        outstanding: amount(loanOutstanding)
      });
    }
    if (snapshot.wallet.assetBalance < assets) {
      throw refuse("InsufficientBalance", { available: amount(snapshot.wallet.assetBalance), required: amount(assets) });
    }
    const approveRequired = snapshot.wallet.allowance < assets;
    const templates = [];
    if (approveRequired) templates.push(await this.#template({
      step: "approve",
      from: wallet,
      to: snapshot.asset,
      data: TOKEN_INTERFACE.encodeFunctionData("approve", [this.creditPoolAddress, assets]),
      decoded: { function: "approve(address,uint256)", args: { spender: this.creditPoolAddress, amount: assets.toString() } }
    }));
    templates.push(await this.#template({
      step: "repay",
      from: wallet,
      to: this.creditPoolAddress,
      data: CREDIT_INTERFACE.encodeFunctionData("repay", [loanId, assets]),
      decoded: { function: "repay(bytes32,uint256)", args: { loanId, amount: assets.toString() } },
      prerequisite: approveRequired ? "approve_confirmed_on_chain" : undefined
    }));
    return this.#built(snapshot, wallet, "repay", templates, {
      loanId,
      repayment: amount(assets),
      outstandingBefore: amount(loanOutstanding),
      outstandingAfter: amount(loanOutstanding - assets),
      pledgeReleased: assets === loanOutstanding
    });
  }

  async #template({ step, from, to, data, decoded, prerequisite }) {
    let gasEstimate;
    if (prerequisite) {
      gasEstimate = { status: "requires_prerequisite", gas: null, prerequisite };
    } else {
      try {
        gasEstimate = {
          status: "estimated",
          gas: BigInt(await this.chainReader.estimateGas({ from, to, data, value: 0n })).toString(),
          source: "eth_estimateGas at quote time"
        };
      } catch (error) {
        throw refuse("GasEstimateUnavailable", { step, message: error?.message ?? String(error) });
      }
    }
    return { step, unsigned: true, from, to: getAddress(to), data, value: "0", chainId: this.chainId, gasEstimate, decoded };
  }

  #built(snapshot, wallet, direction, templates, preview) {
    return {
      schemaVersion: 1,
      available: true,
      direction,
      wallet,
      creditPool: this.creditPoolAddress,
      depositPool: this.depositPoolAddress,
      asset: snapshot.asset,
      chainId: this.chainId,
      block: blockProof(snapshot),
      preview,
      templates,
      disclosure: { statement: CREDIT_POOL_RISK_DISCLOSURE },
      repayment: { note: CREDIT_POOL_REPAYMENT_NOTE },
      boundary: BOUNDARY,
      broadcast: broadcast(this.rpcUrls)
    };
  }

  #response(snapshot, wallet, capacity) {
    const pledgeBase = snapshot.wallet.pledgedAssetValue < BigInt(capacity.vestedAssetsRaw)
      ? snapshot.wallet.pledgedAssetValue
      : BigInt(capacity.vestedAssetsRaw);
    const grossWalletLimit = pledgeBase * snapshot.ltvBps / BPS;
    const loanable = grossWalletLimit > snapshot.wallet.outstandingDebt
      ? grossWalletLimit - snapshot.wallet.outstandingDebt
      : 0n;
    return {
      schemaVersion: 1,
      available: true,
      creditPool: this.creditPoolAddress,
      depositPool: this.depositPoolAddress,
      asset: snapshot.asset,
      chainId: this.chainId,
      block: blockProof(snapshot),
      units: {
        asset: { symbol: "USDC", decimals: ASSET_DECIMALS, input: "exact raw integer string" },
        shares: { symbol: "pool share", decimals: SHARE_DECIMALS, input: "exact raw integer string" }
      },
      supply: {
        totalAssets: amount(snapshot.totalAssets),
        totalShares: amount(snapshot.totalSupply, SHARE_DECIMALS),
        buffer: amount(snapshot.bufferAssets),
        principalOutstanding: amount(snapshot.principalOutstanding),
        cap: amount(snapshot.totalAssetCap),
        headroom: amount(snapshot.totalAssetCap > snapshot.totalAssets ? snapshot.totalAssetCap - snapshot.totalAssets : 0n),
        perLenderCap: amount(snapshot.perLenderCap)
      },
      schedule: {
        ltvBps: Number(snapshot.ltvBps),
        maxLtvBps: Number(snapshot.maxLtvBps),
        interestBps: Number(snapshot.interestBps),
        maxInterestBps: Number(snapshot.maxInterestBps),
        platformFeeBps: Number(snapshot.platformFeeBps),
        impairmentTrigger: { numerator: 105, denominator: 100 }
      },
      lifecycle: {
        totalPledgedShares: amount(snapshot.totalPledgedShares, SHARE_DECIMALS),
        defaults: Number(snapshot.defaults)
      },
      wallet: {
        address: wallet,
        assetBalance: amount(snapshot.wallet.assetBalance),
        allowanceToCreditPool: amount(snapshot.wallet.allowance),
        lenderAssets: amount(snapshot.wallet.lenderAssets),
        lenderShares: amount(snapshot.wallet.lenderShares, SHARE_DECIMALS),
        availableLenderShares: amount(snapshot.wallet.lenderAvailableShares, SHARE_DECIMALS),
        depositPoolShares: amount(snapshot.wallet.depositShares, SHARE_DECIMALS),
        availableDepositPoolShares: amount(snapshot.wallet.depositAvailableShares, SHARE_DECIMALS),
        pledgedShares: amount(snapshot.wallet.pledgedShares, SHARE_DECIMALS),
        pledgedAssetValue: amount(snapshot.wallet.pledgedAssetValue),
        vestedAssets: amount(capacity.vestedAssetsRaw),
        vestingAvailable: capacity.vestingAvailable,
        grossWalletLimit: amount(grossWalletLimit),
        loanable: amount(loanable),
        outstanding: amount(snapshot.wallet.outstandingDebt)
      },
      disclosure: { statement: CREDIT_POOL_RISK_DISCLOSURE },
      repayment: { note: CREDIT_POOL_REPAYMENT_NOTE },
      boundary: BOUNDARY,
      broadcast: broadcast(this.rpcUrls)
    };
  }

  async #snapshot(wallet) {
    return normalizeSnapshot(await this.chainReader.readSnapshot({
      creditPoolAddress: this.creditPoolAddress,
      depositPoolAddress: this.depositPoolAddress,
      wallet
    }));
  }

  async #capacity(wallet) {
    const value = await this.capacityReader(wallet);
    return {
      vestedAssetsRaw: BigInt(value?.vestedAssetsRaw ?? 0).toString(),
      vestingAvailable: Boolean(value?.vestingAvailable),
      vestingHours: Number(value?.vestingHours ?? 0),
      tranches: value?.tranches ?? []
    };
  }

  #assertReadReady() {
    if (!this.chainReader || typeof this.capacityReader !== "function") {
      throw new Error("CreditPool door is configured without its chain reader or D0 capacity reader.");
    }
    if (!Number.isSafeInteger(this.chainId) || this.chainId <= 0) throw new Error("CreditPool door requires a positive chainId.");
  }
}

function normalizeSnapshot(input) {
  const output = { ...input, blockNumber: Number(input.blockNumber), asset: getAddress(input.asset) };
  for (const key of [
    "totalAssets", "totalSupply", "bufferAssets", "principalOutstanding", "totalPledgedShares",
    "defaults", "ltvBps", "interestBps", "totalAssetCap", "perLenderCap", "maxLtvBps",
    "maxInterestBps", "platformFeeBps"
  ]) output[key] = BigInt(input[key]);
  output.wallet = Object.fromEntries(Object.entries(input.wallet).map(([key, value]) => [key, BigInt(value)]));
  if (input.disclosure !== CREDIT_POOL_RISK_DISCLOSURE) {
    throw new Error("CreditPool on-chain disclosure does not match the canonical door disclosure.");
  }
  return output;
}

function blockProof(snapshot) {
  return {
    number: snapshot.blockNumber,
    hash: snapshot.blockHash ?? null,
    ...(snapshot.blockTimestamp === null || snapshot.blockTimestamp === undefined
      ? {}
      : { timestamp: snapshot.blockTimestamp, timestampIso: new Date(snapshot.blockTimestamp * 1_000).toISOString() })
  };
}

function broadcast(rpcUrls) {
  return {
    rpcUrls,
    method: "eth_sendRawTransaction",
    signer: "your own wallet",
    feeAsset: "DOT",
    note: "Sign locally and submit through your own RPC. Averray has no signed-transaction relay."
  };
}

function unavailable() {
  return { schemaVersion: 1, available: false, reason: "credit_pool_not_configured" };
}

function unavailableCreditBook() {
  return { schemaVersion: 1, available: false, reason: "credit_book_not_configured" };
}
