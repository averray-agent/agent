import { Contract, Interface, getAddress, id } from "ethers";

import { ConfigError, ExternalServiceError } from "../core/errors.js";

export const AAC_IDLE_DEPOSIT_POOL_V21 =
  "0x4141435f49444c455f4445504f5349545f504f4f4c5f56323100000000000000";
export const DEPLOYED_DEPOSIT_POOL_V21 = "0x9B35A102d656Fb86d798aF81959e09961DEc28E0";
export const DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER = "0x1DDcA7097c752580c6561e1bF8C673D6C1665CA5";

export const ALLOCATION_KEEPER_WRITE_FUNCTIONS = Object.freeze([
  "allocateIdleFunds",
  "deallocateIdleFunds",
  "sweepToPool",
  "requestFloatExit",
  "fulfilFloatExit"
]);

export const ALLOCATION_KEEPER_AGENT_WRITE_ABI = Object.freeze([
  "function allocateIdleFunds(address account, bytes32 strategyId, uint256 amount)",
  "function deallocateIdleFunds(address account, bytes32 strategyId, uint256 amount)",
  "event StrategyAllocated(address indexed account, bytes32 indexed strategyId, address indexed asset, uint256 amount)",
  "event StrategyDeallocated(address indexed account, bytes32 indexed strategyId, address indexed asset, uint256 amount)"
]);

export const ALLOCATION_KEEPER_ADAPTER_WRITE_ABI = Object.freeze([
  "function sweepToPool(uint256 assets) returns (uint256 poolShares)",
  "function requestFloatExit(uint256 poolShares, uint8 tier) returns (uint256 requestId)",
  "function fulfilFloatExit(uint256 requestId) returns (uint256 assetsReturned)",
  "event SweptToPool(uint256 assets, uint256 poolShares)",
  "event FloatExitRequested(uint256 indexed requestId, uint256 poolShares, uint8 tier)",
  "event FloatExitFulfilled(uint256 indexed requestId, uint256 assets)"
]);

const AGENT_READ_ABI = Object.freeze([
  "function positions(address account, address asset) view returns (uint256 liquid, uint256 reserved, uint256 strategyAllocated, uint256 collateralLocked, uint256 jobStakeLocked, uint256 debtOutstanding)",
  "function strategyShares(address account, bytes32 strategyId) view returns (uint256)"
]);
const ADAPTER_READ_ABI = Object.freeze([
  "function floatAssets() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function maxWithdraw(address account) view returns (uint256)"
]);
const POOL_READ_ABI = Object.freeze([
  "function balanceOf(address account) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function redeemRequests(uint256 requestId) view returns (address owner, address receiver, uint256 shares, uint64 unlockAt, uint8 tier, bool fulfilled)"
]);
const ADAPTER_MOVEMENT_EVENT_INTERFACE = new Interface([
  "event Deposited(uint256 assets, uint256 shares)",
  "event Withdrawn(uint256 shares, uint256 assets)"
]);
const TRANSFER_FAILED_SELECTOR = id("TransferFailed()").slice(0, 10).toLowerCase();

/**
 * The keeper's closed chain boundary. Its only state-changing ABI fragments
 * are the five ratified functions above, and both AgentAccount movements bind
 * the one deployed strategy id internally rather than accepting one from a
 * caller.
 */
export class EvmIdleBalanceAllocationChain {
  constructor({
    provider,
    signer,
    agentAccountAddress,
    assetAddress,
    poolAddress = DEPLOYED_DEPOSIT_POOL_V21,
    adapterAddress = DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER
  } = {}) {
    if (!provider || !signer) {
      throw new ConfigError("A live allocation keeper requires both an EVM provider and signer.");
    }
    this.agentAccountAddress = requiredAddress(agentAccountAddress, "AgentAccountCore");
    this.assetAddress = requiredAddress(assetAddress, "USDC");
    this.poolAddress = requireDeployedAddress(poolAddress, DEPLOYED_DEPOSIT_POOL_V21, "DepositPool v2.1");
    this.adapterAddress = requireDeployedAddress(
      adapterAddress,
      DEPLOYED_AAC_POOL_AGGREGATOR_ADAPTER,
      "AAC pool aggregator adapter"
    );
    this.accountReader = new Contract(this.agentAccountAddress, AGENT_READ_ABI, provider);
    this.adapterReader = new Contract(this.adapterAddress, ADAPTER_READ_ABI, provider);
    this.poolReader = new Contract(this.poolAddress, POOL_READ_ABI, provider);
    this.accountWriter = new Contract(this.agentAccountAddress, ALLOCATION_KEEPER_AGENT_WRITE_ABI, signer);
    this.adapterWriter = new Contract(this.adapterAddress, ALLOCATION_KEEPER_ADAPTER_WRITE_ABI, signer);
  }

  async getAccountPosition(wallet) {
    const position = await this.accountReader.positions(getAddress(wallet), this.assetAddress);
    return {
      liquidRaw: BigInt(position.liquid).toString(),
      reservedRaw: BigInt(position.reserved).toString(),
      strategyAllocatedRaw: BigInt(position.strategyAllocated).toString(),
      collateralLockedRaw: BigInt(position.collateralLocked).toString(),
      jobStakeLockedRaw: BigInt(position.jobStakeLocked).toString(),
      debtOutstandingRaw: BigInt(position.debtOutstanding).toString()
    };
  }

  async getStrategyShares(wallet) {
    return BigInt(await this.accountReader.strategyShares(getAddress(wallet), AAC_IDLE_DEPOSIT_POOL_V21)).toString();
  }

  async getFloatState() {
    const [floatAssets, totalAssets, totalShares, maxWithdraw, poolShares] = await Promise.all([
      this.adapterReader.floatAssets(),
      this.adapterReader.totalAssets(),
      this.adapterReader.totalShares(),
      this.adapterReader.maxWithdraw(this.agentAccountAddress),
      this.poolReader.balanceOf(this.adapterAddress)
    ]);
    const poolAssets = await this.poolReader.convertToAssets(poolShares);
    return {
      adapter: this.adapterAddress,
      receiver: this.adapterAddress,
      floatRaw: BigInt(floatAssets).toString(),
      maxWithdrawRaw: BigInt(maxWithdraw).toString(),
      totalAssetsRaw: BigInt(totalAssets).toString(),
      totalSharesRaw: BigInt(totalShares).toString(),
      poolSharesRaw: BigInt(poolShares).toString(),
      poolAssetsRaw: BigInt(poolAssets).toString()
    };
  }

  async sharesForPoolAssets(assetsRaw) {
    const assets = exactPositiveUint(assetsRaw, "pool exit assets");
    const floorShares = BigInt(await this.poolReader.convertToShares(assets));
    if (floorShares === 0n) return "0";
    const floorAssets = BigInt(await this.poolReader.convertToAssets(floorShares));
    return (floorAssets < assets ? floorShares + 1n : floorShares).toString();
  }

  async getFloatExit(requestId) {
    const request = await this.poolReader.redeemRequests(exactPositiveUint(requestId, "float exit requestId"));
    return {
      requestId: String(requestId),
      owner: getAddress(request.owner),
      receiver: getAddress(request.receiver),
      sharesRaw: BigInt(request.shares).toString(),
      unlockAt: Number(request.unlockAt),
      tier: Number(request.tier),
      fulfilled: Boolean(request.fulfilled)
    };
  }

  async allocateIdleFunds(wallet, amountRaw) {
    return this.#send(
      "allocateIdleFunds",
      this.accountWriter.allocateIdleFunds(
        getAddress(wallet),
        AAC_IDLE_DEPOSIT_POOL_V21,
        exactPositiveUint(amountRaw, "allocation amount")
      ),
      this.accountWriter.interface,
      "StrategyAllocated"
    );
  }

  async deallocateIdleFunds(wallet, amountRaw) {
    return this.#send(
      "deallocateIdleFunds",
      this.accountWriter.deallocateIdleFunds(
        getAddress(wallet),
        AAC_IDLE_DEPOSIT_POOL_V21,
        exactPositiveUint(amountRaw, "deallocation amount")
      ),
      this.accountWriter.interface,
      "StrategyDeallocated"
    );
  }

  async sweepToPool(amountRaw) {
    return this.#send(
      "sweepToPool",
      this.adapterWriter.sweepToPool(exactPositiveUint(amountRaw, "float sweep amount")),
      this.adapterWriter.interface,
      "SweptToPool"
    );
  }

  async requestFloatExit({ poolSharesRaw, receiver } = {}) {
    if (getAddress(receiver) !== this.adapterAddress) {
      throw new ConfigError("Float exit receiver is permanently pinned to the deployed adapter.");
    }
    return this.#send(
      "requestFloatExit",
      this.adapterWriter.requestFloatExit(exactPositiveUint(poolSharesRaw, "float exit shares"), 0),
      this.adapterWriter.interface,
      "FloatExitRequested"
    );
  }

  async fulfilFloatExit(requestId) {
    return this.#send(
      "fulfilFloatExit",
      this.adapterWriter.fulfilFloatExit(exactPositiveUint(requestId, "float exit requestId")),
      this.adapterWriter.interface,
      "FloatExitFulfilled"
    );
  }

  async #send(operation, transactionPromise, eventInterface, eventName) {
    try {
      const transaction = await transactionPromise;
      const receipt = await transaction.wait();
      const event = findEvent(receipt, eventInterface, eventName);
      const strategyShareDelta = operation === "allocateIdleFunds"
        ? movementShareDelta(receipt, "Deposited", 1n)
        : operation === "deallocateIdleFunds"
          ? movementShareDelta(receipt, "Withdrawn", -1n)
          : undefined;
      return {
        txHash: String(transaction.hash ?? receipt?.hash ?? "").toLowerCase(),
        blockNumber: Number(receipt?.blockNumber),
        ...(event ? eventArgs(event) : {}),
        ...(strategyShareDelta !== undefined
          ? { strategySharesDeltaRaw: strategyShareDelta.toString() }
          : {})
      };
    } catch (error) {
      throw classifyAllocationKeeperMovementError(error, operation);
    }
  }
}

export function allocationKeeperWriteFunctionNames() {
  const fragments = [
    ...new Interface(ALLOCATION_KEEPER_AGENT_WRITE_ABI).fragments,
    ...new Interface(ALLOCATION_KEEPER_ADAPTER_WRITE_ABI).fragments
  ];
  return fragments
    .filter((fragment) => fragment.type === "function" && fragment.stateMutability !== "view" && fragment.stateMutability !== "pure")
    .map((fragment) => fragment.name)
    .sort();
}

export function classifyAllocationKeeperMovementError(error, operation) {
  const data = findRevertData(error);
  if (
    (operation === "allocateIdleFunds" || operation === "sweepToPool")
    && data?.toLowerCase().startsWith(TRANSFER_FAILED_SELECTOR)
  ) {
    return new ExternalServiceError(
      `${operation} USDC approval failed; verify the calling contract has DOT postage.`,
      "allocation_keeper_postage_approval_failed",
      { operation }
    );
  }
  return new ExternalServiceError(
    `${operation} failed at the closed allocation-keeper chain boundary.`,
    "allocation_keeper_chain_write_failed",
    { operation, cause: error?.shortMessage ?? error?.message ?? String(error) }
  );
}

function movementShareDelta(receipt, eventName, sign) {
  const event = findEvent(receipt, ADAPTER_MOVEMENT_EVENT_INTERFACE, eventName);
  if (!event) {
    throw new Error(`${eventName} share evidence was absent from the confirmed movement receipt.`);
  }
  return BigInt(event.args.shares) * sign;
}

function findRevertData(error) {
  const candidates = [
    error?.data,
    error?.error?.data,
    error?.info?.error?.data,
    error?.receipt?.revertReason
  ];
  return candidates.find((value) => typeof value === "string" && /^0x[0-9a-f]+$/iu.test(value));
}

function findEvent(receipt, eventInterface, eventName) {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = eventInterface.parseLog(log);
      if (parsed?.name === eventName) return parsed;
    } catch {
      // A receipt can contain token, pool, and adapter logs. Only the pinned
      // movement event belongs to this evidence record.
    }
  }
  return undefined;
}

function eventArgs(event) {
  const result = {};
  for (const input of event.fragment.inputs) {
    const value = event.args[input.name];
    if (typeof value === "bigint") result[`${input.name}Raw`] = value.toString();
    else if (value !== undefined) result[input.name] = value;
  }
  return result;
}

function requiredAddress(value, label) {
  try {
    return getAddress(String(value ?? ""));
  } catch {
    throw new ConfigError(`A live allocation keeper requires a valid ${label} address.`);
  }
}

function requireDeployedAddress(value, expected, label) {
  const address = requiredAddress(value, label);
  if (address !== getAddress(expected)) {
    throw new ConfigError(`${label} must be the deployed ${getAddress(expected)}.`);
  }
  return address;
}

function exactPositiveUint(value, label) {
  const raw = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^\d+$/u.test(raw) || BigInt(raw) <= 0n) {
    throw new ConfigError(`${label} must be an exact positive integer in base units.`);
  }
  return BigInt(raw);
}
