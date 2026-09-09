import { Contract, Interface, id } from "ethers";
import { BlockchainGateway } from "../../blockchain/gateway.js";
import {
  CREDIT_BOOK_ABI, CREDIT_POOL_ABI, DEPOSIT_POOL_V2_ABI, ERC20_MOCK_ABI,
  ESCROW_CORE_ABI, ESCROW_CORE_V1_DRAIN_ABI, ZERO_BYTES32
} from "../../blockchain/abis.js";
import { createWorkerExposurePolicy } from "../../core/worker-exposure.js";
import { CREDIT_POOL_RISK_DISCLOSURE } from "../../core/credit-pool-disclosure.js";
import { createCreditPoolDoor, createReceiptGraphUnderwriter } from "../bootstrap.js";
import { CreditBookDoorService } from "../credit-book-door.js";
import { createCreditPoolRoutes } from "../../protocols/http/credit-pool-routes.js";

export const addresses = Object.fromEntries(
  ["credit", "deposit", "asset", "wallet", "book", "account", "escrow", "legacy"]
    .map((key, i) => [key, `0x${String(i + 1).repeat(40)}`])
);
export const NOW = 1_800_000_000;
export const HEAD = 500_000;
export const WINDOW = 30 * 86400;
export const UNDERWRITER_TOPICS = [
  "SettlementSplit(bytes32,address,address,address,uint256,uint256,uint16)",
  "DisputeResolved(bytes32,address,uint256,bytes32,string)",
  "JobStakeSlashed(address,address,uint256,uint256,uint256)",
  "ClaimFeeSlashed(address,address,uint256,address,uint256,uint256)"
].map(id);

export function checkpointData(timestamp = NOW) {
  return {
    _meta: { status: { polkadotHubMainnet: { id: 420420419, block: { number: HEAD, timestamp } } } },
    receiptGraphCoverages: {
      items: [
        ...[addresses.escrow, addresses.legacy].map((address) => ({
          contract: "EscrowCore", address, fromBlock: "1", fromTimestamp: String(NOW - WINDOW - 100)
        })),
        { contract: "AgentAccountCore", address: addresses.account, fromBlock: "1", fromTimestamp: String(NOW - WINDOW - 100) }
      ],
      pageInfo: { hasNextPage: false }
    }
  };
}

export function indexerFetch({ checkpoint = checkpointData(), rows = {}, calls = [] } = {}) {
  return async (url, input) => {
    const { query, variables } = JSON.parse(input.body);
    calls.push({ url: String(url), query, variables });
    if (query.includes("CreditEvidenceCheckpoint")) return Response.json({ data: checkpoint });
    const table = ["settlementSplits", "jobEvents", "jobStakeEvents"].find((name) => query.includes(`page: ${name}(`));
    return Response.json({ data: { page: { items: rows[table] ?? [], pageInfo: { hasNextPage: false } } } });
  };
}

export function countingProvider({ delayMs = 0 } = {}) {
  const interfaces = {
    [addresses.credit]: new Interface(CREDIT_POOL_ABI),
    [addresses.deposit]: new Interface(DEPOSIT_POOL_V2_ABI),
    [addresses.book]: new Interface(CREDIT_BOOK_ABI),
    [addresses.asset]: new Interface(ERC20_MOCK_ABI),
    [addresses.escrow]: new Interface(ESCROW_CORE_ABI),
    [addresses.legacy]: new Interface(ESCROW_CORE_V1_DRAIN_ABI)
  };
  const calls = [];
  const encoded = new Map();
  const wait = async (call) => {
    calls.push({ ...call, at: performance.now() });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  };
  const defaults = (type) => type.baseType === "array" ? []
    : type.baseType === "tuple" ? type.components.map(defaults)
      : type.type === "address" ? addresses.wallet
        : type.type === "bool" ? false : type.type === "string" ? "fixture"
          : type.type.startsWith("bytes") ? ZERO_BYTES32 : 0n;
  return {
    head: HEAD, calls,
    async getBlockNumber() { await wait({ method: "getBlockNumber" }); return this.head; },
    async getBlock(tag) {
      await wait({ method: "getBlock", tag });
      const number = tag === "latest" ? this.head : Number(tag);
      return { number, hash: `0x${"ab".repeat(32)}`, timestamp: NOW - (HEAD - number) * 6 };
    },
    async getLogs(filter) { await wait({ method: "getLogs", filter }); return []; },
    async call(tx) {
      const key = tx.to.toLowerCase() + tx.data.slice(0, 10);
      const cached = encoded.get(key);
      if (cached) {
        await wait({ method: "call", to: tx.to.toLowerCase(), name: cached.name, blockTag: tx.blockTag });
        return cached.response;
      }
      const abi = interfaces[tx.to.toLowerCase()];
      const parsed = abi.parseTransaction({ data: tx.data });
      await wait({ method: "call", to: tx.to.toLowerCase(), name: parsed.name, blockTag: tx.blockTag });
      const values = {
        RISK_DISCLOSURE: CREDIT_POOL_RISK_DISCLOSURE,
        asset: addresses.asset, accounts: addresses.account, depositPool: addresses.deposit,
        operator: addresses.wallet, ltvBps: 8000n, totalAssets: 20_000_000n,
        bufferAssets: 20_000_000n, cashPerWalletCapRaw: 25_000_000n,
        postingPerWalletCapRaw: 25_000_000n, bookCapRaw: 100_000_000n
      };
      if (parsed.name === "jobs") {
        const args = parsed.fragment.outputs.map(defaults);
        const tuple = parsed.fragment.outputs[0].components;
        if (tuple) {
          args[0][tuple.findIndex((field) => field.name === "worker")] = addresses.wallet;
        }
        return abi.encodeFunctionResult(parsed.fragment, args);
      }
      const response = abi.encodeFunctionResult(parsed.fragment, parsed.fragment.outputs.map((type, index) =>
        index === 0 && Object.hasOwn(values, parsed.name) ? values[parsed.name] : defaults(type)));
      encoded.set(key, { name: parsed.name, response });
      return response;
    }
  };
}

export function creditReadFixture({ provider = countingProvider(), fetchImpl = indexerFetch(), env = {} } = {}) {
  const gateway = new BlockchainGateway({
    enabled: false, chainId: 420420419,
    creditPoolAddress: addresses.credit, creditPoolDeploymentBlock: 1,
    depositPoolV2Address: addresses.deposit, depositPoolV2DeploymentBlock: 1,
    legacyDepositPoolV2Address: addresses.deposit,
    agentAccountAddress: addresses.account,
    escrowCoreAddress: addresses.escrow, legacyEscrowCoreAddress: addresses.legacy,
    supportedAssets: [{ symbol: "USDC", address: addresses.asset, decimals: 6 }]
  }, { now: () => NOW * 1000 });
  gateway.provider = provider;
  gateway.depositPoolV2Contract = new Contract(addresses.deposit, DEPOSIT_POOL_V2_ABI, provider);
  gateway.creditPoolContract = new Contract(addresses.credit, CREDIT_POOL_ABI, provider);
  const authConfig = { chainId: 420420419 };
  const underwriter = createReceiptGraphUnderwriter({
    gateway, authConfig, now: () => new Date(NOW * 1000), fetchImpl,
    env: { INDEXER_STATUS_URL: "http://indexer:42069/status", ...env }
  });
  const creditBookDoor = new CreditBookDoorService({
    creditBookAddress: addresses.book, agentAccountAddress: addresses.account,
    chainId: authConfig.chainId, provider, underwriter, stateStore: {}
  });
  const door = createCreditPoolDoor({
    gateway, authConfig, creditBookDoor,
    workerExposurePolicy: createWorkerExposurePolicy({
      blockchainGateway: gateway, env: {}, gasEstimateUsdc: 0,
      stateStore: { listSessionsByWallet: async () => [] }
    })
  });
  const route = createCreditPoolRoutes({
    creditPoolDoor: door, authMiddleware: async () => ({ wallet: addresses.wallet }),
    respond: (response, status, body) => Object.assign(response, { status, body })
  });
  return { provider, gateway, door, creditBookDoor, underwriter,
    async request() {
      const response = {};
      await route({ request: { method: "GET" }, response,
        pathname: "/credit", url: new URL("https://example.test/credit") });
      return response;
    }
  };
}
