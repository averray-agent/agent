import { createConfig } from "ponder";

import {
  AgentAccountCoreAbi,
  CreditPoolAbi,
  DiscoveryRegistryAbi,
  EscrowCoreAbi,
  ReputationSbtAbi,
  TreasuryPolicyAbi,
  XcmWrapperAbi
} from "./abis/contractsAbi";
import { createIndexerRpcTransport, resolveIndexerRpcUrls } from "./src/rpc-transport";

type Address = `0x${string}`;

// Chain identity is env-driven so the same image indexes either the Polkadot
// Hub TestNet or mainnet by config change alone. Defaults target TestNet so
// local dev and existing Render deployments keep working without extra env,
// but required addresses never have a silent fallback — a missing env aborts
// boot instead of indexing a stale deployment.
const chainId = parsePositiveInt(process.env.POLKADOT_CHAIN_ID, 420420417);
const chainName = process.env.POLKADOT_CHAIN_NAME ?? "polkadotHubTestnet";

const lowMemoryMode = process.env.PONDER_LOW_MEMORY === "true";
const includeTreasury = process.env.PONDER_ENABLE_TREASURY !== "false";

const rpcUrls = resolveIndexerRpcUrls(chainId);
const treasuryPolicyAddress = requireAddress(
  process.env.PONDER_TREASURY_POLICY_ADDRESS ?? process.env.TREASURY_POLICY_ADDRESS,
  "TREASURY_POLICY_ADDRESS"
);
const escrowCoreAddress = requireAddress(
  process.env.PONDER_ESCROW_CORE_ADDRESS ?? process.env.ESCROW_CORE_ADDRESS,
  "ESCROW_CORE_ADDRESS"
);
const legacyEscrowCoreAddress = optionalAddress(
  process.env.PONDER_LEGACY_ESCROW_CORE_ADDRESS ?? process.env.LEGACY_ESCROW_CORE_ADDRESS,
  "LEGACY_ESCROW_CORE_ADDRESS"
);
const agentAccountAddress = requireAddress(
  process.env.PONDER_AGENT_ACCOUNT_ADDRESS ?? process.env.AGENT_ACCOUNT_ADDRESS,
  "AGENT_ACCOUNT_ADDRESS"
);
const reputationSbtAddress = requireAddress(
  process.env.PONDER_REPUTATION_SBT_ADDRESS ?? process.env.REPUTATION_SBT_ADDRESS,
  "REPUTATION_SBT_ADDRESS"
);
const discoveryRegistryAddress = optionalAddress(
  process.env.PONDER_DISCOVERY_REGISTRY_ADDRESS ?? process.env.DISCOVERY_REGISTRY_ADDRESS,
  "DISCOVERY_REGISTRY_ADDRESS"
);
const xcmWrapperAddress = optionalAddress(
  process.env.PONDER_XCM_WRAPPER_ADDRESS ?? process.env.XCM_WRAPPER_ADDRESS,
  "XCM_WRAPPER_ADDRESS"
);
const creditPoolAddress = optionalAddress(
  process.env.PONDER_CREDIT_POOL_ADDRESS ?? process.env.CREDIT_POOL_ADDRESS,
  "CREDIT_POOL_ADDRESS"
);

const treasuryStartBlock = parseStartBlock(
  process.env.PONDER_START_BLOCK_TREASURY,
  includeTreasury ? (lowMemoryMode ? "latest" : 0) : "latest"
);
const escrowStartBlock = parseStartBlock(
  process.env.PONDER_START_BLOCK_ESCROW,
  lowMemoryMode ? "latest" : 0
);
const reputationStartBlock = parseStartBlock(
  process.env.PONDER_START_BLOCK_REPUTATION,
  lowMemoryMode ? "latest" : 0
);
const registryStartBlock = parseStartBlock(
  process.env.PONDER_START_BLOCK_REGISTRIES,
  lowMemoryMode ? "latest" : 0
);
const xcmStartBlock = parseStartBlock(
  process.env.PONDER_START_BLOCK_XCM,
  lowMemoryMode ? "latest" : 0
);
const creditPoolStartBlock = parseStartBlock(
  process.env.PONDER_START_BLOCK_CREDIT_POOL,
  lowMemoryMode ? "latest" : 0
);

const contracts = {
  TreasuryPolicy: {
    chain: chainName,
    abi: TreasuryPolicyAbi,
    address: treasuryPolicyAddress,
    startBlock: treasuryStartBlock
  },
  EscrowCore: {
    chain: chainName,
    abi: EscrowCoreAbi,
    address: legacyEscrowCoreAddress
      ? [escrowCoreAddress, legacyEscrowCoreAddress]
      : escrowCoreAddress,
    startBlock: escrowStartBlock
  },
  AgentAccountCore: {
    chain: chainName,
    abi: AgentAccountCoreAbi,
    address: agentAccountAddress,
    startBlock: escrowStartBlock
  },
  ReputationSBT: {
    chain: chainName,
    abi: ReputationSbtAbi,
    address: reputationSbtAddress,
    startBlock: reputationStartBlock
  },
  ...(discoveryRegistryAddress
    ? {
        DiscoveryRegistry: {
          chain: chainName,
          abi: DiscoveryRegistryAbi,
          address: discoveryRegistryAddress,
          startBlock: registryStartBlock
        }
      }
    : {}),
  ...(xcmWrapperAddress
    ? {
        XcmWrapper: {
          chain: chainName,
          abi: XcmWrapperAbi,
          address: xcmWrapperAddress,
          startBlock: xcmStartBlock
        }
      }
    : {}),
  ...(creditPoolAddress
    ? {
        CreditPool: {
          chain: chainName,
          abi: CreditPoolAbi,
          address: creditPoolAddress,
          startBlock: creditPoolStartBlock
        }
      }
    : {})
};

export default createConfig({
  chains: {
    [chainName]: {
      id: chainId,
      rpc: createIndexerRpcTransport(rpcUrls),
      pollingInterval: lowMemoryMode ? 4_000 : 1_000,
      disableCache: lowMemoryMode,
      ethGetLogsBlockRange: lowMemoryMode ? 25 : undefined
    }
  },
  contracts
});

function parseStartBlock(value: string | undefined, fallback: number | "latest") {
  if (!value || value.trim() === "") return fallback;
  if (value === "latest") return "latest" as const;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function requireAddress(raw: string | undefined, name: string): Address {
  const value = raw?.trim();
  if (!value) {
    throw new Error(`Ponder: ${name} is required. Set it to the deployed contract address for the target chain.`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error(`Ponder: ${name}=${value} is not a valid 20-byte EVM address.`);
  }
  return value as Address;
}

function optionalAddress(raw: string | undefined, name: string): Address | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error(`Ponder: ${name}=${value} is not a valid 20-byte EVM address.`);
  }
  return value as Address;
}
