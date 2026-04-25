import { createConfig } from "ponder";

import {
  AgentAccountCoreAbi,
  DiscoveryRegistryAbi,
  DisclosureLogAbi,
  EscrowCoreAbi,
  ReputationSbtAbi,
  TreasuryPolicyAbi,
  VerifierRegistryAbi,
  XcmWrapperAbi
} from "./abis/contractsAbi";

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

const rpcUrl = resolveRpcUrl(chainId);
const treasuryPolicyAddress = requireAddress(
  process.env.PONDER_TREASURY_POLICY_ADDRESS ?? process.env.TREASURY_POLICY_ADDRESS,
  "TREASURY_POLICY_ADDRESS"
);
const escrowCoreAddress = requireAddress(
  process.env.PONDER_ESCROW_CORE_ADDRESS ?? process.env.ESCROW_CORE_ADDRESS,
  "ESCROW_CORE_ADDRESS"
);
const agentAccountAddress = requireAddress(
  process.env.PONDER_AGENT_ACCOUNT_ADDRESS ?? process.env.AGENT_ACCOUNT_ADDRESS,
  "AGENT_ACCOUNT_ADDRESS"
);
const reputationSbtAddress = requireAddress(
  process.env.PONDER_REPUTATION_SBT_ADDRESS ?? process.env.REPUTATION_SBT_ADDRESS,
  "REPUTATION_SBT_ADDRESS"
);
const verifierRegistryAddress = requireAddress(
  process.env.PONDER_VERIFIER_REGISTRY_ADDRESS ?? process.env.VERIFIER_REGISTRY_ADDRESS,
  "VERIFIER_REGISTRY_ADDRESS"
);
const discoveryRegistryAddress = requireAddress(
  process.env.PONDER_DISCOVERY_REGISTRY_ADDRESS ?? process.env.DISCOVERY_REGISTRY_ADDRESS,
  "DISCOVERY_REGISTRY_ADDRESS"
);
const disclosureLogAddress = requireAddress(
  process.env.PONDER_DISCLOSURE_LOG_ADDRESS ?? process.env.DISCLOSURE_LOG_ADDRESS,
  "DISCLOSURE_LOG_ADDRESS"
);
const xcmWrapperAddress = optionalAddress(
  process.env.PONDER_XCM_WRAPPER_ADDRESS ?? process.env.XCM_WRAPPER_ADDRESS
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
    address: escrowCoreAddress,
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
  VerifierRegistry: {
    chain: chainName,
    abi: VerifierRegistryAbi,
    address: verifierRegistryAddress,
    startBlock: registryStartBlock
  },
  DiscoveryRegistry: {
    chain: chainName,
    abi: DiscoveryRegistryAbi,
    address: discoveryRegistryAddress,
    startBlock: registryStartBlock
  },
  DisclosureLog: {
    chain: chainName,
    abi: DisclosureLogAbi,
    address: disclosureLogAddress,
    startBlock: registryStartBlock
  },
  ...(xcmWrapperAddress
    ? {
        XcmWrapper: {
          chain: chainName,
          abi: XcmWrapperAbi,
          address: xcmWrapperAddress,
          startBlock: xcmStartBlock
        }
      }
    : {})
};

export default createConfig({
  chains: {
    [chainName]: {
      id: chainId,
      rpc: rpcUrl,
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

/**
 * Resolve the RPC URL for the configured chain. Precedence:
 *   1. `DWELLER_RPC_URL` — preferred private/provider endpoint
 *   2. `POLKADOT_RPC_URL` — explicit generic override
 *   3. `PONDER_RPC_URL_<chainId>` — Ponder's per-chain convention; retained
 *      for backwards compatibility with the existing TestNet Render deployment
 *   4. TestNet public endpoint — only when chainId is the TestNet id; any
 *      other chain must set an explicit RPC or boot fails.
 */
function resolveRpcUrl(id: number): string {
  const dweller = process.env.DWELLER_RPC_URL?.trim();
  if (dweller) return dweller;
  const direct = process.env.POLKADOT_RPC_URL?.trim();
  if (direct) return direct;
  const perChain = process.env[`PONDER_RPC_URL_${id}`]?.trim();
  if (perChain) return perChain;
  if (id === 420420417) return "https://eth-rpc-testnet.polkadot.io/";
  throw new Error(
    `Ponder: no RPC URL configured for chain id ${id}. Set DWELLER_RPC_URL, POLKADOT_RPC_URL, or PONDER_RPC_URL_${id}.`
  );
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

function optionalAddress(raw: string | undefined): Address | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error(`Ponder: optional address ${value} is not a valid 20-byte EVM address.`);
  }
  return value as Address;
}
